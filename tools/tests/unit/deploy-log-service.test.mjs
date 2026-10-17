import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deployLogService, parseConfig } from '../../scripts/deploy-log-service.mjs';

const config = {
  cloudflare: { account_id: 'a'.repeat(32), api_token: 'synthetic-test-api-token' },
  worker: { name: 'test-log-worker' },
  database: { name: 'test-log-database', id: '11111111-2222-4333-8444-555555555555', binding: 'LOGS_DB' },
};
const env = { LOG_SERVICE_CONFIG: JSON.stringify(config), GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' };
const response = (result, status = 200) => new Response(JSON.stringify({ success: status === 200, result }), { status });

function api(overrides = {}) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      if (init.method === 'PUT') {
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.account_id}/workers/scripts/${config.worker.name}`);
        return overrides.upload?.() ?? response({});
      }
      if (url.endsWith('/settings')) return overrides.worker?.() ?? response({ bindings: [] });
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.account_id}/d1/database/${config.database.id}`);
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
      return `Output ${config.worker.name} ${config.cloudflare.api_token}`;
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
  for (const [group, key, bad] of [['database', 'binding', 'OTHER'], ['database', 'id', 'bad']]) {
    const input = structuredClone(config); input[group][key] = bad;
    assert.throws(() => parseConfig(JSON.stringify(input)));
  }
});

test('Worker and D1 preflight before mutations; no domain calls and config is cleaned', async (t) => {
  const h = await harness(t);
  const run = h.options.run;
  h.options.run = (...args) => {
    assert.equal(h.remote.calls.length, 2);
    assert.ok(h.remote.calls.every(({ init }) => init.method === 'GET'));
    return run(...args);
  };
  assert.deepEqual(await deployLogService(h.options), { skipped: false });
  assert.deepEqual(h.commands.map(({ args }) => args.slice(0, -2)), [['d1', 'migrations', 'apply', 'LOGS_DB', '--remote']]);
  for (const command of h.commands) {
    assert.equal(command.config.name, config.worker.name);
    assert.equal(command.config.d1_databases[0].database_id, config.database.id);
    assert.ok(!('workers_dev' in command.config));
    assert.ok(!('preview_urls' in command.config));
    assert.ok(!('routes' in command.config));
    assert.ok(!('route' in command.config));
    assert.ok(path.isAbsolute(command.config.d1_databases[0].migrations_dir));
    assert.ok(!JSON.stringify(command.config).includes(config.cloudflare.api_token));
    assert.ok(!command.args.join(' ').includes(config.cloudflare.api_token));
    assert.equal(command.options.env.LOG_SERVICE_CONFIG, undefined);
    assert.equal(command.options.env.CLOUDFLARE_API_TOKEN, config.cloudflare.api_token);
  }
  assert.ok(h.masks.includes(config.cloudflare.api_token));
  assert.ok(h.logs.every((value) => !value.includes(config.cloudflare.api_token) && !value.includes(config.worker.name)));
  assert.deepEqual(await readdir(h.tempRoot), []);
  assert.equal(h.remote.calls.length, 3);
  assert.deepEqual(h.remote.calls.map(({ init }) => init.method), ['GET', 'GET', 'PUT']);
  const form = h.remote.calls.at(-1).init.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual([...form.keys()], ['metadata', 'worker.js']);
  const metadata = JSON.parse(await form.get('metadata').text());
  assert.deepEqual(metadata, {
    main_module: 'worker.js', compatibility_date: '2026-10-17',
    bindings: [{ type: 'd1', name: 'LOGS_DB', database_id: config.database.id }],
    keep_bindings: ['plain_text', 'json', 'secret_text'],
  });
  const module = form.get('worker.js');
  assert.equal(module.type, 'application/javascript+module');
  const code = await module.text();
  const worker = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.equal(typeof worker.default.fetch, 'function');
  const notFound = await worker.default.fetch(new Request('https://example.test/missing'), {});
  assert.equal(notFound.status, 404);
});

for (const [name, overrides] of [
  ['missing Worker', { worker: () => response(null, 404) }],
  ['API forbidden', { worker: () => response(null, 403) }],
  ['API transient failure', { database: () => response(null, 503) }],
  ['wrong DB name', { database: () => response({ uuid: config.database.id, name: 'another-database' }) }],
  ['wrong DB UUID', { database: () => response({ uuid: 'other', name: config.database.name }) }],
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
  assert.equal(h.remote.calls.length, 2);
  assert.deepEqual(await readdir(h.tempRoot), []);
});

test('old domain setting is ignored regardless of value and never sent to network or CLI', async (t) => {
  for (const domain of ['not a valid domain', { arbitrary: 'previous-setting' }, null]) {
    const h = await harness(t);
    const input = structuredClone(config);
    input.worker.domain = domain;
    h.options.env = { ...env, LOG_SERVICE_CONFIG: JSON.stringify(input) };
    assert.deepEqual(await deployLogService(h.options), { skipped: false });
    assert.equal(h.remote.calls.length, 3);
    assert.ok(h.remote.calls.every(({ url }) => url.startsWith('https://api.cloudflare.com/') && !/domains|routes|subdomain/.test(url)));
    assert.deepEqual(h.remote.calls.map(({ init }) => init.method), ['GET', 'GET', 'PUT']);
    for (const command of h.commands) {
      assert.ok(!JSON.stringify(command.config).includes('domain'));
      assert.ok(!command.args.includes('--domain'));
    }
  }
});

test('bundle failure prevents migrations and code upload', async (t) => {
  const h = await harness(t);
  h.options.buildImpl = async () => { throw new Error('build failed'); };
  await assert.rejects(deployLogService(h.options), /build failed/);
  assert.equal(h.commands.length, 0);
  assert.deepEqual(h.remote.calls.map(({ init }) => init.method), ['GET', 'GET']);
  assert.deepEqual(await readdir(h.tempRoot), []);
});

for (const [name, upload] of [
  ['HTTP rejection', () => response(null, 403)],
  ['API rejection', () => new Response(JSON.stringify({ success: false, errors: [{ message: config.cloudflare.api_token }] }))],
  ['invalid response', () => new Response('not-json')],
  ['network failure', () => { throw new Error(config.cloudflare.api_token); }],
]) {
  test(`upload ${name} propagates safely and cleans temporary config`, async (t) => {
    const h = await harness(t, { upload });
    await assert.rejects(deployLogService(h.options), (error) => {
      assert.ok(!error.message.includes(config.cloudflare.api_token));
      return true;
    });
    assert.equal(h.commands.length, 1);
    assert.deepEqual(h.remote.calls.map(({ init }) => init.method), ['GET', 'GET', 'PUT']);
    assert.deepEqual(await readdir(h.tempRoot), []);
  });
}
