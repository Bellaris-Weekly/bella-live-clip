export const BRIDGE_CHANNEL = 'bella-bridge';
export const BRIDGE_PROTOCOL = 1;

const ALLOWED_METHODS = new Set(['GET', 'PUT', 'POST']);
const ALLOWED_HEADERS = new Set(['x-upos-auth', 'content-type']);
const REQUEST_TIMEOUT_MS = 240_000;

export function isAllowedRequest({method, url, headers}) {
  if (!ALLOWED_METHODS.has(method)) return false;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' || !target.hostname.endsWith('.bilivideo.com')) return false;
  return Object.keys(headers ?? {}).every(name => ALLOWED_HEADERS.has(name.toLowerCase()));
}

export function startPageBridge({name, version, request, target}) {
  const active = new Map();
  const post = message => target.postMessage({channel: BRIDGE_CHANNEL, ...message}, target.location.origin);
  const announce = nonce => post({type: 'ready', bridge: name, version, protocol: BRIDGE_PROTOCOL, nonce});

  const handlers = {
    hello: message => announce(message.nonce),
    abort: message => active.get(message.id)?.abort(),
    request(message) {
      const {id, method, url, headers, body} = message;
      if (!isAllowedRequest(message)) {
        post({type: 'error', id, message: '请求被拒绝'});
        return;
      }
      const finish = reply => {
        active.delete(id);
        post({id, ...reply});
      };
      active.set(
        id,
        request({
          method,
          url,
          headers,
          data: body,
          anonymous: true,
          timeout: REQUEST_TIMEOUT_MS,
          onload: response => finish({type: 'response', status: response.status, text: response.responseText}),
          onerror: () => finish({type: 'error', message: '网络错误'}),
          ontimeout: () => finish({type: 'error', message: '请求超时'}),
          onabort: () => finish({type: 'error', message: '已取消'}),
        }),
      );
    },
  };

  target.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== target || event.origin !== target.location.origin) return;
    if (message?.channel !== BRIDGE_CHANNEL) return;
    if (message.to !== undefined && message.to !== name) return;
    handlers[message.type]?.(message);
  });
  announce();
}
