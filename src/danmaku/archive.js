import {annotate} from '../shared/errors.js';
import {commentTime, PLAYBACK_LATENCY} from './clock.js';
import {waitForRetry} from '../services/retry-request.js';

export const ARCHIVE_BASE = 'https://data.bellaris.fans/';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const WHOLE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 100000;

async function retryOpen(task, signal) {
  try {
    return await task();
  } catch (error) {
    signal?.throwIfAborted();
    if (!error?.retryable) throw error;
    return task(); // One transient retry; format/storage errors stay fatal.
  }
}

export function publicUrl(path, prefix = '') {
  const url = new URL(path, path.startsWith(prefix) ? ARCHIVE_BASE : ARCHIVE_BASE + prefix);
  if (url.origin !== new URL(ARCHIVE_BASE).origin || !url.pathname.startsWith('/' + prefix))
    throw new Error('弹幕归档资源地址无效。');
  return url.href;
}

export async function boundedFetch(url, options = {}) {
  const controller = new AbortController();
  const {signal} = options;
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(
    () => controller.abort(Object.assign(new Error('弹幕资源读取超时，请重试。'), {retryable: true})),
    30000,
  );
  try {
    return await readBounded(url, {...options, signal: controller.signal});
  } catch (caught) {
    signal?.throwIfAborted();
    let error = caught;
    if (controller.signal.aborted) error = controller.signal.reason;
    else if (error instanceof TypeError)
      error = Object.assign(new Error('弹幕资源读取失败，请检查网络后重试。', {cause: error}), {retryable: true});
    throw annotate(error, {operation: options.operation ?? 'archiveRead', target: 'network'});
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function readBounded(url, {signal, headers, limit = MAX_FILE_BYTES, fetcher = fetch}) {
  const response = await fetcher(url, {signal, headers, credentials: 'omit', cache: 'no-store'});
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(
      new Error(response.status === 404 ? '没有弹幕归档。' : `弹幕资源读取失败（HTTP ${response.status}）。`),
      {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      },
    );
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('弹幕资源超过内存预算，请缩短选区或稍后重试。');
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('弹幕资源超过内存预算，请缩短选区。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {bytes, response};
}

export async function readJson(url, options) {
  const {bytes} = await boundedFetch(url, {limit: 4 * 1024 * 1024, ...options});
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function archiveParts(index, key) {
  if (index.schemaVersion !== 1) throw new Error('弹幕归档索引版本不支持。');
  const entries = [
    ...(index.sessions ?? []).map(item => ({...item, snapshot: false})),
    ...(index.live ?? []).map(item => ({...item, snapshot: true})),
  ].filter(item => item.live_key === key);
  if (!entries.length) throw new Error('没有弹幕归档：此场次尚未收录。');
  // Archive partitions are independent of replay parts. Prefer the sealed copy
  // if index publication briefly includes both versions of the same partition.
  return entries.filter((item, i) => entries.findIndex(other => other.part === item.part) === i);
}

async function archiveFile(part, options) {
  const url = publicUrl(part.path, 'live-archive/');
  const checkSize = size => {
    if (!(size > 8 && size <= MAX_FILE_BYTES)) throw new Error('弹幕归档大小无效或超过内存预算。');
    if (!part.snapshot && part.bytes !== undefined && size !== part.bytes)
      throw new Error('弹幕归档读取期间发生变化，请重试。');
  };
  if (
    part.snapshot ||
    (Number.isInteger(part.bytes) && part.bytes > 8 && part.bytes <= Math.min(WHOLE_FILE_BYTES, MAX_FILE_BYTES))
  ) {
    // Freeze live objects; small sealed files also avoid sequential Range round trips.
    const {bytes} = await boundedFetch(url, options);
    checkSize(bytes.byteLength);
    return bytes.buffer;
  }
  const {response, bytes} = await boundedFetch(url, {...options, headers: {Range: 'bytes=0-0'}});
  if (response.status === 200) {
    checkSize(bytes.byteLength);
    return bytes.buffer;
  }
  const size = Number(response.headers.get('content-range')?.split('/')[1]);
  checkSize(size);
  const etag = response.headers.get('etag');
  const handle = signal => ({
    byteLength: size,
    withSignal: handle,
    async slice(start, end = size) {
      signal?.throwIfAborted();
      const {bytes, response} = await boundedFetch(url, {
        ...options,
        signal,
        headers: {Range: `bytes=${start}-${end - 1}`, ...(etag ? {'If-Match': etag} : {})},
      });
      if (response.status !== 206 || bytes.length !== end - start || (etag && response.headers.get('etag') !== etag))
        throw new Error('弹幕归档读取期间发生变化，请重试。');
      return bytes.buffer;
    },
  });
  return handle(options.signal);
}

export async function readDanmaku(file, options) {
  return (await import('./parquet.js')).readDanmaku(file, options);
}

// Read the index and first archive footer while media is downloaded. Keep at
// most one prefetched file (live snapshots must still be fetched atomically).
// Row payloads are selected only after the exact native media clock is known.
export async function prepareComments(record, {signal, fetcher = fetch} = {}) {
  const options = {signal, fetcher};
  const index = await retryOpen(
    () => readJson(publicUrl(`live-archive/v1/${record.room}/index.json`), options),
    signal,
  );
  const parts = archiveParts(index, record.key);
  const {readMetadata} = await import('./parquet.js');
  let file;
  const metadata = await retryOpen(async () => {
    file ??= await archiveFile(parts[0], options);
    return readMetadata(file);
  }, signal);
  return {parts, file, metadata};
}

export async function loadComments(record, {origin, start, end, adjustment = 0, signal, fetcher = fetch, prepared}) {
  const options = {signal, fetcher};
  const archive = await (prepared ?? prepareComments(record, options));
  const events = [];
  let retainedBytes = 0;
  const from = start + origin + PLAYBACK_LATENCY - adjustment;
  const to = end + origin + PLAYBACK_LATENCY - adjustment;
  for (const [i, part] of archive.parts.entries()) {
    signal?.throwIfAborted();
    const file = i === 0 ? archive.file : await archiveFile(part, options);
    const rows = await readDanmaku(file, {from, to, signal, metadata: i === 0 ? archive.metadata : undefined});
    for (const row of rows) {
      retainedBytes += String(row.text).length * 2 + 128;
      if (retainedBytes > 16 * 1024 * 1024) throw new Error('弹幕文字超过内存预算，请缩短选区。');
      events.push({...row, time: commentTime(row, origin, adjustment), order: events.length});
    }
    if (events.length > MAX_EVENTS) throw new Error('选区内弹幕过多，请缩短选区。');
  }
  return events.sort((a, b) => a.time - b.time || a.order - b.order);
}

// One export owns its snapshot generations, temporary files and row-group cache.
// Only demanded windows refresh live files; consumed windows stay committed.
export function createCommentReader(
  record,
  {signal, fetcher = fetch, prepared, createTemporary, metrics, now = Date.now, wait = waitForRetry} = {},
) {
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const options = {signal, fetcher};
  const archive = Promise.resolve(prepared ?? prepareComments(record, options));
  void archive.catch(() => {});
  const opened = new Map(),
    temporary = [],
    cache = new Map();
  let cachedBytes = 0,
    closed = false,
    generation = 0,
    reading = Promise.resolve();
  async function open(part, entry, readOptions = options) {
    const finish = metrics?.start('archiveOpen');
    try {
      // Once received, even a live response belongs to this export. A metadata or
      // temporary-storage failure must not replace it with a newer snapshot.
      entry.file ??= await archiveFile(part, readOptions);
      let file = entry.file;
      const {readMetadata, danmakuBounds, snapshotCoverage} = await import('./parquet.js');
      const metadata = (entry.metadata ??= await readMetadata(file));
      if (file.withSignal) file = file.withSignal(signal);
      if (file instanceof ArrayBuffer && createTemporary) {
        const storage = await createTemporary({signal});
        temporary.push(storage);
        let writable;
        try {
          writable = await storage.handle.createWritable();
          await writable.write({type: 'write', position: 0, data: new Uint8Array(file)});
          await writable.close();
          writable = null;
          const blob = await storage.handle.getFile();
          file = {byteLength: blob.size, slice: (from, to) => blob.slice(from, to).arrayBuffer()};
        } catch (error) {
          await writable?.abort().catch(() => {});
          try {
            await storage.remove();
            temporary.splice(temporary.indexOf(storage), 1);
          } catch {
            // Keep ownership so close() can retry cleanup without replacing the
            // original read/write failure with a cleanup error.
          }
          throw error;
        }
        entry.storage = storage;
      }
      entry.file = file;
      entry.bounds = danmakuBounds(metadata);
      entry.coverage = snapshotCoverage(metadata);
      return entry;
    } finally {
      finish?.();
    }
  }
  function openNeeded(index, part, initial) {
    let entry = opened.get(index);
    if (!entry)
      opened.set(
        index,
        (entry = {id: ++generation, ...(index === 0 ? {file: initial.file, metadata: initial.metadata} : {})}),
      );
    if (!entry.promise) {
      entry.promise = retryOpen(() => open(part, entry), signal)
        .then(result => {
          if (index === 0) initial.file = result.file;
          return result;
        })
        .catch(error => {
          entry.promise = null;
          throw error;
        });
    }
    return entry.promise;
  }
  async function discard(entry) {
    if (entry.storage) {
      await entry.storage.remove();
      temporary.splice(temporary.indexOf(entry.storage), 1);
      entry.storage = null;
    }
    for (const [key, value] of cache) {
      if (!key.startsWith(`${entry.id}:`)) continue;
      cachedBytes -= value.size;
      cache.delete(key);
    }
  }
  async function refresh(index, initial, entry, to) {
    const finish = metrics?.start('archiveRefreshWait');
    // Poll no later than 30 s past the requested platform time, and never spend
    // more than 30 s on one demand (including network I/O). An old window still
    // gets one immediate attempt, since the snapshot may already have advanced.
    const deadline = Math.min(now() + 30000, to * 1000 + 30000);
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), deadline > now() ? deadline - now() : 30000);
    const readOptions = {...options, signal: AbortSignal.any([signal, budget.signal])};
    let candidate;
    try {
      for (;;) {
        signal.throwIfAborted();
        const parts = archiveParts(
          await retryOpen(
            () => readJson(publicUrl(`live-archive/v1/${record.room}/index.json`), readOptions),
            readOptions.signal,
          ),
          record.key,
        );
        const part = parts.find(part => part.part === initial.parts[index].part);
        for (const next of parts) if (!initial.parts.some(part => part.part === next.part)) initial.parts.push(next);
        if (part) {
          candidate = {id: ++generation};
          try {
            metrics?.add('archiveRefreshes');
            await retryOpen(() => open(part, candidate, readOptions), readOptions.signal);
            if (!part.snapshot || candidate.coverage >= entry.coverage) {
              await discard(entry);
              entry = candidate;
              entry.promise = Promise.resolve(entry);
              opened.set(index, entry);
              initial.parts[index] = part;
              if (index === 0) {
                initial.file = entry.file;
                initial.metadata = entry.metadata;
              }
            } else await discard(candidate);
          } catch (error) {
            // Sealing removes the live object before the replacement index is
            // published. Keep the last usable snapshot during that brief 404.
            if (!(part.snapshot && error.status === 404)) throw error;
          }
          candidate = null;
        }
        if (!initial.parts[index].snapshot || entry.coverage >= to || now() >= deadline) break;
        await wait(Math.min(10000, deadline - now()), readOptions.signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!budget.signal.aborted || error !== budget.signal.reason) throw error;
    } finally {
      clearTimeout(timer);
      try {
        if (candidate && candidate !== entry) await discard(candidate);
      } finally {
        finish?.();
      }
    }
    metrics?.gauge('archiveLagMs', initial.parts[index].snapshot ? Math.max(0, (to - entry.coverage) * 1000) : 0);
    return entry;
  }
  function readGroup(key, size, load) {
    if (cache.has(key)) {
      const entry = cache.get(key);
      cache.delete(key);
      cache.set(key, entry);
      return entry.promise;
    }
    const entry = {size: Math.max(1024, size), promise: null};
    const trim = () => {
      while (cachedBytes > 16 * 1024 * 1024 && cache.size) {
        const oldest = cache.keys().next().value;
        cachedBytes -= cache.get(oldest).size;
        cache.delete(oldest);
      }
    };
    const remove = () => {
      if (cache.get(key) === entry) {
        cachedBytes -= entry.size;
        cache.delete(key);
      }
    };
    entry.promise = Promise.resolve()
      .then(load)
      .then(
        values => {
          if (cache.get(key) === entry) {
            cachedBytes -= entry.size;
            entry.size = Math.max(
              entry.size,
              values.reduce((bytes, row) => bytes + String(row.text).length * 2 + 128, 0),
            );
            cachedBytes += entry.size;
            trim();
          }
          return values;
        },
        error => {
          remove();
          throw error;
        },
      );
    void entry.promise.catch(() => {});
    cache.set(key, entry);
    cachedBytes += entry.size;
    trim();
    return entry.promise;
  }

  async function read({origin, start, end, adjustment = 0, prefetch = false}) {
    const finish = metrics?.start('archiveRead');
    try {
      if (closed) throw new Error('弹幕读取器已关闭。');
      signal?.throwIfAborted();
      const initial = await archive;
      if (closed) throw new Error('弹幕读取器已关闭。');
      const from = start + origin + PLAYBACK_LATENCY - adjustment;
      const to = end + origin + PLAYBACK_LATENCY - adjustment;
      const events = [];
      let bytes = 0;
      // Consume the current part before opening later ones. No batch-wide
      // metadata barrier or speculative archive requests on the video path.
      for (const [index, part] of initial.parts.entries()) {
        if (closed) throw new Error('弹幕读取器已关闭。');
        signal?.throwIfAborted();
        let entry = await openNeeded(index, part, initial);
        if (part.snapshot && entry.coverage < to) {
          if (prefetch) return null;
          entry = await refresh(index, initial, entry, to);
        }
        const {file, metadata, bounds} = entry;
        if (bounds.to < from || bounds.from > to) continue;
        const rows = await readDanmaku(file, {
          from,
          to,
          signal,
          metadata,
          readGroup: (group, size, load) => readGroup(`${entry.id}:${group}`, size, load),
        });
        for (const row of rows) {
          const time = commentTime(row, origin, adjustment);
          if (time < start || time >= end) continue;
          bytes += String(row.text).length * 2 + 128;
          if (bytes > 16 * 1024 * 1024 || events.length >= MAX_EVENTS)
            throw new Error('弹幕窗口超过内存预算，请缩短选区。');
          events.push({...row, time, order: events.length});
        }
      }
      return events.sort((a, b) => a.time - b.time || a.order - b.order);
    } finally {
      finish?.();
    }
  }
  return {
    read(window) {
      // Serialize refresh/replacement with reads so a temporary file is never
      // removed while another window still reads it. Failed reads remain retryable.
      const task = reading.then(() => read(window));
      reading = task.then(
        () => {},
        () => {},
      );
      return task;
    },
    async close() {
      closed = true;
      controller.abort();
      await reading;
      await Promise.allSettled([...opened.values()].map(entry => entry.promise));
      cache.clear();
      opened.clear();
      await Promise.all(temporary.map(item => item.remove()));
      temporary.length = 0;
      const initial = await archive.catch(() => null);
      if (initial) initial.file = initial.metadata = null;
    },
  };
}
