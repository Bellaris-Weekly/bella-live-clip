import {
  BufferTarget, EncodedAudioPacketSource, EncodedPacketSink,
  EncodedVideoPacketSource, Mp4OutputFormat, Output,
} from 'mediabunny';
import { encodeVideoRange, readVideoEncodingSettings } from './encoding.js';
import { createAvcNormalizer, UnsupportedAvcError } from './avc-packets.js';

const verified = { verifyKeyPackets: true };

export function sameAvcConfiguration(a, b) {
  const bytes = value => new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);
  const first = bytes(a.description), second = bytes(b.description);
  return a.codec === b.codec && a.codedWidth === b.codedWidth && a.codedHeight === b.codedHeight
    && (a.displayAspectWidth ?? a.codedWidth) * (b.displayAspectHeight ?? b.codedHeight)
      === (b.displayAspectWidth ?? b.codedWidth) * (a.displayAspectHeight ?? a.codedHeight)
    && ['primaries', 'transfer', 'matrix', 'fullRange'].every(key => (a.colorSpace?.[key] ?? null) === (b.colorSpace?.[key] ?? null))
    && first.length === second.length && first.every((value, index) => value === second[index]);
}

// Recovery-point keyframes may belong to open GOPs. Only IDR frames close all
// references to the previous decoder configuration and permit a safe splice.
export async function planVideoCut(track, { start, end, normalizer, signal }) {
  const sink = new EncodedPacketSink(track), tick = 1 / await track.getTimeResolution();
  async function previousIdr(time) {
    let packet = await sink.getKeyPacket(time, verified);
    while (packet && !normalizer.isIdr(packet)) {
      signal?.throwIfAborted();
      packet = await sink.getKeyPacket(packet.timestamp - tick, verified);
    }
    return packet;
  }
  let first = await previousIdr(start);
  if (!first) first = await sink.getFirstKeyPacket(verified);
  while (first && (first.timestamp < start - tick / 2 || !normalizer.isIdr(first))) {
    signal?.throwIfAborted();
    first = await sink.getNextKeyPacket(first, verified);
  }
  const reachesEnd = end >= await track.computeDuration() - tick / 2;
  const last = reachesEnd ? undefined : await previousIdr(end);
  signal?.throwIfAborted();
  if (!first || first.timestamp >= end || (!reachesEnd && (!last || first.timestamp >= last.timestamp))) {
    return { headEnd: end, tailStart: end, first: null, last: null };
  }
  return { headEnd: Math.max(start, first.timestamp), tailStart: reachesEnd ? end : Math.min(end, last.timestamp), first, last };
}

async function* videoPackets(track, { start, end, settings, normalizer, plan, signal, stats }) {
  async function* encode(from, to) {
    if (to <= from) return;
    let encoded;
    for await (const value of encodeVideoRange(track, { start: from, end: to, origin: start, settings, signal })) {
      if (!encoded) {
        encoded = createAvcNormalizer(value.decoderConfig, value.packet);
        if (plan.first && !sameAvcConfiguration(encoded.decoderConfig, normalizer.decoderConfig)) {
          // Multiple avc1 sample descriptions decode in AVFoundation/FFmpeg,
          // but Chromium playback fails at the change. Keep one configuration.
          throw new UnsupportedAvcError('边界编码参数与原片不同，无法保证播放器兼容');
        }
        if (!encoded.isIdr(value.packet)) throw new UnsupportedAvcError('边界编码没有生成独立关键帧');
      }
      stats.encodedFrames++;
      yield { packet: encoded.normalize(value.packet), decoderConfig: encoded.decoderConfig };
    }
  }
  yield* encode(start, plan.headEnd);
  if (plan.first) {
    const sink = new EncodedPacketSink(track);
    for await (const packet of sink.packets(plan.first, plan.last, verified)) {
      signal?.throwIfAborted();
      if (packet.timestamp < plan.headEnd - 1e-6 || packet.timestamp + packet.duration > plan.tailStart + 1e-6) {
        throw new UnsupportedAvcError('关键帧之间存在跨边界画面引用');
      }
      stats.copiedFrames++;
      yield { packet: normalizer.normalize(packet).clone({ timestamp: packet.timestamp - start }),
        decoderConfig: normalizer.decoderConfig };
    }
  }
  yield* encode(plan.tailStart, end);
}

async function* audioPackets(track, { start, end, signal }) {
  const sink = new EncodedPacketSink(track), decoderConfig = await track.getDecoderConfig();
  let first = await sink.getKeyPacket(start) ?? await sink.getFirstKeyPacket();
  if (first && first.timestamp + first.duration <= start) first = await sink.getNextKeyPacket(first);
  // AAC overlap-add needs the preceding packet to reconstruct the first audible
  // samples. Its negative PTS is represented by the MP4 edit list, not by silence.
  if (first) first = await sink.getKeyPacket(first.timestamp - 1 / await track.getTimeResolution()) ?? first;
  if (!first) return;
  for await (const packet of sink.packets(first)) {
    signal?.throwIfAborted();
    if (packet.timestamp >= end) break;
    yield { packet: packet.clone({ timestamp: packet.timestamp - start,
      duration: Math.min(packet.duration, end - packet.timestamp) }), decoderConfig };
  }
}

async function trackMetadata(track) {
  const [languageCode, name, disposition] = await Promise.all([
    track.getLanguageCode(), track.getName(), track.getDisposition(),
  ]);
  return { languageCode, name: name ?? undefined, disposition };
}

