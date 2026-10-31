function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

const FRESH_FOR = 5 * 60 * 1000,
  KEEP_FOR = 24 * 60 * 60 * 1000;

// `store` shares finished lists between tabs: a recent one avoids the requests
// entirely, and an older one is shown at once while the list refreshes behind it.
export function createLibraryLoader({
  api,
  schedules,
  backgroundEnrichment = false,
  onUpdate = () => {},
  store = null,
  now = Date.now,
}) {
  const cache = new Map();
  const requests = new Map();
  const controllers = new Set();

  function get(member) {
    const id = member.id;
    if (!cache.has(id)) {
      const saved = store?.read(id);
      const age = now() - saved?.time;
      if (Array.isArray(saved?.records) && age >= 0 && age < KEEP_FOR) {
        cache.set(id, {
          records: saved.records,
          failed: false,
          liveFailed: false,
          ready: age < FRESH_FOR,
          stale: age >= FRESH_FOR,
        });
      }
    }
    return cache.get(id) || null;
  }

  function load(member, {refresh = false, signal} = {}) {
    const id = member.id;
    const cached = get(member);
    if (!refresh && cached?.ready) return waitFor(Promise.resolve(cached), signal);

    let request = requests.get(id);
    if (refresh) request?.controller.abort();
    if (!request || refresh) {
      const controller = new AbortController();
      let resolveEarly, rejectEarly;
      const early = new Promise((resolve, reject) => {
        resolveEarly = resolve;
        rejectEarly = reject;
      });
      early.catch(() => {});
      const promise = (async () => {
        let records = cached?.records,
          liveFailed = false;
        if (refresh || !cached || cached.liveFailed || cached.stale) {
          const [history, current] = await Promise.all([
            api.history(member, controller.signal),
            api.current(member, controller.signal, {allowOffline: true}).catch(error => {
              controller.signal.throwIfAborted();
              if (error.name === 'AbortError') throw error;
              liveFailed = true;
              return null;
            }),
          ]);
          records = current ? [current, ...history.filter(record => record.key !== current.key)] : history;
        }
        controller.signal.throwIfAborted();
        const base = {records, failed: false, liveFailed, ready: false, pending: true};
        if (backgroundEnrichment) cache.set(id, base);
        resolveEarly(base);
        const result = await schedules.enrich(records, {signal: controller.signal, refresh});
        controller.signal.throwIfAborted();
        const next = {records: result.records, failed: result.failed, liveFailed, ready: !result.failed && !liveFailed};
        cache.set(id, next);
        if (next.ready) store?.write(id, {time: now(), records: next.records});
        if (backgroundEnrichment) onUpdate(member, next);
        return next;
      })();
      promise.catch(rejectEarly);
      request = {promise, early, controller};
      requests.set(id, request);
      controllers.add(controller);
      const cleanup = () => {
        if (requests.get(id)?.promise === promise) requests.delete(id);
        controllers.delete(controller);
      };
      promise.then(cleanup, cleanup);
    }
    return waitFor(backgroundEnrichment ? request.early : request.promise, signal);
  }

  function preload(member) {
    return load(member).catch(() => null);
  }

  function abortAll() {
    controllers.forEach(controller => controller.abort());
  }

  return {load, preload, get, abortAll};
}
