import {redactContext, redactText} from './log-redaction.js';

const MAX_BODY_BYTES = 64 * 1024;
const fields = ['id', 'source', 'event', 'level', 'version', 'message', 'context'];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: {...cors, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders},
  });
}

function error(status, code, headers) {
  return json(status, {error: code}, headers);
}

async function readBody(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        // Stop consuming immediately; a lying Content-Length cannot bypass the cap.
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validContext(value) {
  // Bound recursion for nested JSON before recursive redaction/stringification.
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (depth > 32) return false;
    if (typeof item === 'number' && !Number.isFinite(item)) return false;
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    }
  }
  return true;
}

function validLog(log) {
  if (!object(log) || Object.keys(log).length !== fields.length ||
      !fields.every(field => Object.hasOwn(log, field))) return false;
  for (const [field, limit] of [['id', 128], ['source', 64], ['event', 96]]) {
    if (typeof log[field] !== 'string' || log[field].length > limit ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(log[field])) return false;
  }
  return ['error', 'warn', 'info'].includes(log.level) &&
    typeof log.version === 'string' && log.version.length >= 1 && log.version.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._+:-]*$/.test(log.version) &&
    typeof log.message === 'string' && log.message.trim().length > 0 && log.message.length <= 16384 &&
    object(log.context) && validContext(log.context);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/v1/logs') return error(404, 'not_found');
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (request.method !== 'POST') return error(405, 'method_not_allowed', {Allow: 'POST, OPTIONS'});
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error(415, 'unsupported_media_type');
    }
    let log;
    try {
      const body = await readBody(request);
      if (body === null) return error(413, 'payload_too_large');
      log = JSON.parse(body);
    } catch {
      return error(400, 'invalid_json');
    }
    if (!validLog(log)) return error(400, 'invalid_log');
    try {
      const result = await env.LOGS_DB.prepare(`
        INSERT INTO logs (source, id, received_at, level, event, version, message, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, id) DO NOTHING
      `).bind(log.source, log.id, new Date().toISOString(), log.level, log.event,
        log.version, redactText(log.message), JSON.stringify(redactContext(log.context))).run();
      if (!result.success) return error(503, 'storage_unavailable');
      const duplicate = result.meta.changes === 0;
      return json(duplicate ? 200 : 201, {ok: true, duplicate});
    } catch {
      return error(503, 'storage_unavailable');
    }
  },
};
