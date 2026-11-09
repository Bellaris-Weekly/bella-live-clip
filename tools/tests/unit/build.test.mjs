import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {buildUserscript, userscriptBuildOptions} from '../../scripts/build.mjs';
import {createUpdateChecker, readScriptMetadata} from '../../../src/services/updates.js';

const deployment = {
  worker: {name: 'private-worker-fixture', domain: 'diagnostics.example.test'},
  cloudflare: {account_id: 'private-account-fixture', api_token: 'private-token-fixture'},
  database: {name: 'private-database-fixture', id: 'private-database-id-fixture', binding: 'LOGS_DB'},
};
const env = {LOG_SERVICE_CONFIG: JSON.stringify(deployment)};
const textOf = result => result.outputFiles[0].text;

test('preview has a separate installation identity and update destination in ordinary and release builds', async () => {
  const source = await readFile(new URL('../../../src/header.txt', import.meta.url), 'utf8');
  const stable = readScriptMetadata(source);
  for (const release of [false, true]) {
    const result = await buildUserscript({preview: true, release, env, write: false});
    const script = textOf(result);
    const metadata = readScriptMetadata(script);
    assert.equal(result.outputFiles.length, 1);
    assert.match(result.outputFiles[0].path, /bella-live-clip\.preview\.user\.js$/);
    assert.match(script, /^\/\/ @name\s+贝报切片助手 Preview（内部版）$/m);
    assert.equal(metadata.version, stable.version);
    assert.equal(metadata.namespace, `${stable.namespace}/preview`);
    assert.equal(metadata.updateURL, stable.updateURL.replace('.user.js', '.preview.user.js'));
    assert.equal(metadata.downloadURL, metadata.updateURL);
    assert.ok(!script.includes(stable.updateURL), 'embedded update checker must not point back to public builds');
    assert.equal(script.includes(`https://${deployment.worker.domain}/v1/logs`), release);
    assert.ok(!script.includes(deployment.cloudflare.api_token));
    for (const [installed, response] of [
      [stable, script],
      [metadata, source],
    ]) {
      const check = createUpdateChecker({metadata: installed, request: async () => ({data: response})});
      assert.deepEqual(await check(), {status: 'error'}, 'updates must reject the other channel');
    }
  }
});

test('build-time gate removes internal code from public builds and runtime metadata matches the banner', async () => {
  for (const preview of [false, true]) {
    const options = userscriptBuildOptions({preview, write: false});
    const result = await build({
      ...options,
      entryPoints: [],
      stdin: {
        resolveDir: options.absWorkingDir,
        contents: `
          import header from './src/header.txt';
          import {readScriptMetadata} from './src/services/updates.js';
          globalThis.metadata = readScriptMetadata(header);
          if (typeof __PREVIEW__ !== 'undefined' && __PREVIEW__) {
            globalThis.internal = 'internal-feature-fixture';
          }
        `,
      },
    });
    const script = textOf(result);
    assert.equal(script.includes('internal-feature-fixture'), preview);
    assert.ok(!script.includes('__PREVIEW__'));
    const context = {};
    runInNewContext(script, context);
    assert.equal(context.internal, preview ? 'internal-feature-fixture' : undefined);
    assert.deepEqual({...context.metadata}, readScriptMetadata(script));
  }
});

test('ordinary builds ignore deployment secrets and produce identical artifacts', async () => {
  const firstBuild = await buildUserscript({env, write: false});
  const secondBuild = await buildUserscript({env: {LOG_SERVICE_CONFIG: 'not-json'}, write: false});
  const first = textOf(firstBuild),
    second = textOf(secondBuild);
  assert.equal(first, second);
  assert.equal(firstBuild.outputFiles.length, 1);
  assert.equal(secondBuild.outputFiles.length, 1);
  assert.ok(!first.includes(deployment.worker.domain));
  assert.ok(!first.includes('__LOG_SERVICE_ENDPOINT__'));
  for (const value of [
    deployment.worker.name,
    ...Object.values(deployment.cloudflare),
    deployment.database.name,
    deployment.database.id,
  ]) {
    assert.ok(!first.includes(value));
  }
});

test('compressed single script keeps licenses, initializes dependencies and supplies its own update metadata', async () => {
  const result = await buildUserscript({write: false});
  const script = textOf(result);
  assert.equal(result.outputFiles.length, 1);
  assert.ok(Buffer.byteLength(script) < 1_300_000, 'keep the install artifact below 1.3 MB');
  const metadata = readScriptMetadata(script);
  assert.match(metadata.updateURL, /\/bella-live-clip\.user\.js$/);
  assert.equal(metadata.updateURL, metadata.downloadURL);
  assert.match(script, /MPL-2\.0/);
  assert.match(script, /Apache-2\.0/);
  // Evaluate the actual minified artifact, with an existing host to skip DOM/UI startup.
  const window = {};
  window.top = window;
  runInNewContext(
    script,
    {
      window,
      location: {hostname: 'www.bilibili.com'},
      document: {getElementById: () => ({})},
      setTimeout,
      clearTimeout,
      TextEncoder,
      TextDecoder,
    },
    {timeout: 1000},
  );
});

