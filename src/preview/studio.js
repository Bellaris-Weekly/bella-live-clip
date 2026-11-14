export const STUDIO = 'https://studio.bk0717.com';
export const TOKEN_KEY = 'studio.token';

export function startLink({target, location, set, version}) {
  if (location.origin !== STUDIO || location.pathname !== '/plugin/link') return;
  const receive = event => {
    if (event.source !== target || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.channel !== 'bella-plugin-link' || typeof data.nonce !== 'string' || !data.nonce) return;
    const reply = type =>
      target.postMessage({channel: 'bella-plugin-link', type, nonce: data.nonce, version}, location.origin);
    if (data.type === 'hello') reply('ready');
    if (
      data.type === 'token' &&
      typeof data.token === 'string' &&
      data.token &&
      typeof data.name === 'string' &&
      (Number.isFinite(data.expires_at) || (typeof data.expires_at === 'string' && data.expires_at.length > 0))
    ) {
      set(TOKEN_KEY, {token: data.token, name: data.name, expires_at: data.expires_at});
      reply('linked');
    }
  };
  target.addEventListener('message', receive);
  return () => target.removeEventListener('message', receive);
}

export function createStudioClient({get, set, request: gmRequest, now = Date.now}) {
  let identity = get(TOKEN_KEY, null),
    offset = 0,
    checkedAt = -Infinity,
    clockPending,
    validation;
  const listeners = new Set();
  const emit = () => listeners.forEach(listener => listener(identity));
  function logout() {
    identity = null;
    set(TOKEN_KEY, null);
    emit();
  }
  async function request(path, {method = 'GET', body, signal} = {}) {
    signal?.throwIfAborted();
    const token = identity?.token;
    if (!token) throw new Error('请先登录');
    return new Promise((resolve, reject) => {
      let handle,
        settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => {
        finish(reject, signal.reason);
        handle?.abort();
      };
      const multipart = body instanceof FormData;
      const fail = () => finish(reject, new Error('创作台连接失败，请稍后重试'));
      // Tampermonkey's anonymous fetch transport can ignore its timeout option.
      const timer = setTimeout(() => {
        fail();
        handle?.abort();
      }, 20000);
      signal?.addEventListener('abort', abort, {once: true});
      try {
        handle = gmRequest({
          method,
          url: `${STUDIO}/api${path}`,
          anonymous: true,
          timeout: 20000,
          headers: {Authorization: `Bearer ${token}`, ...(!multipart ? {'Content-Type': 'application/json'} : {})},
          data: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
          responseType: 'json',
          onload(response) {
            if (settled) return;
            if (response.status === 401 && identity?.token === token) logout();
            let data = response.response;
            if (!data && response.responseText) {
              try {
                data = JSON.parse(response.responseText);
              } catch {
                /* Error below includes HTTP status. */
              }
            }
            if (response.status < 200 || response.status >= 300) {
              const detail = data?.detail;
              const error = new Error(
                typeof detail === 'string'
                  ? detail
                  : // FastAPI validation errors arrive as a list of field problems.
                    detail?.message ||
                      (Array.isArray(detail) && detail.map(item => `${item.loc?.at(-1)}: ${item.msg}`).join('；')) ||
                      `创作台请求失败（${response.status}）`,
              );
              error.status = response.status;
              error.code = detail?.code;
              error.retryAfter = detail?.retry_after;
              error.current = detail?.current;
              finish(reject, error);
            } else finish(resolve, data);
          },
          onerror: fail,
          ontimeout: fail,
          onabort: fail,
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }
  function syncClock(force = false) {
    if (clockPending) return clockPending;
    if (!identity || (!force && now() - checkedAt < 600000)) return Promise.resolve();
    const start = now();
    checkedAt = start;
    clockPending = request('/time')
      .then(data => {
        if (!Number.isFinite(data?.now_ms)) throw new Error('创作台时间无效');
        offset = data.now_ms - (start + now()) / 2;
      })
      .finally(() => {
        clockPending = null;
      });
    return clockPending;
  }
  function check() {
    const stored = get(TOKEN_KEY, null);
    const changed = stored?.token !== identity?.token;
    if (changed) {
      identity = stored;
      emit();
    }
    if (!identity) return Promise.resolve();
    if (validation && !changed) return validation;
    const token = identity.token;
    const pending = request('/me')
      .then(me => {
        if (identity?.token !== token) return;
        identity = {...identity, name: me.name, sub: me.sub};
        set(TOKEN_KEY, identity);
        emit();
        return syncClock(changed || checkedAt === -Infinity);
      })
      .finally(() => {
        if (validation === pending) validation = null;
      });
    validation = pending;
    return pending;
  }
  return {
    request,
    check,
    logout,
    syncClock,
    // Whole milliseconds: the studio API rejects fractional timestamps.
    serverNow: () => Math.round(now() + offset),
    identity: () => identity,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
