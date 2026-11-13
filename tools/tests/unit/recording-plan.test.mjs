import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecordingPlan} from '../../../src/media/recording-plan.js';
import {selectPlaylistRange} from '../../../src/media/playlist.js';

const manifest = '#EXTM3U\n#EXTINF:3,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nb.m4s';
const streams = [
  {stream: 'https://example.com/first/list', start_time: 100, end_time: 108},
  {stream: 'https://example.com/second/list', start_time: 120, end_time: 128},
];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};

test('预估与两种下载共享清单，断流和不同服务端录像段保留绝对时间', async () => {
  const seen = [];
  const api = {
    async request(url) {
      seen.push(url);
      return {data: manifest, url};
    },
  };
  const plan = new RecordingPlan(api, streams);
  const [estimate, selection, full] = await Promise.all([plan.load(), plan.load(), plan.load()]);
  assert.equal(estimate, selection);
  assert.equal(selection, full);
  assert.deepEqual(
    seen,
    streams.map(s => s.stream),
  );
  assert.deepEqual(
    full.map(g => g.start),
    [100, 103, 120, 123],
  );
  const parsed = {groups: full.map(group => ({...group, offset: group.start - 100}))};
  for (const [start, end, expected] of [
    [
      2,
      5,
      [
        [2, 3],
        [3, 5],
      ],
    ],
    [
      6,
      22,
      [
        [6, 8],
        [20, 22],
      ],
    ],
  ]) {
    assert.deepEqual(
      selectPlaylistRange(parsed, start, end).map(p => [p.offset + p.start, p.offset + p.end]),
      expected,
    );
  }
  assert.equal(await plan.load(), full);
  assert.equal(seen.length, 2);
  await new RecordingPlan(api, streams).load();
  assert.equal(seen.length, 4, '刷新建立新的清单，不复用旧签名');
});

test('取消下载只结束该调用者等待，预估仍能完成且共享请求不被取消', async () => {
  const wait = deferred(),
    lifetime = new AbortController(),
    download = new AbortController();
  let calls = 0;
  const plan = new RecordingPlan(
    {
      async request(url, {signal}) {
        calls++;
        assert.equal(signal, lifetime.signal);
        await wait.promise;
        return {data: manifest, url};
      },
    },
    streams.slice(0, 1),
    lifetime.signal,
  );
  const estimate = plan.load(),
    exportWait = plan.load(download.signal);
  download.abort();
  await assert.rejects(exportWait, {name: 'AbortError'});
  assert.equal(lifetime.signal.aborted, false);
  wait.resolve();
  const groups = await estimate;
  assert.equal(groups.length, 2);
  assert.equal(await plan.load(), groups);
  assert.equal(calls, 1);
});

test('离开场次取消共享请求，迟到结果不能进入缓存；新场次独立加载', async () => {
  const wait = deferred(),
    lifetime = new AbortController();
  let seenSignal;
  const api = {
    async request(url, {signal}) {
      seenSignal = signal;
      await wait.promise;
      return {data: manifest, url};
    },
  };
  const plan = new RecordingPlan(api, streams.slice(0, 1), lifetime.signal),
    pending = plan.load();
  lifetime.abort();
  assert.equal(seenSignal.aborted, true);
  wait.resolve();
  await assert.rejects(pending, {name: 'AbortError'});
  await assert.rejects(plan.load(), {name: 'AbortError'});
  assert.equal((await new RecordingPlan(api, streams.slice(1)).load())[0].start, 120);
});

test('网络失败或清单解析失败不缓存，下次操作可以重试', async () => {
  for (const failure of ['network', 'parse']) {
    let calls = 0;
    const plan = new RecordingPlan(
      {
        async request(url) {
          calls++;
          if (calls === 1) {
            if (failure === 'network') throw new Error('断网');
            return {data: 'not HLS', url};
          }
          return {data: manifest, url};
        },
      },
      streams.slice(0, 1),
    );
    const results = await Promise.allSettled([plan.load(), plan.load()]);
    assert.ok(results.every(r => r.status === 'rejected'));
    assert.equal(calls, 1);
    assert.equal((await plan.load()).length, 2);
    assert.equal(calls, 2);
  }
});

test('等待结束即移除取消监听，已取消的调用不启动请求', async t => {
  let calls = 0;
  const own = new AbortController();
  const add = t.mock.method(own.signal, 'addEventListener'),
    remove = t.mock.method(own.signal, 'removeEventListener');
  const plan = new RecordingPlan(
    {
      async request(url) {
        calls++;
        return {data: manifest, url};
      },
    },
    streams.slice(0, 1),
  );
  await plan.load(own.signal);
  assert.equal(add.mock.callCount(), 1);
  assert.equal(remove.mock.callCount(), 1);
  own.abort();
  await assert.rejects(plan.load(own.signal), {name: 'AbortError'});
  assert.equal(calls, 1);
});

test('part demand bypasses queued background playlists, shares work and never exceeds three requests', async () => {
  const parts = Array.from({length: 6}, (_, i) => ({
    stream: `https://example.com/${i}`,
    start_time: i * 10,
    end_time: i * 10 + 8,
  }));
  const gates = parts.map(() => deferred());
  const requested = [];
  let active = 0,
    peak = 0;
  const plan = new RecordingPlan(
    {
      request: async url => {
        const index = Number(url.split('/').at(-1));
        requested.push(index);
        active++;
        peak = Math.max(peak, active);
        await gates[index].promise;
        active--;
        return {data: manifest, url};
      },
    },
    parts,
  );
  const all = plan.load();
  const selected = plan.loadPart(5);
  assert.deepEqual(requested, [0, 1, 2]);
  gates[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requested, [0, 1, 2, 5]);
  gates[5].resolve();
  assert.ok((await selected).every(group => group.streamIndex === 5));
  assert.ok(!requested.includes(4), 'the current part is usable before unrelated playlists finish');
  gates.forEach(gate => gate.resolve());
  const groups = await all;
  assert.deepEqual(
    groups.map(group => group.streamIndex),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
  );
  assert.equal(new Set(requested).size, requested.length);
  assert.equal(peak, 3);
  assert.equal(await plan.loadPart(5), await plan.loadPart(5));
});

test('a failed unrelated playlist does not prevent loading the selected part and only failures are retried', async () => {
  const calls = [0, 0];
  const plan = new RecordingPlan(
    {
      request: async url => {
        const index = url === streams[0].stream ? 0 : 1;
        if (++calls[index] === 1 && index === 1) throw new Error('other part unavailable');
        return {data: manifest, url};
      },
    },
    streams,
  );
  const chosen = await plan.loadPart(0);
  await assert.rejects(plan.load(), /other part unavailable/);
  assert.equal(await plan.loadPart(0), chosen);
  assert.equal((await plan.load()).length, 4);
  assert.deepEqual(calls, [1, 2]);
});

test('canceling a part waiter preserves its shared request; leaving the recording stops queued work', async () => {
  const own = new AbortController(),
    caller = new AbortController();
  let requests = 0;
  const parts = Array.from({length: 6}, () => streams[0]);
  const plan = new RecordingPlan(
    {
      request: async (_, {signal}) => {
        requests++;
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      },
    },
    parts,
    own.signal,
  );
  const all = assert.rejects(plan.load(), {name: 'AbortError'});
  const selected = assert.rejects(plan.loadPart(5, caller.signal), {name: 'AbortError'});
  caller.abort();
  await selected;
  assert.equal(own.signal.aborted, false);
  own.abort();
  await all;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 3);
});
