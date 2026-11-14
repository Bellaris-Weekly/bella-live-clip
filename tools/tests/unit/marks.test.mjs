import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingQueue, parseManualTime, markTime} from '../../../src/preview/marks.js';

function storage() {
  const values = new Map();
  return {
    get: (key, fallback) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    set: (key, value) => values.set(key, structuredClone(value)),
    keys: () => [...values.keys()],
  };
}
const ms = text => Date.parse(text + '+08:00');

test('manual marks use UTC+8, session date, midnight and the most recent past fallback', () => {
  const range = {from: ms('2026-10-01T23:00:00'), to: ms('2026-10-02T02:00:00'), now: ms('2026-11-09T00:05:00')};
  assert.deepEqual(parseManualTime('23:30 跑调', range), {at: ms('2026-10-01T23:30:00'), note: '跑调'});
  assert.deepEqual(parseManualTime('01:20:34', range), {at: ms('2026-10-02T01:20:34'), note: ''});
  assert.equal(parseManualTime('21:13 note', range).at, ms('2026-11-08T21:13:00'));
  assert.equal(parseManualTime('02:00', range).at, ms('2026-11-08T02:00:00'), 'end is exclusive');
  assert.equal(markTime(ms('2026-10-02T01:20:34')), '01:20:34');
  for (const bad of ['24:00', '12:60', '12:00:60', '12:1', 'x', '12:00 ' + '字'.repeat(201)])
    assert.throws(() => parseManualTime(bad, range));
});

test('a queued create persists, backs off after a lost response, and replays the same immutable UUID', async () => {
  const values = storage(),
    requests = [];
  let now = 1000,
    fail = true;
  const client = {
    identity: () => ({sub: 'user-a', name: 'A'}),
    async request(path, options) {
      requests.push({path, body: structuredClone(options.body)});
      if (fail) throw new Error('response lost');
      return {id: 'uuid', ...options.body, rev: 1};
    },
  };
  let queue = createPendingQueue({...values, client, now: () => now});
  queue.add({id: 'uuid', room_id: 3, at: 1234, note: 'note'});
  await queue.flush();
  assert.equal(requests.length, 1, 'uploads as soon as it is queued');
  assert.equal(queue.entries()[0].error, 'response lost');
  await queue.flush();
  assert.equal(requests.length, 1, 'backoff suppresses an early retry');
  queue.stop();
  fail = false;
  now += 10000;
  queue = createPendingQueue({...values, client, now: () => now});
  await queue.flush(true);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].path, '/marks/uuid');
  assert.deepEqual(requests[1].body, {room_id: 3, at: 1234, note: 'note'});
  assert.equal(queue.entries().length, 0);
  queue.stop();
});

test('separate tab writes survive, a logged-out queue does not upload, and rejected payloads are dropped and reported', async () => {
  const values = storage(),
    sent = [],
    failures = [];
  let loggedIn = true;
  const client = {
    identity: () => (loggedIn ? {sub: 'user-a'} : null),
    async request(path, {body}) {
      sent.push({path, body});
      if (body.note === 'bad') throw Object.assign(new Error('at: Input should be a valid integer'), {status: 422});
      return {id: path.split('/').at(-1), ...body};
    },
  };
  const a = createPendingQueue({...values, client, failed: (mark, error) => failures.push([mark.id, error.message])});
  const b = createPendingQueue({...values, client});
  // Queue while logged in; both writes fail and remain local until reconnecting.
  const request = client.request;
  client.request = async () => {
    throw new Error('offline');
  };
  a.add({id: 'a', room_id: 1, at: 1, note: ''});
  b.add({id: 'b', room_id: 2, at: 2, note: ''});
  await Promise.all([a.flush(), b.flush()]);
  client.request = request;
  loggedIn = false;
  await a.flush(true);
  assert.equal(sent.length, 0);
  loggedIn = true;
  await b.flush(true);
  assert.equal(sent.length, 2);
  assert.equal(a.entries().length, 0);
  a.add({id: 'c', room_id: 1, at: 1.5, note: 'bad'});
  await a.flush();
  assert.equal(a.entries().length, 0, 'a validation error is not retried');
  assert.deepEqual(failures, [['c', 'at: Input should be a valid integer']]);
  a.stop();
  b.stop();
});

test('pending marks stay with their stable account across logout, rename and token renewal', async t => {
  const values = storage(),
    sent = [];
  let identity = {sub: 'a', name: 'same', token: 'a1'},
    offline = true;
  const client = {
    identity: () => identity,
    async request(path, {body}) {
      if (offline) throw new Error('offline');
      sent.push({path, user: identity.sub});
      return {id: path.split('/').at(-1), ...body};
    },
  };
  const queue = createPendingQueue({...values, client});
  t.after(() => queue.stop());
  values.set('studio.pending.legacy', {mark: {id: 'legacy'}, next: 0});
  queue.add({id: 'a-mark', room_id: 1, at: 1, note: 'private'});
  await queue.flush();
  identity = null;
  assert.equal(queue.entries().length, 0);
  assert.throws(() => queue.add({id: 'no-owner'}), /登录身份/);
  identity = {sub: 'b', name: 'same', token: 'b1'};
  offline = false;
  await queue.flush(true);
  assert.equal(queue.entries().length, 0);
  assert.deepEqual(sent, []);
  identity = {sub: 'a', name: 'renamed', token: 'a2'};
  await queue.flush(true);
  assert.deepEqual(sent, [{path: '/marks/a-mark', user: 'a'}]);
  assert.ok(values.get('studio.pending.legacy'), 'unattributed old entries are preserved, never reassigned');
});

test('an account switch during upload hides its result and stops sending that accounts remaining queue', async t => {
  const values = storage(),
    changed = [],
    sent = [];
  let identity = {sub: 'a'},
    finish;
  for (const id of ['first', 'second']) values.set(`studio.pending.${id}`, {owner: 'a', mark: {id}, next: 0});
  const client = {
    identity: () => identity,
    request(path) {
      sent.push(path);
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  };
  const queue = createPendingQueue({...values, client, changed: mark => changed.push(mark)});
  t.after(() => queue.stop());
  const pending = queue.flush(true);
  identity = {sub: 'b'};
  finish({id: 'first'});
  await pending;
  assert.deepEqual(sent, ['/marks/first']);
  assert.deepEqual(changed, []);
  assert.ok(values.get('studio.pending.second'));
});
