import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../../../src/server/logs-worker.js';

function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../../server/logs/migrations/0001_logs.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return {
    db,
    env: {LOGS_DB: {prepare(sql) {
      return {bind(...params) {
        return {async run() {
          const result = db.prepare(sql).run(...params);
          return {success: true, meta: {changes: Number(result.changes)}};
        }};
      }};
    }}},
  };
}

const sample = overrides => ({
  id: 'attempt-1', source: 'test-plugin', event: 'export_failed', level: 'error',
  version: '1.0.0', message: 'Array buffer allocation failed',
  context: {page: 'https://www.bilibili.com/video/BVexample', roomId: 123, duration: 3600},
  ...overrides,
});

function request(body, headers = {}, path = '/v1/logs') {
  return new Request(`https://logs.example.com${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', ...headers},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('持久化真实 SQL 行、服务端时间、公开上下文，忽略客户端请求头', async t => {
  const {db, env} = database(t);
  const before = new Date().toISOString();
  const response = await worker.fetch(request(sample(), {Cookie: 'private-cookie', Authorization: 'Bearer private-token', 'User-Agent': 'private-agent'}), env);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {ok: true, duplicate: false});
  const row = db.prepare('SELECT * FROM logs').get();
  assert.equal(row.message, sample().message);
  assert.deepEqual(JSON.parse(row.context), sample().context);
  assert.ok(row.received_at >= before && row.received_at <= new Date().toISOString());
  assert.equal(row.version, '1.0.0');
  assert.ok(!JSON.stringify(row).includes('private-'));
});

test('同来源重复请求不覆盖原记录，不同来源同编号独立保存，SQL 字符按数据入库', async t => {
  const {db, env} = database(t);
  assert.equal((await worker.fetch(request(sample()), env)).status, 201);
  const repeat = await worker.fetch(request(sample({message: 'replacement'})), env);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), {ok: true, duplicate: true});
  assert.equal((await worker.fetch(request(sample({source: 'another-app', message: "'); DROP TABLE logs; --"})), env)).status, 201);
  const rows = db.prepare('SELECT source, message FROM logs ORDER BY source').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].message, sample().message);
  assert.equal(rows[0].message, "'); DROP TABLE logs; --");
});

test('结构化凭据和嵌套错误文本脱敏，保留其他 URL 参数与关键帧字段', async t => {
  const {db, env} = database(t);
  const context = {
    headers: {Cookie: 'a=credential-one; b=credential-two', Authorization: 'Bearer credential-three'},
    Access_Token: 'credential-four', apiKey: 'credential-five', password: 'credential-six',
    service: {CLOUDFLARE_API_TOKEN: 'credential-eighteen', sessionToken: 'credential-nineteen'},
    nested: [{refresh_token: 'credential-seven', key: 'public-keyframe-id', keyframe: 42}],
    url: 'https://person:credential-eight@media.example.com/live/123.ts?room=123&wsSecret=credential-nine&quality=80&X-Amz-Signature=credential-ten#access_token=credential-eleven',
    detail: 'fetch failed https://cdn.example.com/file.ts?token=credential-twelve&cid=88\nCookie: a=credential-thirteen; b=credential-fourteen\nAuthorization: Basic credential-fifteen\n{"client_secret":"credential-sixteen"}',
  };
  const response = await worker.fetch(request(sample({message: 'Failure with Bearer credential-seventeen', context})), env);
  assert.equal(response.status, 201);
  const row = db.prepare('SELECT message, context FROM logs').get();
  assert.ok(!JSON.stringify(row).includes('credential-'), JSON.stringify(row));
  const stored = JSON.parse(row.context);
  assert.equal(stored.nested[0].key, 'public-keyframe-id');
  assert.equal(stored.nested[0].keyframe, 42);
  const url = new URL(stored.url);
  assert.equal(url.pathname, '/live/123.ts');
  assert.equal(url.searchParams.get('room'), '123');
  assert.equal(url.searchParams.get('quality'), '80');
  assert.ok(stored.detail.includes('cid=88'));
});

test('等号形式的 Cookie 和认证头按完整值脱敏，多次处理不留下尾值', async t => {
  const {db, env} = database(t);
  const message = 'Request failed Cookie=a=credential-one; b=credential-two\nroom=123';
  const context = {detail: 'Set-Cookie=session=credential-three; extra=credential-four\nProxy-Authorization=Bearer credential-five'};
  assert.equal((await worker.fetch(request(sample({message, context})), env)).status, 201);
  const row = db.prepare('SELECT message, context FROM logs').get();
  assert.ok(!JSON.stringify(row).includes('credential-'));
  assert.equal(row.message, 'Request failed Cookie=[REDACTED]\nroom=123');
  assert.deepEqual(JSON.parse(row.context), {detail: 'Set-Cookie=[REDACTED]\nProxy-Authorization=[REDACTED]'});
  assert.equal((await worker.fetch(request(sample({id: 'already-redacted', message: row.message, context: JSON.parse(row.context)})), env)).status, 201);
  assert.equal(db.prepare('SELECT message FROM logs WHERE id = ?').get('already-redacted').message, row.message);
});

test('验证请求结构、长度、层级和有限数值，拒绝后不写入数据库', async t => {
  const {db, env} = database(t);
  let deep = {};
  for (let i = 0; i < 34; i++) deep = {next: deep};
  const missing = sample(); delete missing.id;
  for (const invalid of [null, [], {}, missing, sample({extra: true}), sample({id: 'bad id'}),
    sample({source: 'a'.repeat(65)}), sample({event: ''}), sample({level: 'fatal'}),
    sample({version: ''}), sample({message: '  '}), sample({message: 'x'.repeat(16385)}),
    sample({context: []}), sample({context: null}), sample({context: deep})]) {
    const response = await worker.fetch(request(invalid), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {error: 'invalid_log'});
  }
  const nonfinite = JSON.stringify(sample()).replace('"roomId":123', '"roomId":1e400');
  assert.equal((await worker.fetch(request(nonfinite), env)).status, 400);
  assert.equal(db.prepare('SELECT count(*) AS count FROM logs').get().count, 0);
});

test('UTF8 实际字节限制包含边界，Content-Length 虚报不影响判断', async t => {
  const {db, env} = database(t);
  const base = JSON.stringify(sample({context: {padding: ''}}));
  const padding = 65536 - new TextEncoder().encode(base).byteLength;
  const exact = base.replace('"padding":""', `"padding":"${'汉'.repeat(Math.floor(padding / 3))}${'x'.repeat(padding % 3)}"`);
  assert.equal(new TextEncoder().encode(exact).byteLength, 65536);
  assert.equal((await worker.fetch(request(exact, {'Content-Length': '999999'}), env)).status, 201);
  const tooBig = exact.replace('"padding":"', '"padding":"x');
  const response = await worker.fetch(request(tooBig, {'Content-Length': '1'}), env);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {error: 'payload_too_large'});
  assert.equal(db.prepare('SELECT count(*) AS count FROM logs').get().count, 1);
});

test('分块流达到限制立即停止读取，多字节 UTF8 跨块仍正确解码', async t => {
  const {db, env} = database(t);
  let pulls = 0, cancelled = false;
  const huge = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(16384)); },
    cancel() { cancelled = true; },
  }, {highWaterMark: 0});
  const response = await worker.fetch(new Request('https://logs.example.com/v1/logs', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: huge, duplex: 'half',
  }), env);
  // Invalid UTF8 is not involved: NUL bytes decode, but are not parsed until bounded reading completes.
  assert.equal(response.status, 413);
  assert.equal(pulls, 5); assert.equal(cancelled, true);
  const encoded = new TextEncoder().encode(JSON.stringify(sample({message: '导出错误'})));
  const stream = new ReadableStream({start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  }});
  assert.equal((await worker.fetch(new Request('https://logs.example.com/v1/logs', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: stream, duplex: 'half',
  }), env)).status, 201);
  assert.equal(db.prepare('SELECT message FROM logs').get().message, '导出错误');
});

test('路由、CORS 和 JSON 错误返回稳定状态且没有公开读写接口', async t => {
  const {db, env} = database(t);
  for (const [input, status, code] of [
    [new Request('https://logs.example.com/v1/logs'), 405, 'method_not_allowed'],
    [request(sample(), {}, '/logs'), 404, 'not_found'],
    [request(sample(), {'Content-Type': 'text/plain'}), 415, 'unsupported_media_type'],
    [request('{'), 400, 'invalid_json'],
    [new Request('https://logs.example.com/v1/logs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: new Uint8Array([0xff])}), 400, 'invalid_json'],
  ]) {
    const response = await worker.fetch(input, env);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {error: code});
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const preflight = await worker.fetch(new Request('https://logs.example.com/v1/logs', {method: 'OPTIONS', headers: {Origin: 'https://another.example.com'}}), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(db.prepare('SELECT count(*) AS count FROM logs').get().count, 0);
});

test('数据库故障不返回成功，不泄露异常或请求体', async () => {
  for (const env of [
    {},
    {LOGS_DB: {prepare() { throw new Error('internal secret detail'); }}},
    {LOGS_DB: {prepare() { return {bind() { return {async run() { return {success: false}; }}; }}; }}},
  ]) {
    const response = await worker.fetch(request(sample()), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'storage_unavailable'});
  }
});
