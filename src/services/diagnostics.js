import {redactText} from '../shared/log-redaction.js';

const idle = Object.freeze({stage() {}, progress() {}, fail() {}});
function text(value, limit) {
  if (typeof value !== 'string') return undefined;
  // Errors from media/network libraries may embed signed URLs with unknown key
  // names. Outgoing diagnostics keep their origin/path, never query credentials.
  return redactText(value.slice(0, 65536)).replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
    catch { return raw.split(/[?#]/, 1)[0]; }
  }).slice(0, limit);
}
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function pageIdentity(value) {
  try {
    const url = new URL(value);
    if (!['www.bilibili.com', 'bilibili.com', 'live.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return undefined;
    const part = url.searchParams.get('p');
    return `${url.origin}${url.pathname}${part && /^\d+$/.test(part) ? `?p=${part}` : ''}`.slice(0, 1024);
  } catch { return undefined; }
}

function snapshot(details) {
  const record = details.record || {}, selection = details.selection || {};
  return {
    page: pageIdentity(details.pageUrl), mode: text(details.mode, 32),
    record: {
      kind: text(record.kind || 'recording', 32), key: text(record.key, 128),
      room: number(record.room), bvid: text(record.bvid, 64), aid: number(record.aid),
      cid: number(record.cid), part: number(record.part), start: number(record.start), end: number(record.end),
      live: typeof record.live === 'boolean' ? record.live : undefined,
    },
    selection: {start: number(selection.start), end: number(selection.end)},
    estimatedBytes: number(details.estimatedBytes),
  };
}

function transfer(request, endpoint, body) {
  return new Promise(resolve => {
    try {
      request({method: 'POST', url: endpoint, anonymous: true, timeout: 8000,
        headers: {'Content-Type': 'application/json'}, data: body,
        onload: result => resolve(result.status === 429 || result.status >= 500),
        onerror: () => resolve(true), ontimeout: () => resolve(true), onabort: () => resolve(false),
      });
    } catch { resolve(false); }
  });
}

export function createDiagnosticReporter({endpoint = '', request, version = '0.0.0',
  userAgent = '', online = () => globalThis.navigator?.onLine !== false,
  id = () => crypto.randomUUID(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let pending = 0;
  async function send(body) {
    try {
      if (await transfer(request, endpoint, body)) {
        await wait(1000);
        if (online()) await transfer(request, endpoint, body);
      }
    } catch { /* Diagnostics must never become a user operation failure. */ }
    finally { pending--; }
  }
  return {
    begin(action, details = {}) {
      if (!endpoint || typeof request !== 'function') return idle;
      // All values are copied before asynchronous work or route changes begin.
      const context = {...snapshot(details), stage: 'starting'};
      let reported = false;
      return {
        stage(value) { context.stage = text(value, 64); },
        progress(value) {
          context.stage = text(value.phase, 64) || context.stage;
          context.progress = {
            fraction: number(value.progress), bytes: number(value.bytes), written: number(value.written),
            estimatedBytes: number(value.estimatedBytes), attempt: number(value.attempt),
          };
        },
        fail(error, signal) {
          if (reported || signal?.aborted || error?.name === 'AbortError') return;
          reported = true;
          try {
            if (!online() || pending >= 2) return;
            const payload = {
              id: id(), source: 'bella-live-clip', event: `${action}_failed`, level: 'error', version,
              message: text(error?.message || String(error), 4096) || 'Unknown error',
              context: {...context, browser: text(userAgent, 512), errorName: text(error?.name, 128),
                stack: text(error?.stack, 8192)},
            };
            // Bounded allowlisted strings normally fit; JSON escaping may expand them.
            let body = JSON.stringify(payload);
            if (new TextEncoder().encode(body).byteLength > 65536) {
              payload.context.stack = undefined; payload.context.truncated = true;
              payload.message = payload.message.slice(0, 1024); body = JSON.stringify(payload);
            }
            if (new TextEncoder().encode(body).byteLength > 65536) return;
            pending++;
            void send(body);
          } catch { /* No UI, console output, storage or recursive reporting. */ }
        },
      };
    },
  };
}
