import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sharePlaylists} from '../../../src/services/shared-playlists.js';

function fixture() {
  const calls = [];
  const shared = sharePlaylists(async (url, options) => {
    calls.push({url, options});
    return {data: `${url}-text`, url};
  });
  return {shared, calls};
}

test('readers of one playlist share a single download', async () => {
  const {shared, calls} = fixture();
  const [first, second] = await Promise.all([shared.request('a', {type: 'text'}), shared.request('a')]);
  assert.equal(first, second);
  await shared.request('a', {signal: new AbortController().signal});
  assert.equal(calls.length, 1);
});

test('media reads pass straight through', async () => {
  const {shared, calls} = fixture();
  await shared.request('a', {type: 'arraybuffer'});
  await shared.request('a', {type: 'arraybuffer'});
  await shared.request('a', {range: {offset: 0, length: 1}});
  assert.equal(calls.length, 3);
});

test('one reader cancelling leaves the download for the others', async () => {
  let finish, seen;
  const shared = sharePlaylists((url, options) => {
    seen = options;
    return new Promise(resolve => (finish = resolve));
  });
  const controller = new AbortController();
  const cancelled = shared.request('a', {signal: controller.signal}),
    other = shared.request('a');
  controller.abort();
  await assert.rejects(cancelled, {name: 'AbortError'});
  assert.equal(seen.signal, undefined);
  finish({data: 'text'});
  assert.equal((await other).data, 'text');
});

test('a failed download can be retried, and clearing forgets everything', async () => {
  let fail = true,
    calls = 0;
  const shared = sharePlaylists(async () => {
    calls++;
    if (fail) throw new Error('offline');
    return {data: 'text'};
  });
  await assert.rejects(shared.request('a'), /offline/);
  fail = false;
  await shared.request('a');
  assert.equal(calls, 2);
  shared.clear();
  await shared.request('a');
  assert.equal(calls, 3);
});

test('the shared copies are bounded for long live sessions', async () => {
  const {shared, calls} = fixture();
  for (const url of ['a', 'b', 'c', 'd', 'e']) await shared.request(url);
  await shared.request('a');
  assert.equal(calls.length, 6);
});
