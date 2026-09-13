export const segmentKey = segment => JSON.stringify([segment.url, segment.range ?? null]);

// Keep the two most recently demanded media segments and one forward lookahead.
// Speculative downloads never displace demanded bytes. The final segment has a
// separate slot because HLS probes it for duration before processing the middle.
// Retain the first segment as the common audio/video timestamp anchor as well.
export function createSegmentLoader(api, segments, { map, signal, onRead = () => {} } = {}) {
  const controller = new AbortController();
  const entries = new Map(), demanded = [], queue = [], tasks = new Set();
  const positions = new Map(segments.map((segment, index) => [segmentKey(segment), index]));
  const mapKey = map && segmentKey(map), firstKey = segmentKey(segments[0]), lastKey = segmentKey(segments.at(-1));
  let lookaheadKey, frontier = -1, active = 0, closed = false;
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  function prune() {
    const keep = new Set([...demanded, lookaheadKey, mapKey, firstKey, lastKey]);
    for (const [key, entry] of entries) {
      if (entry.settled && !keep.has(key)) entries.delete(key);
    }
  }

  function pump() {
    while (active < 2 && queue.length) {
      const entry = queue.shift();
      active++;
      const task = (async () => {
        try {
          controller.signal.throwIfAborted();
          const response = await api.request(entry.segment.url, {
            type: 'arraybuffer', range: entry.segment.range, signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          const data = new Uint8Array(response.data);
          onRead(data.byteLength, entry.segment);
          entry.resolve(data);
        } catch (error) {
          controller.abort(error);
          entry.reject(controller.signal.reason);
        } finally {
          entry.settled = true;
          active--;
          prune();
          pump();
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
  }

  function request(segment, speculative = false) {
    const key = segmentKey(segment);
    let entry = entries.get(key);
    if (!entry) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Observe prefetch failure immediately; it also aborts the export lifetime.
      void promise.catch(() => {});
      entry = { segment, promise, resolve, reject, settled: false };
      entries.set(key, entry);
      if (speculative) queue.push(entry);
      else queue.unshift(entry);
      pump();
    } else if (!speculative) {
      const index = queue.indexOf(entry);
      if (index >= 0) { queue.splice(index, 1); queue.unshift(entry); }
    }
    return entry.promise;
  }

  async function read(segment) {
    controller.signal.throwIfAborted();
    const key = segmentKey(segment), index = positions.get(key);
    if (key !== mapKey && key !== firstKey && key !== lastKey) {
      const previous = demanded.indexOf(key);
      if (previous >= 0) demanded.splice(previous, 1);
      demanded.push(key);
      if (demanded.length > 2) demanded.shift();
    }
    const result = request(segment);
    if (index !== undefined && index > frontier && index + 1 < segments.length) {
      frontier = index;
      const next = segments[index + 1];
      lookaheadKey = segmentKey(next);
      request(next, true);
    }
    prune();
    const data = await result;
    controller.signal.throwIfAborted();
    return data;
  }

  return {
    read,
    signal: controller.signal,
    beginProcessing() {
      // Planning may seek near the tail. Actual decoding starts from the head,
      // so resume forward lookahead without replaying old speculative chains.
      frontier = -1;
      lookaheadKey = undefined;
      prune();
    },
    async close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', abort);
      controller.abort();
      while (tasks.size) await Promise.allSettled([...tasks]);
      entries.clear();
    },
  };
}
