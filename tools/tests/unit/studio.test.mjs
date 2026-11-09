import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudioClient, startLink, STUDIO, TOKEN_KEY} from '../../../src/preview/studio.js';

const store = () => {
  const values = new Map();
  return {
    get: (key, fallback) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    set: (key, value) => values.set(key, structuredClone(value)),
    keys: () => [...values.keys()],
  };
};

test('link handshake accepts only the page window, exact origin/path and channel, and stores before acknowledging', () => {
  const writes = [],
    replies = [];
  let receive;
  const target = {
    addEventListener: (_, fn) => {
      receive = fn;
    },
    removeEventListener() {},
    postMessage: (data, origin) => replies.push({data, origin, writes: writes.length}),
  };
  const location = {origin: STUDIO, pathname: '/plugin/link'};
  const set = (...args) => writes.push(args);
  startLink({target, location, set, version: '2.13.10'});
  const hello = {channel: 'bella-plugin-link', type: 'hello', nonce: 'n'};
  const token = {...hello, type: 'token', token: 'secret', name: '成员', expires_at: 1800000000000};
  for (const data of [hello, token]) {
    receive({source: {}, origin: STUDIO, data});
    receive({source: target, origin: 'https://evil.example', data});
    receive({source: target, origin: STUDIO, data: {...data, channel: 'other'}});
    receive({source: target, origin: STUDIO, data: {...data, nonce: null}});
  }
  assert.equal(replies.length, 0);
  assert.equal(writes.length, 0);
  receive({source: target, origin: STUDIO, data: hello});
  assert.deepEqual(replies[0], {data: {...hello, type: 'ready', version: '2.13.10'}, origin: STUDIO, writes: 0});
  receive({source: target, origin: STUDIO, data: token});
  assert.deepEqual(writes, [[TOKEN_KEY, {token: 'secret', name: '成员', expires_at: token.expires_at}]]);
  assert.equal(replies[1].data.type, 'linked');
  assert.equal(replies[1].writes, 1);
  receive = null;
  startLink({target, location: {...location, pathname: '/'}, set, version: 'v'});
  assert.equal(receive, null);
});

test('studio client uses GM bearer requests, display name, RTT midpoint and a ten-minute clock limit', async () => {
  const storage = store();
  storage.set(TOKEN_KEY, {token: 'secret', name: 'old'});
  let time = 1000;
  const requests = [];
  const client = createStudioClient({
    ...storage,
    now: () => time,
    request(options) {
      requests.push(options);
      assert.equal(options.anonymous, true);
      assert.equal(options.headers.Authorization, 'Bearer secret');
      if (options.url.endsWith('/me')) options.onload({status: 200, response: {name: 'Display Name', sub: 'id'}});
      else {
        time += 200;
        options.onload({status: 200, response: {now_ms: time + 900}});
      }
    },
  });
  await client.check();
  assert.equal(client.identity().name, 'Display Name');
  assert.equal(client.serverNow(), 2200, 'server 2100 at local midpoint 1100 means offset +1000');
  await client.syncClock();
  await client.check();
  assert.equal(requests.filter(r => r.url.endsWith('/time')).length, 1);
  time += 600000;
  await client.syncClock();
  assert.equal(requests.filter(r => r.url.endsWith('/time')).length, 2);
});

test('any 401 forgets the token and notifies the gate; failures and conflicts preserve it', async () => {
  for (const path of ['/me', '/marks', '/time']) {
    const storage = store();
    storage.set(TOKEN_KEY, {token: 'expired'});
    let status = 409,
      notified = 0;
    const client = createStudioClient({
      ...storage,
      request: options => options.onload({status, response: {detail: {message: 'changed', current: {rev: 3}}}}),
    });
    client.subscribe(() => notified++);
    await assert.rejects(client.request(path), error => error.status === 409 && error.current.rev === 3);
    assert.ok(client.identity());
    status = 401;
    await assert.rejects(client.request(path), error => error.status === 401);
    assert.equal(client.identity(), null);
    assert.equal(storage.get(TOKEN_KEY), null);
    assert.equal(notified, 1);
    await assert.rejects(client.request('/me'), /登录/);
  }
});

test('focus/storage recheck notices linking and late 401 cannot clear a replacement token', async () => {
  const storage = store(),
    requests = [];
  const client = createStudioClient({...storage, request: options => requests.push(options)});
  await client.check();
  assert.equal(requests.length, 0);
  storage.set(TOKEN_KEY, {token: 'a'});
  const first = client.check();
  storage.set(TOKEN_KEY, {token: 'b'});
  const second = client.check();
  requests[0].onload({status: 401, response: {detail: 'expired'}});
  await assert.rejects(first);
  assert.equal(client.identity().token, 'b');
  requests[1].onload({status: 200, response: {name: 'B'}});
  await new Promise(resolve => setImmediate(resolve));
  requests[2].onload({status: 200, response: {now_ms: Date.now()}});
  await second;
  storage.set(TOKEN_KEY, null);
  await client.check();
  assert.equal(client.identity(), null);
});
