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

test('pending create persists immediately, holds its note window, and replays the same immutable UUID after response loss', async () => {
  const values = storage(),
    requests = [];
  let now = 1000,
    fail = true;
  const client = {
    identity: () => ({name: 'A'}),
    async request(path, options) {
      requests.push({path, body: structuredClone(options.body)});
      if (fail) throw new Error('response lost');
      return {id: 'uuid', ...options.body, rev: 1};
    },
  };
  let queue = createPendingQueue({...values, client, now: () => now});
  queue.add({id: 'uuid', room_id: 3, at: 1234, note: ''});
  assert.equal(queue.entries().length, 1);
  await queue.flush(true);
  assert.equal(requests.length, 0, 'opening another panel cannot send an unfinished note');
  queue.finish('uuid', 'note');
  await queue.flush();
  assert.equal(requests.length, 1);
  assert.equal(queue.entries().length, 1);
  queue.finish('uuid', 'different');
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

test('ignored input saves without a note; separate tab writes survive; logged-out queue does not upload', async () => {
  const values = storage(),
    sent = [];
  let now = 0,
    loggedIn = true;
  const client = {
    identity: () => loggedIn,
    async request(path, {body}) {
      sent.push({path, body});
      return {id: path.split('/').at(-1), ...body};
    },
  };
  const a = createPendingQueue({...values, client, now: () => now});
  const b = createPendingQueue({...values, client, now: () => now});
  a.add({id: 'a', room_id: 1, at: 1, note: ''});
  b.add({id: 'b', room_id: 2, at: 2, note: ''});
  now = 16000;
  loggedIn = false;
  await a.flush(true);
  assert.equal(sent.length, 0);
  loggedIn = true;
  await b.flush(true);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(item => item.body.note === ''));
  a.stop();
  b.stop();
});