async function smartTrim(input, { start, end, signal, onProgress, onProcessingStart }) {
  const tracks = await input.getTracks();
  const videos = tracks.filter(track => track.type === 'video'), audios = tracks.filter(track => track.type === 'audio');
  if (videos.length !== 1 || tracks.length !== videos.length + audios.length
    || await videos[0].getCodec() !== 'avc'
    || (await Promise.all(audios.map(track => track.getCodec()))).some(codec => codec !== 'aac')) {
    throw new UnsupportedAvcError('当前音视频格式不支持安全拼接');
  }
  const track = videos[0], settings = await readVideoEncodingSettings(track, { signal });
  const firstPacket = await new EncodedPacketSink(track).getFirstKeyPacket(verified);
  if (!firstPacket) throw new UnsupportedAvcError('录像缺少可用关键帧');
  const normalizer = createAvcNormalizer(settings.sourceDecoderConfig, firstPacket);
  const plan = await planVideoCut(track, { start, end, normalizer, signal });
  if (plan.first && (plan.headEnd > start || plan.tailStart < end) && !settings.canSplice) {
    throw new UnsupportedAvcError('浏览器无法编码与原片相同的 H.264 规格');
  }
  const stats = { strategy: 'smart', encodedFrames: 0, copiedFrames: 0, sourceBitrate: settings.bitrate };
  onProcessingStart();
  onProgress(0, { ...stats, message: plan.first ? '仅编码头尾，中间保留原画' : '选区较短，按原码率编码' });

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
  const video = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(video, { ...await trackMetadata(track), rotation: await track.getRotation() });
  const streams = [{ source: video, iterator: videoPackets(track, { start, end, settings, normalizer, plan, signal, stats }) }];
  for (const audio of audios) {
    const source = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(source, await trackMetadata(audio));
    streams.push({ source, iterator: audioPackets(audio, { start, end, signal }) });
  }
  return muxPackets(output, streams, { start, end, signal, onProgress, stats, video });
}

async function muxPackets(output, streams, { start, end, signal, onProgress, stats, video }) {
  let count = 0, progress = 0, canceling;
  const cancel = () => { canceling ??= output.cancel(); void canceling.catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await output.start();
    for (const stream of streams) stream.next = await stream.iterator.next();
    while (streams.some(stream => !stream.next.done)) {
      signal?.throwIfAborted();
      // One pending packet per track preserves each track's decode order while
      // keeping audio/video reads near each other in the bounded HLS cache.
      const stream = streams.filter(item => !item.next.done)
        .reduce((a, b) => a.next.value.packet.timestamp <= b.next.value.packet.timestamp ? a : b);
      const { packet, decoderConfig } = stream.next.value;
      if (stream.source === video) count++;
      await stream.source.add(packet, { decoderConfig });
      progress = Math.max(progress, Math.min(.99, (packet.timestamp + packet.duration) / (end - start)));
      onProgress(progress, stats);
      stream.next = await stream.iterator.next();
      if (stream.next.done) stream.source.close();
    }
    for (const stream of streams) stream.source.close();
    await output.finalize();
    signal?.throwIfAborted();
    if (video && !count) throw new Error('选区内没有可导出的画面。');
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    onProgress(1, stats);
    return blob;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await Promise.allSettled(streams.map(stream => stream.iterator.return()));
    if (canceling) await canceling;
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
  }
}

async function encodeSelection(input, { start, end, signal, onProgress, onProcessingStart }) {
  const tracks = await input.getTracks();
  if (!tracks.some(track => track.type === 'video') || tracks.some(track => !['video', 'audio'].includes(track.type))) {
    throw new Error('当前音视频轨道无法完整编码，请使用原画下载。');
  }
  if ((await Promise.all(tracks.filter(track => track.type === 'audio').map(track => track.getCodec()))).some(codec => codec !== 'aac')) {
    throw new Error('精确模式目前需要 AAC 音频，请使用原画下载以保留声音。');
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
  const streams = [];
  for (const track of tracks) {
    signal?.throwIfAborted();
    const options = { start, end, origin: start, signal };
    if (track.type === 'video') {
      if (!await track.canDecode()) throw new Error('当前浏览器无法解码这段录像，请使用原画下载或更新 Chrome / Edge。');
      const source = new EncodedVideoPacketSource('avc');
      const settings = await readVideoEncodingSettings(track, { signal });
      output.addVideoTrack(source, { ...await trackMetadata(track), rotation: await track.getRotation() });
      streams.push({ source, iterator: encodeVideoRange(track, { ...options, settings }) });
    } else {
      const source = new EncodedAudioPacketSource('aac');
      output.addAudioTrack(source, await trackMetadata(track));
      streams.push({ source, iterator: audioPackets(track, options) });
    }
  }
  onProcessingStart();
  return muxPackets(output, streams, { start, end, signal, onProgress, stats: { strategy: 'full' } });
}

export async function trimPrecise(input, { start = 0, end, signal, onProgress = () => {}, onProcessingStart = () => {} } = {}) {
  signal?.throwIfAborted();
  end ??= await input.computeDuration();
  try { return await smartTrim(input, { start, end, signal, onProgress, onProcessingStart }); }
  catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (!(error instanceof UnsupportedAvcError)) throw error;
    onProgress(0, { strategy: 'full', message: '当前素材无法安全拼接，已改为按原码率整段编码' });
    return encodeSelection(input, { start, end, signal, onProgress, onProcessingStart });
  }
}
