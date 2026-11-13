import {boundedFetch} from './archive.js';
import {isSuperChat} from './super-chat.js';

export function avatarUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !/^i\d+\.hdslb\.com$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/bfs\/(face|garb|baselabs)\//.test(url.pathname)
    )
      return null;
    url.protocol = 'https:';
    url.search = url.hash = '';
    // CDN thumbnailing bounds decode work as well as retained bitmap size.
    url.pathname = url.pathname.split('@')[0] + '@96w_96h_1c.webp';
    return url.href;
  } catch {
    return null;
  }
}

// Optional resources never hold the media clock. Three downloads, a bounded
// queue/cache, static thumbnails and a failed-request cooldown per source.
export function createAvatarCache({signal, fetcher, metrics, size = 48, maxEntries = 128} = {}) {
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const entries = new Map(),
    queue = [];
  let active = 0,
    closed = false,
    pinned = new Set();
  function pump() {
    while (!closed && !signal.aborted && active < 3 && queue.length) {
      const [url, entry] = queue.shift();
      active++;
      const finish = metrics?.start('avatarFetch');
      entry.promise = (async () => {
        const timeout = AbortSignal.timeout(3000);
        const {bytes, response} = await boundedFetch(url, {
          signal: AbortSignal.any([signal, timeout]),
          fetcher,
          limit: 2 * 1024 * 1024,
          operation: 'avatarFetch',
          referrerPolicy: 'no-referrer',
        });
        const image = await createImageBitmap(
          new Blob([bytes], {type: response.headers.get('content-type') || 'image/webp'}),
          {resizeWidth: Math.ceil(size), resizeHeight: Math.ceil(size), resizeQuality: 'high'},
        );
        if (closed || signal.aborted || entries.get(url) !== entry) image.close();
        else entry.image = image;
      })()
        .catch(() => {
          entry.retryAt = Date.now() + 60000;
          metrics?.add('avatarFailures');
        })
        .finally(() => {
          active--;
          entry.pending = false;
          finish?.();
          pump();
        });
    }
  }
  const close = () => {
    closed = true;
    controller.abort();
    queue.length = 0;
    for (const entry of entries.values()) entry.image?.close();
    entries.clear();
  };
  signal.addEventListener(
    'abort',
    () => {
      if (!closed) close();
    },
    {once: true},
  );
  return {
    prefetch(events, retained = events) {
      if (closed || signal.aborted) return;
      pinned = new Set(
        retained
          .filter(isSuperChat)
          .map(event => avatarUrl(event.face))
          .filter(Boolean),
      );
      for (const event of events.filter(isSuperChat)) {
        const url = avatarUrl(event.face);
        if (!url) continue;
        const old = entries.get(url);
        if (old?.image || old?.pending || old?.retryAt > Date.now()) continue;
        if (!old && entries.size >= maxEntries) {
          const idle = [...entries].find(([key, value]) => !pinned.has(key) && !value.pending);
          if (!idle) continue;
          idle[1].image?.close();
          entries.delete(idle[0]);
        }
        const entry = {pending: true};
        entries.set(url, entry);
        queue.push([url, entry]);
      }
      pump();
    },
    get(face) {
      return entries.get(avatarUrl(face))?.image ?? null;
    },
    async settled() {
      while (active || queue.length) await Promise.all([...entries.values()].map(entry => entry.promise));
    },
    close,
  };
}
