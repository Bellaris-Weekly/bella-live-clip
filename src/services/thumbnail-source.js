import {createSubmissionStoryboard} from './submission-storyboard.js';
import {drawFitted} from '../shared/fit.js';

const CACHE_LIMIT = 300,
  // A drag shows the nearest known picture rather than nothing.
  NEAREST_WITHIN = 300;

// One source belongs to one loaded record. Pictures are decoded from the
// recording, or read from the platform's storyboard for videos.
export function createThumbnailSource({
  record,
  request,
  metadataRequest = request,
  readFrame,
  createStoryboard = createSubmissionStoryboard,
  makeCanvas = () => document.createElement('canvas'),
  timeout = 5000,
  onFrames = () => {},
}) {
  const cache = new Map(),
    stills = [],
    lifetime = new AbortController();
  const storyboard =
    record.kind === 'submission'
      ? createStoryboard({submission: record, metadataRequest, mediaRequest: request})
      : null;
  // Signed URLs change on each live refresh; a frame's session/time does not.
  const key = sample => `${sample.stream?.start_time ?? record.key}:${sample.local}`;
  function canvasFor(draw, width, height) {
    const canvas = makeCanvas();
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext('2d');
    drawFitted(context, (x, y, w, h) => draw(context, x, y, w, h), width, height, 160, 90);
    return canvas;
  }
  function copy(source) {
    if (!source?.getContext) return source;
    return canvasFor((context, ...rect) => context.drawImage(source, ...rect), source.width, source.height);
  }
  function remember(id, canvas) {
    cache.delete(id);
    cache.set(id, canvas);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  async function limited(signal, action) {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const own = new AbortController(),
      abort = () => own.abort(signal.reason),
      dispose = () => own.abort(lifetime.signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    lifetime.signal.addEventListener('abort', dispose, {once: true});
    const timer = setTimeout(() => own.abort(new Error('预览图请求超时')), timeout);
    try {
      // Bound waits even if the underlying transport delivers cancellation late.
      return await Promise.race([
        action(own.signal),
        new Promise((_, reject) => {
          if (own.signal.aborted) reject(own.signal.reason);
          else own.signal.addEventListener('abort', () => reject(own.signal.reason), {once: true});
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', dispose);
    }
  }
  function firstAtOrAfter(time) {
    let low = 0,
      high = stills.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (stills[middle].time < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  // Decoded stills also serve the large drag preview, which displays URLs. They
  // are bounded by the recording's length and released with the source.
  function publish(time, canvas) {
    if (storyboard || !canvas?.toBlob) return;
    canvas.toBlob(
      blob => {
        const index = firstAtOrAfter(time);
        if (!blob || lifetime.signal.aborted || stills[index]?.time === time) return;
        stills.splice(index, 0, {time, url: URL.createObjectURL(blob)});
        onFrames();
      },
      'image/jpeg',
      0.8,
    );
  }
  function frameUrl(time) {
    const index = firstAtOrAfter(time);
    const nearest = [stills[index - 1], stills[index]]
      .filter(Boolean)
      .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
    return nearest && Math.abs(nearest.time - time) <= NEAREST_WITHIN ? nearest.url : null;
  }
  async function read(sample, signal) {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const id = key(sample),
      cached = cache.get(id);
    if (cached) {
      remember(id, cached);
      return copy(cached);
    }
    let canvas;
    try {
      if (!storyboard) throw new Error('录像没有平台预览图');
      const frame = await limited(signal, child => storyboard.read(sample.local, child));
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      canvas = canvasFor(
        (context, ...rect) => context.drawImage(frame.image, frame.x, frame.y, frame.width, frame.height, ...rect),
        frame.width,
        frame.height,
      );
    } catch (error) {
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      canvas = await readFrame(request, sample, signal);
      publish(sample.time, canvas);
    }
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    remember(id, canvas);
    return copy(canvas);
  }
  return {
    read,
    frameUrl,
    hasFrame: time => stills[firstAtOrAfter(time)]?.time === time,
    dispose() {
      lifetime.abort();
      storyboard?.dispose();
      cache.clear();
      for (const {url} of stills.splice(0)) URL.revokeObjectURL(url);
    },
  };
}
