export class RequestError extends Error {
  constructor(message, {retryable = false, status} = {}) {
    super(message); this.name = 'RequestError'; this.retryable = retryable; this.status = status;
  }
}

export function waitForRetry(delay, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, {once: true});
  });
}

// Keep transient failures inside the read, before a demuxer or writable sees them.
// Completed segments and the open output stay alive until recovery or cancellation.
export async function requestWithRetry(api, url, options = {}, {onRetry = () => {}, wait = waitForRetry} = {}) {
  const {signal} = options;
  let attempt = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try { return await api.request(url, options); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof RequestError) || !error.retryable) throw error;
        const delay = Math.min(1000 * 2 ** Math.min(attempt++, 4), 10000);
        onRetry({attempt, delay});
        await wait(delay, signal);
      }
    }
  } finally { if (attempt) onRetry(null); }
}
