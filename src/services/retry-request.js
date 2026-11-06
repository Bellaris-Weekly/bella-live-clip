// About 15 s of backoff: long enough for a fragment the platform is still writing.
export const LIVE_MISSING_RETRIES = 4;

export class RequestError extends Error {
  constructor(message, {retryable = false, status} = {}) {
    super(message);
    this.name = 'RequestError';
    this.retryable = retryable;
    this.status = status;
  }
}

export function waitForRetry(delay, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, {once: true});
  });
}

// Keep transient failures inside the read, before a demuxer or writable sees them.
// Completed segments and the open output stay alive until recovery or cancellation.
export async function requestWithRetry(
  api,
  url,
  options = {},
  {onRetry = () => {}, wait = waitForRetry, limit = Infinity, missingRetries = 0} = {},
) {
  const {signal} = options;
  let attempt = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await api.request(url, options);
      } catch (error) {
        signal?.throwIfAborted();
        // A recording still in progress can list a fragment before it exists.
        const missing = error instanceof RequestError && error.status === 404 && attempt < missingRetries;
        if (!(error instanceof RequestError) || !(error.retryable || missing) || attempt >= limit) throw error;
        const delay = Math.min(1000 * 2 ** Math.min(attempt++, 4), 10000);
        onRetry({attempt, delay});
        await wait(delay, signal);
      }
    }
  } finally {
    if (attempt) onRetry(null);
  }
}
