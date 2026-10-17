import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildUserscript } from '../../scripts/build.mjs';

const deployment = {
  worker: { name: 'private-worker-fixture', domain: 'diagnostics.example.test' },
  cloudflare: { account_id: 'private-account-fixture', api_token: 'private-token-fixture' },
  database: { name: 'private-database-fixture', id: 'private-database-id-fixture', binding: 'LOGS_DB' },
};
const env = { LOG_SERVICE_CONFIG: JSON.stringify(deployment) };
const textOf = (result) => result.outputFiles[0].text;

test('ordinary builds ignore deployment secrets and produce identical artifacts', async () => {
  const first = textOf(await buildUserscript({ env, write: false }));
  const second = textOf(await buildUserscript({ env: { LOG_SERVICE_CONFIG: 'not-json' }, write: false }));
  assert.equal(first, second);
  assert.ok(!first.includes(deployment.worker.domain));
  assert.ok(!first.includes('__LOG_SERVICE_ENDPOINT__'));
  for (const value of [deployment.worker.name, ...Object.values(deployment.cloudflare), deployment.database.name, deployment.database.id]) {
    assert.ok(!first.includes(value));
  }
});

test('release artifact includes only public endpoint and exact connect permission', async () => {
  for (const domain of ['diagnostics.example.test', 'errors-2.example.test']) {
    const input = { ...deployment, worker: { ...deployment.worker, domain } };
    const output = textOf(await buildUserscript({ release: true, env: { LOG_SERVICE_CONFIG: JSON.stringify(input) }, write: false }));
    const sourceHeader = await readFile(new URL('../../../src/header.txt', import.meta.url), 'utf8');
    const connects = (source) => [...source.matchAll(/^\/\/ @connect\s+(\S+)\s*$/gm)].map((match) => match[1]);
    assert.deepEqual(connects(output), [...connects(sourceHeader), domain]);
    assert.ok(output.includes(`https://${domain}/v1/logs`));
    assert.ok(!output.includes('__LOG_SERVICE_ENDPOINT__'));
    for (const value of [deployment.worker.name, ...Object.values(deployment.cloudflare), deployment.database.name, deployment.database.id]) {
      assert.ok(!output.includes(value));
    }
  }
});

test('release build fails for missing, malformed or credential-bearing endpoint without echoing input', async () => {
  const badInputs = [undefined, 'broken-sensitive-json', '{}', 'null', ...[
    '', 'https://example.test', 'example.test/path', 'example.test:8443', 'secret@example.test',
    'example.test?token=private-token', '*.example.test', 'example.test\n// @connect *', 'example..test', 42,
  ].map((domain) => JSON.stringify({ worker: { domain } }))];
  for (const raw of badInputs) {
    await assert.rejects(buildUserscript({ release: true, env: { LOG_SERVICE_CONFIG: raw }, write: false }), (error) => {
      assert.match(error.message, /LOG_SERVICE_CONFIG/);
      assert.ok(!error.message.includes('private-token'));
      assert.ok(!error.message.includes('broken-sensitive-json'));
      return true;
    });
  }
});
