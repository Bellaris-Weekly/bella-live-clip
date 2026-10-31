const MEDIA_HOST = /(^|\.)(bilivideo\.com|bilivideo\.cn|acgvideo\.com|hdslb\.com)$/;
const RESPONSE_TIMEOUT = 15000, BODY_TIMEOUT = 45000, DISABLE_AFTER = 3, RETRY_DIRECT_AFTER = 60000;

export function isMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && MEDIA_HOST.test(url.hostname);
  } catch { return false; }
}

// Preview playlists are roughly one small fragment per second, so per-request
// overhead dominates. Anonymous page fetches skip the userscript manager's
// message channel, like the platform's own player; its CDN allows any origin.
// Anything unexpected is retried once through the manager, and repeated
// failures pause it for a while so a blocked network path costs little. The CDN
// does not expose response headers to pages, so callers needing them stay on the
// manager.
export function createMediaRequest({pageFetch, fallback, timeout = RESPONSE_TIMEOUT, bodyTimeout = BODY_TIMEOUT, now = Date.now}) {
  let failures = 0, pausedUntil = 0;
  const direct = (url, {auth, form, needHeaders}) => {
    if (!pageFetch || auth || form || needHeaders || !isMediaUrl(url) || now() < pausedUntil) return false;
    return true;
  };
  async function read(url, {type = 'text', range = null, signal}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once: true});
    const expire = () => controller.abort(new Error('媒体直连超时。'));
    let timer = setTimeout(expire, timeout);
    try {
      const response = await pageFetch(url, {mode: 'cors', credentials: 'omit', signal: controller.signal,
        headers: range ? {Range: `bytes=${range.offset}-${range.offset + range.length - 1}`} : {}});
      // A connection can also stall part way through the body.
      clearTimeout(timer);
      timer = setTimeout(expire, bodyTimeout);
      if (!response.ok || range && response.status !== 206) throw new Error(`媒体直连失败（HTTP ${response.status}）。`);
      return {data: type === 'text' ? await response.text() : await response.arrayBuffer(), url: response.url || url};
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return async (url, options = {}) => {
    if (!direct(url, options)) return fallback(url, options);
    options.signal?.throwIfAborted();
    try {
      const result = await read(url, options);
      failures = 0;
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (++failures >= DISABLE_AFTER) { failures = 0; pausedUntil = now() + RETRY_DIRECT_AFTER; }
      return fallback(url, options);
    }
  };
}
