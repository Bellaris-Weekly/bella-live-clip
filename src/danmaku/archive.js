import {commentTime, PLAYBACK_LATENCY} from './clock.js';

export const ARCHIVE_BASE = 'https://data.bellaris.fans/';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 100000;

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
  const timer = setTimeout(() => controller.abort(new Error('弹幕资源读取超时，请重试。')), 30000);
  try {
    return await readBounded(url, {...options, signal: controller.signal});
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError) throw new Error('弹幕资源读取失败，请检查网络后重试。', {cause: error});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function readBounded(url, {signal, headers, limit = MAX_FILE_BYTES, fetcher = fetch}) {
  const response = await fetcher(url, {signal, headers, credentials: 'omit', cache: 'no-store'});
  if (!response.ok)
    throw new Error(response.status === 404 ? '没有弹幕归档。' : `弹幕资源读取失败（HTTP ${response.status}）。`);
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
  if (part.snapshot) {
    // A live object can be replaced between any two Range requests.
    const {bytes} = await boundedFetch(url, options);
    return bytes.buffer;
  }
  const {response, bytes} = await boundedFetch(url, {...options, headers: {Range: 'bytes=0-0'}});
  if (response.status === 200) return bytes.buffer;
  const size = Number(response.headers.get('content-range')?.split('/')[1]);
  if (!(size > 8 && size <= MAX_FILE_BYTES)) throw new Error('弹幕归档大小无效或超过内存预算。');
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
  const index = await readJson(publicUrl(`live-archive/v1/${record.room}/index.json`), options);
  const parts = archiveParts(index, record.key);
  const file = await archiveFile(parts[0], options);
  const {readMetadata} = await import('./parquet.js');
  const metadata = await readMetadata(file);
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

// One export owns its snapshot files and small row-group cache. Live objects are
// frozen once, then read from temporary disk instead of fetched again per window.
export function createCommentReader(record, {signal, fetcher = fetch, prepared, createTemporary} = {}) {
  const options = {signal, fetcher};
  const archive = Promise.resolve(prepared ?? prepareComments(record, options));
  void archive.catch(() => {});
  const opened = new Map(),
    temporary = [],
    cache = new Map();
  let cachedBytes = 0,
    closed = false;
  async function open(index, part, initial) {
    let file = index === 0 ? initial.file : await archiveFile(part, options);
    const {readMetadata} = await import('./parquet.js');
    const metadata = index === 0 ? initial.metadata : await readMetadata(file);
    if (file.withSignal) file = file.withSignal(signal);
    if (file instanceof ArrayBuffer && createTemporary) {
      const storage = await createTemporary({signal});
      temporary.push(storage);
      const writable = await storage.handle.createWritable();
      try {
        await writable.write({type: 'write', position: 0, data: new Uint8Array(file)});
        await writable.close();
      } catch (error) {
        await writable.abort();
        throw error;
      }
      const blob = await storage.handle.getFile();
      file = {byteLength: blob.size, slice: (from, to) => blob.slice(from, to).arrayBuffer()};
      if (index === 0) initial.file = file;
    }
    return {file, metadata};
  }
  function readGroup(key, size, load) {
    if (cache.has(key)) {
      const entry = cache.get(key);
      cache.delete(key);
      cache.set(key, entry);
      return entry.promise;
    }
    while (cache.size && (cache.size >= 2 || cachedBytes + size > 16 * 1024 * 1024)) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).size;
      cache.delete(oldest);
    }
    const promise = load();
    void promise.catch(() => {});
    cache.set(key, {promise, size});
    cachedBytes += size;
    return promise;
  }
  return {
    async read({origin, start, end, adjustment = 0}) {
      if (closed) throw new Error('弹幕读取器已关闭。');
      signal?.throwIfAborted();
      const initial = await archive;
      const from = start + origin + PLAYBACK_LATENCY - adjustment;
      const to = end + origin + PLAYBACK_LATENCY - adjustment;
      const events = [];
      let bytes = 0;
      for (const [index, part] of initial.parts.entries()) {
        signal?.throwIfAborted();
        if (!opened.has(index)) opened.set(index, open(index, part, initial));
        const {file, metadata} = await opened.get(index);
        const rows = await readDanmaku(file, {
          from,
          to,
          signal,
          metadata,
          readGroup: (group, size, load) => readGroup(`${index}:${group}`, size, load),
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
    },
    async close() {
      closed = true;
      await Promise.allSettled([...opened.values()]);
      cache.clear();
      opened.clear();
      await Promise.all(temporary.map(item => item.remove()));
      temporary.length = 0;
      const initial = await archive.catch(() => null);
      if (initial) initial.file = initial.metadata = null;
    },
  };
}
