import {measureMediaRequest} from '../shared/media-metrics.js';
import {requestWithRetry} from '../services/retry-request.js';

export const RECORDING_DOWNLOAD_CONCURRENCY = 8;

// A bounded ordered window: downloads overlap, consumption keeps playlist order.
// Unknown response sizes can exceed the byte budget only by the active window.
export function createRecordingDownload(
  api,
  groups,
  {
    signal,
    concurrency = RECORDING_DOWNLOAD_CONCURRENCY,
    maxBytes = 64 * 1024 * 1024,
    onRead = () => {},
    onRetry = () => {},
    metrics,
    limit = () => Infinity,
    missingRetries = 0,
  } = {},
) {
  metrics?.gauge('downloadConcurrency', concurrency);
  const mediaApi = {request: measureMediaRequest(api, metrics)};
  const items = groups.flatMap((group, groupIndex) => group.segments.map(segment => ({segment, groupIndex})));
  const controller = new AbortController(),
    entries = new Map(),
    tasks = new Set();
  const reconnects = new Map();
  let cursor = 0,
    next = 0,
    active = 0,
    held = 0,
    reserved = 0,
    average = 4 * 1024 * 1024,
    samples = 0;
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();

  function retry(key, state) {
    if (state) reconnects.set(key, state);
    else reconnects.delete(key);
    onRetry({count: reconnects.size, attempt: Math.max(0, ...[...reconnects.values()].map(value => value.attempt))});
  }
  async function read(segment) {
    const response = await requestWithRetry(
      mediaApi,
      segment.url,
      {type: 'arraybuffer', range: segment.range, signal: controller.signal},
      {onRetry: state => retry(segment, state), missingRetries},
    );
    controller.signal.throwIfAborted();
    const data = new Uint8Array(response.data);
    onRead(data.byteLength);
    return data;
  }
  function pump() {
    while (
      !controller.signal.aborted &&
      active < concurrency &&
      next < items.length &&
      next < limit() &&
      // The fragment being consumed must not take a network slot. Retain at
      // most that fragment plus one window, even if the head request is slow.
      next < cursor + concurrency + 1
    ) {
      const reservation = items[next].segment.range?.length ?? average;
      if (next !== cursor && held + reserved + reservation > maxBytes) break;
      const index = next++,
        entry = {size: 0};
      active++;
      reserved += reservation;
      entries.set(index, entry);
      const task = read(items[index].segment)
        .then(data => {
          entry.size = data.byteLength;
          held += entry.size;
          average += (entry.size - average) / ++samples;
          return data;
        })
        .catch(error => {
          controller.abort(error);
          throw error;
        })
        .finally(() => {
          active--;
          reserved -= reservation;
          tasks.delete(task);
          pump();
        });
      entry.promise = task;
      tasks.add(task);
      void task.catch(() => {});
    }
  }
  return {
    signal: controller.signal,
    readMap: read,
    async *segments() {
      for (; cursor < items.length && cursor < limit(); cursor++) {
        controller.signal.throwIfAborted();
        pump();
        const entry = entries.get(cursor),
          data = await entry.promise;
        controller.signal.throwIfAborted();
        yield {...items[cursor], data, index: cursor, count: Math.min(items.length, limit())};
        held -= entry.size;
        entries.delete(cursor);
      }
    },
    async close() {
      signal?.removeEventListener('abort', abort);
      controller.abort();
      await Promise.allSettled([...tasks]);
      entries.clear();
    },
  };
}