test('release artifact includes only public endpoint and exact connect permission', async () => {
  for (const domain of ['diagnostics.example.test', 'errors-2.example.test']) {
    const input = {...deployment, worker: {...deployment.worker, domain}};
    const result = await buildUserscript({
      release: true,
      env: {LOG_SERVICE_CONFIG: JSON.stringify(input)},
      write: false,
    });
    const output = textOf(result);
    assert.equal(result.outputFiles.length, 1);
    const sourceHeader = await readFile(new URL('../../../src/header.txt', import.meta.url), 'utf8');
    // Minification can use multiline template literals for the app's embedded header text.
    // Permissions belong to the first metadata block, not strings inside the application.
    const connects = source =>
      [...source.slice(0, source.indexOf('// ==/UserScript==')).matchAll(/^\/\/ @connect\s+(\S+)\s*$/gm)].map(
        match => match[1],
      );
    assert.deepEqual(connects(output), [...connects(sourceHeader), domain]);
    assert.ok(output.includes(`https://${domain}/v1/logs`));
    assert.ok(!output.includes('__LOG_SERVICE_ENDPOINT__'));
    for (const value of [
      deployment.worker.name,
      ...Object.values(deployment.cloudflare),
      deployment.database.name,
      deployment.database.id,
    ]) {
      assert.ok(!output.includes(value));
    }
  }
});

test('release build fails for missing, malformed or credential-bearing endpoint without echoing input', async () => {
  const badInputs = [
    undefined,
    'broken-sensitive-json',
    '{}',
    'null',
    ...[
      '',
      'https://example.test',
      'example.test/path',
      'example.test:8443',
      'secret@example.test',
      'example.test?token=private-token',
      '*.example.test',
      'example.test\n// @connect *',
      'example..test',
      42,
    ].map(domain => JSON.stringify({worker: {domain}})),
  ];
  for (const raw of badInputs) {
    await assert.rejects(buildUserscript({release: true, env: {LOG_SERVICE_CONFIG: raw}, write: false}), error => {
      assert.match(error.message, /LOG_SERVICE_CONFIG/);
      assert.ok(!error.message.includes('private-token'));
      assert.ok(!error.message.includes('broken-sensitive-json'));
      return true;
    });
  }
});

test('studio network/storage grants and feature strings exist only in preview builds', async () => {
  for (const preview of [false, true]) {
    const script = textOf(await buildUserscript({preview, write: false}));
    const header = script.slice(0, script.indexOf('// ==/UserScript=='));
    for (const pattern of [
      /^\/\/ @connect\s+studio\.bk0717\.com$/m,
      /^\/\/ @grant\s+GM_addValueChangeListener$/m,
      /^\/\/ @grant\s+GM_listValues$/m,
    ])
      assert.equal(pattern.test(header), preview);
    for (const text of [
      'bella-plugin-link',
      'studio.pending.',
      'studioLogin',
      '等待回放',
      '/clip-defaults',
      '/upload-options',
      '/cos/uploads',
      '/submissions',
      '/covers',
      '确认投稿',
      '关联轴：',
      'studio-compose',
      'cover-wide.jpg',
    ])
      assert.equal(script.includes(text), preview, text);
    if (!preview) assert.ok(!script.includes('studio.bk0717.com/api'));
  }
});

test('preview entry runs token handshake and the existing upload bridge together on studio', async () => {
  const script = textOf(await buildUserscript({preview: true, write: false}));
  const listeners = [],
    replies = [],
    stored = [],
    uploads = [];
  const location = {hostname: 'studio.bk0717.com', origin: 'https://studio.bk0717.com', pathname: '/plugin/link'};
  const target = {
    location,
    addEventListener: (_, receive) => listeners.push(receive),
    postMessage: data => replies.push(data),
  };
  runInNewContext(script, {
    location,
    unsafeWindow: target,
    GM_setValue: (...args) => stored.push(args),
    GM_xmlhttpRequest: options => {
      uploads.push(options);
      return {abort() {}};
    },
    URL,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
  });
  const send = data => listeners.forEach(receive => receive({source: target, origin: location.origin, data}));
  send({channel: 'bella-plugin-link', type: 'hello', nonce: 'n'});
  send({
    channel: 'bella-plugin-link',
    type: 'token',
    nonce: 'n',
    token: 'secret',
    name: '成员',
    expires_at: 1800000000000,
  });
  assert.equal(
    replies.find(reply => reply.channel === 'bella-plugin-link' && reply.type === 'ready').version,
    readScriptMetadata(script).version,
  );
  assert.equal(stored[0][0], 'biliClip.studio.token');
  send({channel: 'bella-bridge', type: 'hello', nonce: 'upload'});
  assert.ok(replies.find(reply => reply.channel === 'bella-bridge' && reply.nonce === 'upload'));
  send({
    channel: 'bella-bridge',
    type: 'request',
    id: 'upload-1',
    method: 'PUT',
    url: 'https://upos-test.bilivideo.com/file',
    headers: {'x-upos-auth': 'fixture'},
    body: 'bytes',
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].data, 'bytes');
  uploads[0].onload({status: 200, responseText: 'ok'});
  assert.ok(replies.find(reply => reply.channel === 'bella-bridge' && reply.id === 'upload-1' && reply.status === 200));
});
