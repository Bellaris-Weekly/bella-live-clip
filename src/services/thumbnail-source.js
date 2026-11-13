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
  maxStills = CACHE_LIMIT,
  maxStillBytes = 8 * 1024 * 1024,
}) {
  const cache = new Map(),
    pending = new Map(),
    stills = [],
    recentStills = new Map(),
    publishing = new Set(),
    lifetime = new AbortController();
  let stillBytes = 0;
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
  function touch(still) {
    recentStills.delete(still.time);
    recentStills.set(still.time, still);
  }
  function trimStills() {
    while (recentStills.size > maxStills || stillBytes > maxStillBytes) {
      const old = recentStills.values().next().value;
      recentStills.delete(old.time);
      stills.splice(firstAtOrAfter(old.time), 1);
      stillBytes -= old.bytes;
      URL.revokeObjectURL(old.url);
    }
  }
  // JPEG URLs have a separate bounded LRU: retaining the canvas is not needed
  // to show a drag still, and retaining its URL must not bypass the byte cap.
  function publish(time, canvas) {
    if (storyboard || !canvas?.toBlob) return;
    const existing = recentStills.get(time);
    if (existing) {
      touch(existing);
      return;
    }
    if (publishing.has(time) || maxStills <= 0) return;
    publishing.add(time);
    try {
      canvas.toBlob(
        blob => {
          publishing.delete(time);
          const index = firstAtOrAfter(time);
          if (!blob || lifetime.signal.aborted || stills[index]?.time === time || blob.size > maxStillBytes) return;
          const still = {time, url: URL.createObjectURL(blob), bytes: blob.size};
          stills.splice(index, 0, still);
          touch(still);
          stillBytes += still.bytes;
          trimStills();
          onFrames();
        },
        'image/jpeg',
        0.8,
      );
    } catch (error) {
      publishing.delete(time);
      throw error;
    }
  }
  function frameUrl(time) {
    const index = firstAtOrAfter(time);
    const before = stills[index - 1],
      after = stills[index];
    const nearest = !after || (before && time - before.time <= after.time - time) ? before : after;
    if (!nearest || Math.abs(nearest.time - time) > NEAREST_WITHIN) return null;
    touch(nearest);
    return nearest.url;
  }
  async function load(sample, signal) {
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
    }
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    remember(key(sample), canvas);
    publish(sample.time, canvas);
    return canvas;
  }
  async function read(sample, signal) {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const id = key(sample),
      cached = cache.get(id);
    if (cached) {
      remember(id, cached);
      publish(sample.time, cached);
      return copy(cached);
    }
    // Fragment-only drag reads must not inherit a slow player's fallback.
    const requestKey = `${id}:${Boolean(sample.fragmentOnly)}`;
    let own = pending.get(requestKey);
    if (!own) {
      const controller = new AbortController();
      own = {controller, readers: 0};
      own.promise = load(sample, AbortSignal.any([lifetime.signal, controller.signal])).finally(() => {
        if (pending.get(requestKey) === own) pending.delete(requestKey);
      });
      void own.promise.catch(() => {});
      pending.set(requestKey, own);
    }
    own.readers++;
    const waiting = AbortSignal.any([signal, lifetime.signal]);
    let abort,
      detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      if (--own.readers === 0 && pending.get(requestKey) === own) {
        pending.delete(requestKey);
        own.controller.abort();
      }
    };
    try {
      const canvas = await Promise.race([
        own.promise,
        new Promise((_, reject) => {
          abort = () => {
            detach();
            reject(waiting.reason);
          };
          if (waiting.aborted) abort();
          else waiting.addEventListener('abort', abort, {once: true});
        }),
      ]);
      waiting.throwIfAborted();
      return copy(canvas);
    } finally {
      waiting.removeEventListener('abort', abort);
      detach();
    }
  }
  return {
    read,
    frameUrl,
    hasFrame: time => stills[firstAtOrAfter(time)]?.time === time,
    dispose() {
      lifetime.abort();
      storyboard?.dispose();
      cache.clear();
      pending.clear();
      for (const {url} of stills.splice(0)) URL.revokeObjectURL(url);
      recentStills.clear();
      publishing.clear();
      stillBytes = 0;
    },
  };
}
