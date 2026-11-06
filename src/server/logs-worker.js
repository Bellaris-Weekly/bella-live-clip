import {logsPage, startLogViewer} from './logs-page.js';
import {listLogs, downloadLogs} from './logs-query.js';
import {redactContext, redactText} from '../shared/log-redaction.js';

const MAX_BODY_BYTES = 64 * 1024;
// The endpoint is anonymous: a runaway client must not be able to fill the database.
const RATE_LIMIT = 60,
  RATE_WINDOW_MS = 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000,
  CLEANUP_CHANCE = 0.02;
const fields = ['id', 'source', 'event', 'level', 'version', 'message', 'context'];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {...cors, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders},
  });
}

function error(status, code, headers) {
  return json(status, {error: code}, headers);
}

async function readBody(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0,
    text = '';
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
  if (!object(log) || Object.keys(log).length !== fields.length || !fields.every(field => Object.hasOwn(log, field)))
    return false;
  for (const [field, limit] of [
    ['id', 128],
    ['source', 64],
    ['event', 96],
  ]) {
    if (
      typeof log[field] !== 'string' ||
      log[field].length > limit ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(log[field])
    )
      return false;
  }
  return (
    ['error', 'warn', 'info'].includes(log.level) &&
    typeof log.version === 'string' &&
    log.version.length >= 1 &&
    log.version.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._+:-]*$/.test(log.version) &&
    typeof log.message === 'string' &&
    log.message.trim().length > 0 &&
    log.message.length <= 16384 &&
    object(log.context) &&
    validContext(log.context)
  );
}

function removeExpired(database) {
  return database
    .prepare('DELETE FROM logs WHERE received_at < ?')
    .bind(new Date(Date.now() - RETENTION_MS).toISOString())
    .run();
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === '/admin') {
      if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'method_not_allowed', {Allow: 'GET, HEAD'});
      return new Response(null, {status: 308, headers: {Location: '/admin/', 'Cache-Control': 'no-store'}});
    }
    if (url.pathname === '/admin/' || url.pathname === '/admin/viewer.js') {
      if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'method_not_allowed', {Allow: 'GET, HEAD'});
      const page = url.pathname === '/admin/';
      return new Response(request.method === 'HEAD' ? null : page ? logsPage : `(${startLogViewer.toString()})();`, {
        headers: {
          'Content-Type': page ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex, nofollow',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
      });
    }
    if (url.pathname === '/admin/api/logs' || url.pathname === '/admin/api/logs/download') {
      const download = url.pathname.endsWith('/download');
      if (request.method !== 'GET' && !(download && request.method === 'HEAD'))
        return error(405, 'method_not_allowed', {Allow: download ? 'GET, HEAD' : 'GET'});
      try {
        if (download) return await downloadLogs(env.LOGS_DB, url.searchParams, request.method === 'HEAD');
        return json(200, await listLogs(env.LOGS_DB, url.searchParams));
      } catch (failure) {
        const clientError = [
          'invalid_filter',
          'invalid_time',
          'invalid_cursor',
          'invalid_time_range',
          'invalid_limit',
          'export_too_large',
        ].includes(failure.message);
        return error(clientError ? failure.status : 503, clientError ? failure.message : 'storage_unavailable');
      }
    }
    if (url.pathname !== '/v1/logs') return error(404, 'not_found');
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
      const operation = log.context.operation?.id;
      const tracked = typeof operation === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operation);
      const terminal = ['completed', 'failed', 'canceled', 'stopped', 'partial'].includes(
        log.context.operation?.outcome,
      );
      const receivedAt = new Date().toISOString();
      if (tracked) {
        const sequence = log.context.operation.sequence;
        log.context.operation.sequence = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
        log.id = operation;
        // A client cannot choose the server's first-received timestamp.
        log.context.operation.firstReceivedAt = receivedAt;
      }
      const exists = await env.LOGS_DB.prepare('SELECT received_at, context FROM logs WHERE source = ? AND id = ?')
        .bind(log.source, log.id)
        .first();
      if (exists) {
        if (!tracked) return json(200, {ok: true, duplicate: true});
        const previous = JSON.parse(exists.context).operation ?? {};
        if (
          log.context.operation.sequence <= (previous.sequence ?? -1) ||
          (!terminal && ['completed', 'failed', 'canceled', 'stopped', 'partial'].includes(previous.outcome))
        )
          return json(200, {ok: true, duplicate: true});
        if (!terminal && Date.parse(receivedAt) - Date.parse(exists.received_at) < 5000)
          return error(429, 'rate_limited', {'Retry-After': '5'});
      }
      const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
      if (!exists) {
        const recent = await env.LOGS_DB.prepare(
          'SELECT COUNT(*) AS count FROM logs WHERE source = ? AND received_at > ?',
        )
          .bind(log.source, since)
          .first();
        if (recent?.count >= (tracked ? 600 : RATE_LIMIT)) return error(429, 'rate_limited', {'Retry-After': '60'});
      }
      const result = await env.LOGS_DB.prepare(
        `
        INSERT INTO logs (source, id, received_at, level, event, version, message, context, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, id) ${
          tracked
            ? `DO UPDATE SET
          received_at = excluded.received_at, level = excluded.level, event = excluded.event,
          version = excluded.version, message = excluded.message, client_ip = excluded.client_ip,
          context = json_set(excluded.context, '$.operation.firstReceivedAt',
            COALESCE(json_extract(logs.context, '$.operation.firstReceivedAt'), logs.received_at))
        WHERE json_extract(excluded.context, '$.operation.sequence') >
          COALESCE(json_extract(logs.context, '$.operation.sequence'), -1)
        AND (${
          terminal
            ? '1'
            : `COALESCE(json_extract(logs.context, '$.operation.outcome'), '')
          NOT IN ('completed', 'failed', 'canceled', 'stopped', 'partial')
          AND (julianday(excluded.received_at) - julianday(logs.received_at)) * 86400000 >= 5000`
        })`
            : 'DO NOTHING'
        }
      `,
      )
        .bind(
          log.source,
          log.id,
          receivedAt,
          log.level,
          log.event,
          log.version,
          redactText(log.message),
          JSON.stringify(redactContext(log.context)),
          request.headers.get('CF-Connecting-IP'),
        )
        .run();
      if (!result.success) return error(503, 'storage_unavailable');
      // An indexed occasional sweep needs no scheduled job or extra permissions.
      if (Math.random() < CLEANUP_CHANCE) context?.waitUntil?.(removeExpired(env.LOGS_DB));
      const duplicate = result.meta.changes === 0;
      return json(duplicate ? 200 : 201, {ok: true, duplicate});
    } catch {
      return error(503, 'storage_unavailable');
    }
  },
};
