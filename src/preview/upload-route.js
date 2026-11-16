// Kept in step with bellaris-studio frontend/src/lib/uploadRoute.ts.
const CONNECT_TIMEOUT_MS = 1500;
const UPLOAD_TIMEOUT_MS = 1500;
const PROBE_BYTES = 256 * 1024;
const MAX_PROBE_LINES = 3;
function probe(transport, request, timeout, signal) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const started = performance.now();
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      if (error) reject(error);
      else if (response?.status !== 200) reject(new Error('上传线路不可用'));
      else resolve(Math.max(0.01, performance.now() - started));
    };
    const abort = () => finish(new DOMException('选线已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('线路探测超时')), timeout);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) {
      abort();
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new DOMException('选线已取消', 'AbortError');
        return transport.request({...request, signal: controller.signal});
      })
      .then(
        response => finish(undefined, response),
        error => finish(error),
      );
  });
}
async function pickLine(lines, transport, signal) {
  if (signal?.aborted) return null;
  const candidates = Object.entries(lines).filter(([, host]) => /^[a-z0-9.-]+\.bilivideo\.com$/i.test(host));
  const reachable = await Promise.all(
    candidates.map(async ([line, host]) => {
      try {
        const cost = await probe(transport, {method: 'GET', url: `https://${host}/OK`}, CONNECT_TIMEOUT_MS, signal);
        return {line, host, cost};
      } catch {
        return null;
      }
    }),
  );
  const ranked = reachable.filter(row => row !== null).sort((a, b) => a.cost - b.cost);
  if (signal?.aborted || !ranked.length) return null;
  if (ranked.length === 1) return ranked[0].line;
  const body = new Blob([new Uint8Array(PROBE_BYTES)], {type: 'application/octet-stream'});
  let best = null;
  for (const candidate of ranked.slice(0, MAX_PROBE_LINES)) {
    if (signal?.aborted) return null;
    try {
      const cost = await probe(
        transport,
        {
          method: 'POST',
          url: `https://${candidate.host}/OK`,
          body,
          headers: {'Content-Type': 'application/octet-stream'},
        },
        UPLOAD_TIMEOUT_MS,
        signal,
      );
      if (!best || cost < best.cost) best = {line: candidate.line, cost};
    } catch {
      /* Keep reachable nodes as a fallback when POST is unsupported. */
    }
  }
  return signal?.aborted ? null : (best?.line ?? ranked[0].line);
}
export {pickLine};
