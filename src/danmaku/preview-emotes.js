import {boundedFetch, publicUrl} from './archive.js';
import {loadEmoteCatalog} from './emotes.js';

// Catalog and compressed bytes belong to the preview source, not a seek's
// decoders. Canceling one waiter must not cancel the next seek's download.
export function createPreviewEmoteCache(
  room,
  {signal, fetcher = fetch, maxBytes = 16 * 1024 * 1024, maxEntries = 128} = {},
) {
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const entries = new Map();
  const lanes = Array.from({length: 3}, () => Promise.resolve());
  let catalog,
    bytes = 0,
    lane = 0;
  function remove(key) {
    bytes -= entries.get(key)?.size ?? 0;
    entries.delete(key);
  }
  function trim(extraBytes = 0, extraEntries = 0) {
    for (const [key, entry] of entries) {
      if (bytes + extraBytes <= maxBytes && entries.size + extraEntries <= maxEntries) break;
      if (entry.size !== undefined) remove(key);
    }
  }
  async function wait(promise, caller) {
    caller?.throwIfAborted();
    signal.throwIfAborted();
    if (!caller) return promise;
    let abort;
    try {
      const result = await Promise.race([
        promise,
        new Promise((_, reject) => {
          abort = () => reject(caller.reason);
          caller.addEventListener('abort', abort, {once: true});
        }),
      ]);
      caller.throwIfAborted();
      signal.throwIfAborted();
      return result;
    } finally {
      caller.removeEventListener('abort', abort);
    }
  }
  const clear = () => {
    entries.clear();
    bytes = 0;
    catalog = null;
  };
  signal.addEventListener('abort', clear, {once: true});
  return {
    catalog(caller) {
      signal.throwIfAborted();
      caller?.throwIfAborted();
      catalog ??= loadEmoteCatalog(room, {signal, fetcher}).catch(error => {
        catalog = null;
        throw error;
      });
      return wait(catalog, caller);
    },
    read(entry, caller) {
      signal.throwIfAborted();
      caller?.throwIfAborted();
      const key = entry.file;
      let own = entries.get(key);
      if (own) {
        entries.delete(key);
        entries.set(key, own);
      } else {
        trim(0, 1);
        if (entries.size >= maxEntries) throw new Error('弹幕表情缓存请求过多，请稍后重试。');
        own = {};
        const slot = lane++ % lanes.length;
        own.promise = lanes[slot]
          .then(async () => {
            signal.throwIfAborted();
            const result = await boundedFetch(publicUrl(key.split('/').map(encodeURIComponent).join('/'), 'emotes/'), {
              signal,
              fetcher,
              limit: 2 * 1024 * 1024,
              operation: 'emoteFetch',
            });
            signal.throwIfAborted();
            if (entries.get(key) !== own) return result;
            trim(result.bytes.byteLength);
            if (result.bytes.byteLength > maxBytes) entries.delete(key);
            else {
              own.size = result.bytes.byteLength;
              bytes += own.size;
            }
            return result;
          })
          .catch(error => {
            if (entries.get(key) === own) remove(key);
            throw error;
          });
        lanes[slot] = own.promise.then(
          () => {},
          () => {},
        );
        entries.set(key, own);
      }
      return wait(own.promise, caller);
    },
    close() {
      controller.abort();
      clear();
    },
    discard(entry) {
      if (entries.get(entry.file)?.size !== undefined) remove(entry.file);
    },
  };
}
