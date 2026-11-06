const MAX_EXPORT = 5000;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(value);
const bad = code => Object.assign(new Error(code), {status: 400});
const iso = value => {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw bad('invalid_time');
  return date.toISOString();
};
function unpack(value) {
  try {
    const data = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (!Array.isArray(data) || data.length !== 4 || !identifier(data[1]) || !identifier(data[2]))
      throw bad('invalid_cursor');
    return [iso(data[0]), data[1], data[2], iso(data[3])];
  } catch {
    throw bad('invalid_cursor');
  }
}
const cursorFor = (row, snapshot) =>
  btoa(JSON.stringify([row.received_at, row.source, row.id, snapshot]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export function logQuery(params) {
  const where = [],
    values = [];
  const fields = {
    source: 'source',
    event: 'event',
    level: 'level',
    version: 'version',
    mode: "json_extract(context, '$.mode')",
    operation: "json_extract(context, '$.operation.id')",
    outcome: "json_extract(context, '$.operation.outcome')",
  };
  for (const [name, column] of Object.entries(fields)) {
    const value = params.get(name);
    if (!value) continue;
    if (!identifier(value)) throw bad('invalid_filter');
    where.push(`${column} = ?`);
    values.push(value);
  }
  let snapshot = params.get('to') ? iso(params.get('to')) : new Date().toISOString();
  const cursor = params.get('cursor');
  if (cursor && cursor.length > 1024) throw bad('invalid_cursor');
  const after = cursor ? unpack(cursor) : null;
  if (after) snapshot = snapshot < after[3] ? snapshot : after[3];
  where.push('received_at <= ?');
  values.push(snapshot);
  if (params.get('from')) {
    const from = iso(params.get('from'));
    if (from > snapshot) throw bad('invalid_time_range');
    where.push('received_at >= ?');
    values.push(from);
  }
  if (after) {
    where.push('(received_at, source, id) < (?, ?, ?)');
    values.push(...after.slice(0, 3));
  }
  const limit = Number(params.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('invalid_limit');
  return {where: where.join(' AND '), values, snapshot, limit};
}

async function rows(database, query, limit) {
  const result = await database
    .prepare(
      `SELECT source, id, received_at, level, event, version, message, context, client_ip
    FROM logs WHERE ${query.where} ORDER BY received_at DESC, source DESC, id DESC LIMIT ?`,
    )
    .bind(...query.values, limit)
    .all();
  if (result.success === false) throw new Error('storage_unavailable');
  return result.results.map(row => ({...row, context: JSON.parse(row.context)}));
}

export async function listLogs(database, params) {
  const query = logQuery(params);
  const found = await rows(database, query, query.limit + 1);
  const more = found.length > query.limit;
  const logs = found.slice(0, query.limit);
  return {logs, snapshot: query.snapshot, nextCursor: more ? cursorFor(logs.at(-1), query.snapshot) : null};
}

export async function downloadLogs(database, params, head = false) {
  const filter = new URLSearchParams(params);
  filter.delete('cursor');
  filter.set('limit', '200');
  const query = logQuery(filter);
  // At most 5k records / 25 batches per download. Reject before headers instead
  // of silently delivering a partial file; users can narrow the time interval.
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM
    (SELECT 1 FROM logs WHERE ${query.where} LIMIT ?)`,
    )
    .bind(...query.values, MAX_EXPORT + 1)
    .first();
  if (!count || !Number.isFinite(count.count)) throw new Error('storage_unavailable');
  if (count.count > MAX_EXPORT) throw Object.assign(new Error('export_too_large'), {status: 413});
  if (head)
    return new Response(null, {
      headers: {'Cache-Control': 'no-store', 'X-Log-Count': String(count.count), 'X-Log-Snapshot': query.snapshot},
    });
  filter.set('to', query.snapshot);
  let page = await listLogs(database, filter),
    ended = false,
    canceled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream(
    {
      async pull(controller) {
        if (canceled) return;
        try {
          if (!page) page = await listLogs(database, filter);
          if (canceled) return;
          const current = page;
          page = null;
          if (current.logs.length)
            controller.enqueue(encoder.encode(current.logs.map(log => JSON.stringify(log)).join('\n') + '\n'));
          if (!current.nextCursor) {
            ended = true;
            controller.close();
          } else filter.set('cursor', current.nextCursor);
        } catch {
          if (!canceled && !ended) controller.error(new Error('日志下载中断，请重试。'));
        }
      },
      cancel() {
        canceled = true;
        page = null;
      },
    },
    {highWaterMark: 0},
  );
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="logs-${query.snapshot.slice(0, 10)}.jsonl"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Log-Count': String(count.count),
    },
  });
}
