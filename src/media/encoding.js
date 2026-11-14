import {
  Quality,
  canEncodeVideo,
  Output,
  NullTarget,
  MpegTsOutputFormat,
  VideoSampleSource,
  VideoSampleSink,
} from 'mediabunny';
import {createAbortableWait} from '../shared/abortable-wait.js';

// Estimate from a prefix so preparing an encoder never scans the entire recording.
const VIDEO_STATS_PACKETS = 120;

async function supportsConfig(config, signal) {
  signal?.throwIfAborted();
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return (await VideoEncoder.isConfigSupported(config)).supported;
  } catch {
    return false;
  } finally {
    signal?.throwIfAborted();
  }
}

export async function readVideoEncodingSettings(track, {signal, metrics} = {}) {
  const finish = metrics?.start('encoderSetup');
  try {
    signal?.throwIfAborted();
    const [width, height, displayWidth, displayHeight, stats, sourceDecoderConfig] = await Promise.all([
      track.getCodedWidth(),
      track.getCodedHeight(),
      track.getSquarePixelWidth(),
      track.getSquarePixelHeight(),
      track.computePacketStats(VIDEO_STATS_PACKETS),
      track.getDecoderConfig(),
    ]);
    signal?.throwIfAborted();
    const bitrate = Math.round(stats.averageBitrate),
      frameRate = stats.averagePacketRate;
    if (!(bitrate > 0 && Number.isFinite(bitrate) && frameRate > 0 && Number.isFinite(frameRate))) {
      throw new Error('这段录像缺少码率或帧率信息，请改用原画导出。');
    }
    const quality = new Quality({bitrate, bitrateMode: 'variable'});
    const options = {codec: 'avc', quality, latencyMode: 'quality'};
    const codec = sourceDecoderConfig?.codec.replace(/^avc3\./i, 'avc1.');
    const isAvc = /^avc1\.[\da-f]{6}$/i.test(codec ?? '');
    let canSplice = false;
    if (isAvc) {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        if (
          await supportsConfig(
            {
              codec,
              width,
              height,
              displayWidth,
              displayHeight,
              bitrate,
              framerate: frameRate,
              bitrateMode: 'variable',
              latencyMode: 'quality',
              hardwareAcceleration,
              avc: {format: 'avc'},
            },
            signal,
          )
        ) {
          Object.assign(options, {fullCodecString: codec, hardwareAcceleration});
          canSplice = true;
          break;
        }
      }
    }
    if (!canSplice) {
      const hardware = await canEncodeVideo('avc', {
        width,
        height,
        quality,
        latencyMode: 'quality',
        hardwareAcceleration: 'prefer-hardware',
      });
      signal?.throwIfAborted();
      options.hardwareAcceleration = hardware ? 'prefer-hardware' : 'no-preference';
    }
    // In pinned Mediabunny 1.56.1 this callback runs before support checks and configure.
    // Setting transform.frameRate or output-track frameRate would instead resample/snap timestamps.
    options.onEncoderConfig = config => {
      config.framerate = frameRate;
      metrics?.encoder(config);
    };
    return {width, height, bitrate, frameRate, sourceDecoderConfig, canSplice, encodingOptions: options};
  } finally {
    finish?.();
  }
}

export async function* encodeVideoRange(track, {start, end, origin = 0, settings, signal, compositor, metrics}) {
  settings ??= await readVideoEncodingSettings(track, {signal, metrics});
  signal?.throwIfAborted();
  const packets = [];
  let decoderConfig, canceling, pending;
  // A streaming discard target avoids retaining a second movie or a whole-file sample table.
  const output = new Output({format: new MpegTsOutputFormat(), target: new NullTarget()});
  const source = new VideoSampleSource({
    ...settings.encodingOptions,
    onEncodedPacket(packet, metadata) {
      metrics?.firstPacket();
      metrics?.add('encodedPackets');
      metrics?.add('encodedBytes', packet.data.byteLength);
      decoderConfig = metadata?.decoderConfig ?? decoderConfig;
      packets.push({packet, decoderConfig});
    },
  });
  output.addVideoTrack(source);
  const endTime = typeof end === 'function' ? end : () => end;
  const samples = new VideoSampleSink(track).samples(start, typeof end === 'function' ? Infinity : end);
  const waits = createAbortableWait();
  const stop = reason => {
    waits.abort(reason);
    // The sink's return closes queued decoded frames and wakes a blocked next().
    canceling ??= Promise.all([samples.return(), output.cancel()]);
    void canceling.catch(() => {});
  };
  const cancel = () => stop(signal.reason);
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    await output.start();
    let first = true;
    while (true) {
      const finishRead = metrics?.start('sampleWait');
      let next;
      try {
        next = await samples.next();
      } finally {
        finishRead?.();
      }
      if (next.done) break;
      const sample = next.value;
      let rendered,
        submitted = false;
      const close = () => {
        if (rendered && rendered !== sample) rendered.close();
        sample.close();
      };
      try {
        signal?.throwIfAborted();
        const clippedStart = Math.max(start, sample.timestamp);
        const limit = endTime();
        if (sample.timestamp >= limit) break;
        const clippedEnd = Math.min(limit, sample.timestamp + sample.duration);
        if (clippedEnd <= clippedStart) continue;
        metrics?.add('videoFrames');
        const finishPreparation = metrics?.start('danmakuPrepare');
        try {
          const preparation = compositor?.prepare?.(clippedStart);
          if (preparation) await waits.wait(preparation);
        } finally {
          finishPreparation?.();
        }
        const finishRender = metrics?.start('render');
        try {
          rendered = compositor?.render(sample, clippedStart);
        } finally {
          finishRender?.();
        }
        metrics?.firstFrame();
        const frame = rendered ?? sample;
        frame.setTimestamp(clippedStart - origin);
        frame.setDuration(clippedEnd - clippedStart);
        // VideoSample(canvas) constructs a VideoFrame snapshot in Mediabunny 1.56.1.
        // Render one frame ahead on the same canvas, but never overlap add() calls.
        await pending;
        while (packets.length) {
          signal?.throwIfAborted();
          yield packets.shift();
        }
        signal?.throwIfAborted();
        const finishEncode = metrics?.start('encodeSubmit');
        pending = (async () => {
          try {
            await waits.wait(source.add(frame, first ? {keyFrame: true} : undefined));
          } finally {
            finishEncode?.();
            close();
          }
        })();
        submitted = true;
        // Wake a blocked decoder read if encoding fails during the overlap.
        void pending.catch(stop);
        first = false;
      } finally {
        if (!submitted) close();
      }
    }
    await pending;
    while (packets.length) {
      signal?.throwIfAborted();
      yield packets.shift();
    }
    signal?.throwIfAborted();
    const finishFlush = metrics?.start('encoderFlush');
    try {
      await output.finalize();
    } finally {
      finishFlush?.();
    }
    while (packets.length) {
      signal?.throwIfAborted();
      yield packets.shift();
    }
  } catch (error) {
    stop(error);
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (output.state !== 'finalized' && output.state !== 'canceled')
      stop(new DOMException('编码已停止。', 'AbortError'));
    await samples.return();
    if (canceling) await canceling;
    await pending?.catch(() => {});
    packets.length = 0;
  }
}
