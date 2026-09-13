function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function createLibraryLoader({ api, schedules }) {
  const cache = new Map();
  const requests = new Map();
  const controllers = new Set();

  function load(member, { refresh = false, signal } = {}) {
    const id = member.id;
    const cached = cache.get(id);
    if (!refresh && cached?.ready) return waitFor(Promise.resolve(cached), signal);

    let request = requests.get(id);
    if (refresh) request?.controller.abort();
    if (!request || refresh) {
      const controller = new AbortController();
      const promise = (async () => {
        let records = cached?.records, liveFailed = false;
        if (refresh || !cached || cached.liveFailed) {
          const [history, current] = await Promise.all([
            api.history(member, controller.signal),
            api.current(member, controller.signal, { allowOffline: true }).catch(error => {
              controller.signal.throwIfAborted();
              if (error.name === 'AbortError') throw error;
              liveFailed = true;
              return null;
            }),
          ]);
          records = current ? [current, ...history.filter(record => record.key !== current.key)] : history;
        }
        controller.signal.throwIfAborted();
        const result = await schedules.enrich(records, { signal: controller.signal, refresh });
        controller.signal.throwIfAborted();
        const next = { records: result.records, failed: result.failed, liveFailed, ready: !result.failed && !liveFailed };
        cache.set(id, next);
        return next;
      })();
      request = { promise, controller };
      requests.set(id, request);
      controllers.add(controller);
      const cleanup = () => {
        if (requests.get(id)?.promise === promise) requests.delete(id);
        controllers.delete(controller);
      };
      promise.then(cleanup, cleanup);
    }
    return waitFor(request.promise, signal);
  }

  function preload(member) {
    return load(member).catch(() => null);
  }

  function get(member) {
    return cache.get(member.id) || null;
  }

  function abortAll() {
    controllers.forEach(controller => controller.abort());
  }

  return { load, preload, get, abortAll };
}
