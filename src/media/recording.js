import {
  Input,
  MP4,
  MPEG_TS,
  BufferSource,
  Output,
  StreamTarget,
  Mp4OutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from 'mediabunny';
import {createRecordingDownload} from './recording-download.js';
import {RecordingTimeline, recordingTime} from './recording-timeline.js';
import {RequestError} from '../services/retry-request.js';
import {cleanUp, storageStep} from '../shared/errors.js';

// `keepPartial` saves the playable prefix when a fragment cannot be read, the
// same way a stop does. `missingRetries` waits for fragments that a recording
// still in progress lists before the platform has finished writing them.
export async function saveRecording(
  api,
  groups,
  fileHandle,
  {
    signal,
    stopSignal,
    onProgress = () => {},
    onSegment = () => {},
    concurrency = 6,
    fragmented = false,
    downloadLimit,
    metrics,
    storageTarget = 'destination',
    keepPartial = false,
    missingRetries = 0,
  } = {},
) {
  let failure,
    interruption,
    file,
    input,
    output,
    bytes = 0,
    written = 0,
    processed = 0,
    reconnecting = 0,
    attempt = 0,
    phase = 'downloading';
  const requests = new AbortController();
  const abort = () => requests.abort(signal.reason),
    stop = () => {
      phase = 'stopping';
      requests.abort(stopSignal.reason);
    };
  signal?.addEventListener('abort', abort, {once: true});
  stopSignal?.addEventListener('abort', stop, {once: true});
  if (signal?.aborted) abort();
  else if (stopSignal?.aborted) stop();
  const samples = [{at: performance.now(), bytes: 0}],
    started = samples[0].at;
  function report(complete = false) {
    const now = performance.now();
    while (samples.length > 1 && samples[1].at < now - 5000) samples.shift();
    const speed = (bytes - samples[0].bytes) / Math.max(1, (now - Math.max(started, samples[0].at)) / 1000);
    onProgress({
      bytes,
      written,
      progress: complete ? processed : Math.min(0.99, processed),
      speed,
      reconnecting,
      attempt,
      phase,
    });
  }
  const download = createRecordingDownload(api, groups, {
    signal: requests.signal,
    concurrency,
    limit: downloadLimit,
    metrics,
    missingRetries,
    onRead: size => {
      bytes += size;
      metrics?.add('downloadedBytes', size);
      samples.push({at: performance.now(), bytes});
      report();
    },
    onRetry: state => {
      reconnecting = state.count;
      attempt = state.attempt;
      report();
    },
  });
  const timeline = new RecordingTimeline(),
    tracks = new Map();
  let groupIndex = -1,
    map,
    pendingDiscontinuity = false;
  try {
    signal?.throwIfAborted();
    if (stopSignal?.aborted) return {stopped: true, saved: false, bytes: 0, duration: 0};
    const finishOpen = metrics?.start('fileOpen');
    try {
      file = await storageStep('createWritable', storageTarget, () => fileHandle.createWritable());
    } finally {
      finishOpen?.();
    }
    // A graceful stop cancels requests, not the disk transaction. Index writes
    // must remain possible after the network signal has been aborted.
    const writable = new WritableStream({
      async write(chunk) {
        signal?.throwIfAborted();
        const finish = metrics?.start('fileWrite');
        try {
          await storageStep('write', storageTarget, () => file.write(chunk));
          metrics?.add('writtenBytes', chunk.data.byteLength);
        } finally {
          finish?.();
        }
        written = Math.max(written, chunk.position + chunk.data.byteLength);
        report();
      },
    });
    // Final recordings use regular MP4 for playback compatibility. The internal
    // selection pipe uses fMP4 so its metadata is available before EOF; the
    // consumer still writes a regular MP4 with composition times and edit lists.
    output = new Output({
      format: new Mp4OutputFormat({fastStart: fragmented ? 'fragmented' : false}),
      target: new StreamTarget(writable, fragmented ? {chunked: false} : {chunked: true, chunkSize: 1024 * 1024}),
    });
    try {
      for await (const item of download.segments()) {
        const discontinuity = item.groupIndex !== groupIndex;
        if (discontinuity) {
          groupIndex = item.groupIndex;
          pendingDiscontinuity = true;
          for (const target of tracks.values()) target.needsKey = true;
          map = groups[groupIndex].map ? await download.readMap(groups[groupIndex].map) : null;
        }
        const data = map ? new Uint8Array(map.byteLength + item.data.byteLength) : item.data;
        if (map) {
          data.set(map);
          data.set(item.data, map.byteLength);
        }
        input = new Input({source: new BufferSource(data), formats: [MP4, MPEG_TS]});
        const segmentTracks = [];
        let sourceStart = Infinity,
          sourceEnd = -Infinity;
        for (const track of await input.getTracks()) {
          const key = `${track.type}:${track.number}`,
            codec = await track.getCodec();
          if (!['video', 'audio'].includes(track.type) || !output.format.getSupportedCodecs().includes(codec))
            throw new Error('本场编码无法保存为 MP4，已停止，以免丢失声音或画面。');
          const config = await track.getDecoderConfig();
          let target = tracks.get(key);
          if (!target) {
            if (output.state !== 'pending') throw new Error('录像中途音视频结构发生变化，无法保存到同一个 MP4。');
            const source =
              track.type === 'video' ? new EncodedVideoPacketSource(codec) : new EncodedAudioPacketSource(codec);
            if (track.type === 'video') output.addVideoTrack(source, {rotation: await track.getRotation()});
            else output.addAudioTrack(source);
            target = {source, codec, needsKey: true, written: false};
            tracks.set(key, target);
          }
          if (target.codec !== codec) throw new Error('录像中途音视频结构发生变化，无法保存到同一个 MP4。');
          const packets = [];
          for await (const original of new EncodedPacketSink(track).packets()) {
            download.signal.throwIfAborted();
            sourceStart = Math.min(sourceStart, original.timestamp);
            sourceEnd = Math.max(sourceEnd, original.timestamp + original.duration);
            // Container sync flags may be wrong in either direction, including
            // AAC marked as dependent. Inspect every packet, not just sync flags.
            const type = (await track.determinePacketType(original)) ?? original.type;
            const packet = type === original.type ? original : original.clone({type});
            // A recording (or a new discontinuity) can begin inside a GOP.
            // Wait for a verified random-access packet, even across files. Ordinary
            // segment boundaries must keep delta packets belonging to the prior GOP.
            if (target.needsKey) {
              if (packet.type !== 'key') continue;
              target.needsKey = false;
            }
            packets.push(packet);
          }
          segmentTracks.push({key, packets, target, config});
        }
        if (!segmentTracks.some(track => track.packets.length)) {
          input.dispose();
          input = null;
          processed = (item.index + 1) / item.count;
          report();
          continue;
        }
        const offset = timeline.append(segmentTracks, pendingDiscontinuity);
        pendingDiscontinuity = false;
        // Packet views are borrowed only for this synchronous callback.
        onSegment(
          {
            segment: item.segment,
            sourceOffset: offset,
            start: recordingTime(sourceStart + offset),
            end: recordingTime(sourceEnd + offset),
          },
          segmentTracks,
        );
        if (output.state === 'pending') await output.start();
        // Interleave tracks in small batches without changing each track's decode order.
        const cursors = segmentTracks.map(() => 0);
        while (segmentTracks.some((track, i) => cursors[i] < track.packets.length)) {
          for (const [i, track] of segmentTracks.entries()) {
            for (let batch = 0; batch < 32 && cursors[i] < track.packets.length; batch++) {
              // Finish all tracks of a segment once muxing starts. Stopping in
              // the middle of a batch could leave audio/video at different ends.
              signal?.throwIfAborted();
              const packet = track.packets[cursors[i]++];
              await track.target.source.add(packet.clone({timestamp: recordingTime(packet.timestamp + offset)}), {
                decoderConfig: track.config,
              });
              track.target.written = true;
            }
          }
        }
        input.dispose();
        input = null;
        processed = (item.index + 1) / item.count;
        report();
      }
    } catch (error) {
      signal?.throwIfAborted();
      const stopping =
        stopSignal?.aborted && error === stopSignal.reason && download.signal.reason === stopSignal.reason;
      // Only a failed fragment read is salvageable. Muxer and disk errors leave
      // the output in an unknown state and still fail the whole export.
      const unreadable = keepPartial && error instanceof RequestError && download.signal.reason === error;
      if (!stopping && !unreadable) throw error;
      if (!stopping) interruption = error;
    }
    signal?.throwIfAborted();
    const playable = tracks.size && [...tracks.values()].every(track => track.written);
    if (interruption && !playable) throw interruption;
    const stopped = Boolean((stopSignal?.aborted || interruption) && processed < 1);
    if (stopped && !playable) return {stopped: true, saved: false, bytes: 0, duration: 0};
    if (!tracks.size || [...tracks.values()].some(track => !track.written))
      throw new Error('这段录像缺少关键帧，无法导出。');
    phase = 'finalizing';
    report();
    for (const track of tracks.values()) track.source.close();
    const finishMux = metrics?.start('outputFinalize');
    try {
      await output.finalize();
    } finally {
      finishMux?.();
    }
    signal?.throwIfAborted();
    const finishClose = metrics?.start('fileClose');
    try {
      await storageStep('close', storageTarget, () => file.close());
    } finally {
      finishClose?.();
    }
    file = null;
    phase = 'saved';
    report(true);
    return {
      bytes: written,
      stopped,
      saved: true,
      duration: timeline.end,
      ...(interruption ? {interrupted: interruption} : {}),
    };
  } catch (error) {
    failure = signal?.aborted ? signal.reason : error;
    throw failure;
  } finally {
    signal?.removeEventListener('abort', abort);
    stopSignal?.removeEventListener('abort', stop);
    await cleanUp(
      failure,
      () => download.close(),
      () => {
        if (output && output.state !== 'finalized' && output.state !== 'canceled') return output.cancel();
      },
      () => input?.dispose(),
      () => file?.abort(),
    );
  }
}
