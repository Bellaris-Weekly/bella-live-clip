import { CustomSource, Input, MP4 } from 'mediabunny';
import { requestWithRetry } from '../services/retry-request.js';
import { createFragmentIndex } from './mp4-index.js';

const CHUNK_SIZE = 1024 * 1024;

// Each source owns its transport lifetime; the library owns its bounded cache.
export function remoteMp4Source(request, descriptor, { signal, referer, onRead = () => {}, onRetry = () => {}, onIndex = () => {} } = {}) {
  const api = typeof request === 'function' ? { request } : request;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let sizePromise, size, prefix, trailer;
  async function readRange(start, end) {
    controller.signal.throwIfAborted();
    const range = { offset: start, length: end - start };
    const response = await requestWithRetry(api, descriptor.url, {
      type: 'arraybuffer', range, referer, signal: controller.signal,
    }, { onRetry: state => onRetry(state, descriptor) });
    controller.signal.throwIfAborted();
    const match = /^content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/im.exec(response.headers ?? '');
    const bytes = new Uint8Array(response.data);
    if (!match || Number(match[1]) !== start || Number(match[2]) !== end - 1
      || bytes.byteLength !== end - start || Number(match[3]) < end
      || (size !== undefined && Number(match[3]) !== size)) {
      throw new Error('视频服务器返回的字节范围不一致，请重新载入视频。');
    }
    size = Number(match[3]);
    onRead(bytes.byteLength, descriptor);
    return bytes;
  }
  const dispose = () => {
    signal?.removeEventListener('abort', abort);
    controller.abort();
  };
  async function initialize() {
    await readRange(0, 1);
    if (descriptor.indexRange) {
      const end = descriptor.indexRange.offset + descriptor.indexRange.length;
      if (end > size) throw new Error('视频分段索引超出文件范围。');
      prefix = new Uint8Array(end);
      for (let start = 0; start < end; start += CHUNK_SIZE) {
        prefix.set(await readRange(start, Math.min(end, start + CHUNK_SIZE)), start);
      }
      const index = await createFragmentIndex(prefix, descriptor.indexRange, size);
      controller.signal.throwIfAborted();
      trailer = index.trailer;
      onIndex(index.segments, descriptor);
    }
    return size + (trailer?.length ?? 0);
  }
  return new CustomSource({
    maxCacheSize: 8 * CHUNK_SIZE,
    prefetchProfile: 'network',
    getSize() { return sizePromise ??= initialize(); },
    read(start, end) {
      return new ReadableStream({
        async pull(stream) {
          try {
            let next = Math.min(end, start + CHUNK_SIZE), bytes;
            if (prefix && start < prefix.length) {
              next = Math.min(next, prefix.length); bytes = prefix.subarray(start, next);
            } else if (start >= size) {
              bytes = trailer.subarray(start - size, next - size);
            } else {
              next = Math.min(next, size); bytes = await readRange(start, next);
            }
            stream.enqueue(bytes);
            start = next;
            if (start === end) stream.close();
          } catch (error) { stream.error(error); }
        },
      }, { highWaterMark: 0 });
    },
    dispose,
    handleUnhandledError(error) { controller.abort(error); },
  });
}

export function openSubmissionMedia(request, submission, options = {}) {
  const descriptor = options.preview ? submission.previewMedia : submission.media;
  const settings = { ...options, referer: submission.referer };
  const videoInput = new Input({ source: remoteMp4Source(request, descriptor.video, settings), formats: [MP4] });
  const audioInput = descriptor.combined ? videoInput : descriptor.audio
    ? new Input({ source: remoteMp4Source(request, descriptor.audio, settings), formats: [MP4] }) : null;
  return {
    videoInput, audioInput,
    async getTracks() {
      options.signal?.throwIfAborted();
      const video = await videoInput.getPrimaryVideoTrack();
      const audios = audioInput ? await audioInput.getAudioTracks() : [];
      if (!video || await video.getCodec() !== 'avc') throw new Error('当前视频没有可用的 H.264 画面。');
      if (!descriptor.combined && descriptor.audio && !audios.length) throw new Error('音频文件缺少音轨，已停止导出以避免丢失声音。');
      if ((await Promise.all(audios.map(track => track.getCodec()))).some(codec => codec !== 'aac')) throw new Error('当前视频的音频不是受支持的 AAC 格式。');
      options.signal?.throwIfAborted();
      return [video, ...audios];
    },
    dispose() { videoInput.dispose(); if (audioInput && audioInput !== videoInput) audioInput.dispose(); },
  };
}
