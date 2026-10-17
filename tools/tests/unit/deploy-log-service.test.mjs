import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deployLogService, parseConfig } from '../../scripts/deploy-log-service.mjs';

const config = {
  cloudflare: { account_id: 'a'.repeat(32), api_token: 'synthetic-test-api-token' },
  worker: { name: 'test-log-worker', domain: 'logs.example.test' },
  database: { name: 'test-log-database', id: '11111111-2222-4333-8444-555555555555', binding: 'LOGS_DB' },
};
const env = { LOG_SERVICE_CONFIG: JSON.stringify(config), GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' };
const response = (result, status = 200) => new Response(JSON.stringify({ success: status === 200, result }), { status });

function api(overrides = {}) {
  const calls = [];
  let inserted;
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/settings')) return overrides.worker?.() ?? response({ bindings: [] });
      if (url.includes('/domains?')) return overrides.domains?.() ?? response([{ hostname: config.worker.domain, service: config.worker.name, enabled: true, environment: 'production' }]);
      if (url.endsWith('/v1/logs')) {
        inserted = JSON.parse(init.body);
        return overrides.ingest?.() ?? new Response(JSON.stringify({ ok: true, duplicate: false }), { status: 201 });
      }
      if (url.endsWith('/query')) return overrides.query?.() ?? response([{ success: true, results: [{ id: inserted.id }] }]);
      return overrides.database?.() ?? response({ uuid: config.database.id, name: config.database.name });
    },
  };
}

async function harness(t, overrides = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'log-deploy-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const remote = api(overrides);
  const commands = [], logs = [], masks = [];
  const options = {
    env, tempRoot, fetchImpl: remote.fetch,
    log: (value) => logs.push(value), mask: (value) => masks.push(value),
    run: async (args, options) => {
      commands.push({ args, options, config: JSON.parse(await readFile(args.at(-1), 'utf8')) });
      return `Output ${config.worker.domain} ${config.cloudflare.api_token}`;
    },
  };
  return { tempRoot, remote, commands, logs, masks, options };
}

test('missing config skips only push without calls or writes', async () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const options = { env: { GITHUB_EVENT_NAME: event }, fetchImpl: () => assert.fail('no request'), run: () => assert.fail('no process'), log: () => {} };
    if (event === 'push') assert.deepEqual(await deployLogService(options), { skipped: true });
    else await assert.rejects(deployLogService(options), /LOG_SERVICE_CONFIG/);
  }
});

test('invalid structured configuration fails without echoing supplied fields', () => {
  assert.throws(() => parseConfig('{broken'), /有效的 JSON/);
  for (const [group, key, bad] of [['database', 'binding', 'OTHER'], ['worker', 'domain', 'https://logs.example.test'], ['worker', 'domain', 'demo.workers.dev'], ['database', 'id', 'bad']]) {
    const input = structuredClone(config); input[group][key] = bad;
    assert.throws(() => parseConfig(JSON.stringify(input)));
  }
});

test('all three resources preflight before mutations; update preserves dashboard domains and cleans config', async (t) => {
  const h = await harness(t);
  const run = h.options.run;
  h.options.run = (...args) => {
    assert.equal(h.remote.calls.length, 3);
    assert.ok(h.remote.calls.every(({ init }) => init.method === 'GET'));
    return run(...args);
  };
  assert.deepEqual(await deployLogService(h.options), { skipped: false });
  assert.deepEqual(h.commands.map(({ args }) => args.slice(0, -2)), [['d1', 'migrations', 'apply', 'LOGS_DB', '--remote'], ['deploy']]);
  for (const command of h.commands) {
    assert.equal(command.config.name, config.worker.name);
    assert.equal(command.config.d1_databases[0].database_id, config.database.id);
    assert.equal(command.config.workers_dev, false);
    assert.equal(command.config.preview_urls, false);
    assert.ok(!('routes' in command.config));
    assert.ok(!('route' in command.config));
    assert.ok(path.isAbsolute(command.config.main));
    assert.ok(path.isAbsolute(command.config.d1_databases[0].migrations_dir));
    assert.ok(!JSON.stringify(command.config).includes(config.cloudflare.api_token));
    assert.ok(!command.args.join(' ').includes(config.cloudflare.api_token));
    assert.equal(command.options.env.LOG_SERVICE_CONFIG, undefined);
    assert.equal(command.options.env.CLOUDFLARE_API_TOKEN, config.cloudflare.api_token);
  }
  assert.ok(h.masks.includes(config.cloudflare.api_token));
  assert.ok(h.logs.every((value) => !value.includes(config.cloudflare.api_token) && !value.includes(config.worker.domain)));
  assert.deepEqual(await readdir(h.tempRoot), []);
  const query = JSON.parse(h.remote.calls.at(-1).init.body);
  assert.equal(query.sql, 'SELECT id FROM logs WHERE source = ? AND id = ?');
  assert.equal(query.params[0], 'log-service-smoke');
});

for (const [name, overrides] of [
  ['missing Worker', { worker: () => response(null, 404) }],
  ['API forbidden', { worker: () => response(null, 403) }],
  ['API transient failure', { database: () => response(null, 503) }],
  ['wrong DB name', { database: () => response({ uuid: config.database.id, name: 'another-database' }) }],
  ['wrong DB UUID', { database: () => response({ uuid: 'other', name: config.database.name }) }],
  ['missing domain', { domains: () => response([]) }],
  ['domain belongs to other Worker', { domains: () => response([{ hostname: config.worker.domain, service: 'other', enabled: true }]) }],
  ['disabled domain', { domains: () => response([{ hostname: config.worker.domain, service: config.worker.name, enabled: false }]) }],
]) {
  test(`${name} aborts before migration or deploy and never provisions`, async (t) => {
    const h = await harness(t, overrides);
    await assert.rejects(deployLogService(h.options));
    assert.equal(h.commands.length, 0);
    assert.ok(h.remote.calls.every(({ init }) => init.method === 'GET'));
    assert.deepEqual(await readdir(h.tempRoot), []);
  });
}

test('non-main cannot deploy even with a valid config', async (t) => {
  const h = await harness(t);
  h.options.env = { ...env, GITHUB_REF: 'refs/heads/other' };
  await assert.rejects(deployLogService(h.options), /main/);
  assert.equal(h.remote.calls.length, 0);
});

test('failed command is redacted and temporary config removed; no later mutation', async (t) => {
  const h = await harness(t);
  h.options.run = async () => { throw new Error(`failure ${config.cloudflare.api_token} ${config.database.id}`); };
  await assert.rejects(deployLogService(h.options), (error) => {
    assert.ok(!error.message.includes(config.cloudflare.api_token));
    assert.ok(!error.message.includes(config.database.id));
    return true;
  });
  assert.equal(h.remote.calls.length, 3);
  assert.deepEqual(await readdir(h.tempRoot), []);
});

test('production smoke requires database confirmation after endpoint success', async (t) => {
  const h = await harness(t, { query: () => response([{ success: true, results: [] }]) });
  await assert.rejects(deployLogService(h.options), /数据库未确认/);
  assert.equal(h.commands.length, 2);
  assert.deepEqual(await readdir(h.tempRoot), []);
});
