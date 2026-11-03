// Preserve input order, bound in-flight work, and settle siblings before returning
// an error so callers can safely release shared image/file resources.
export async function mapConcurrent(items, concurrency, task, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const results = new Array(items.length);
  let next = 0;
  try {
    await Promise.all(
      Array.from({length: Math.min(concurrency, items.length)}, async () => {
        try {
          while (!controller.signal.aborted && next < items.length) {
            const index = next++;
            results[index] = await task(items[index], index, controller.signal);
          }
        } catch (error) {
          controller.abort(error);
        }
      }),
    );
    controller.signal.throwIfAborted();
    return results;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
