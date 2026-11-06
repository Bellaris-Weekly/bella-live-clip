import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingDownload} from '../../../src/media/recording-download.js';
import {createExportMetrics} from '../../../src/media/export-metrics.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const groups = count => [
  {segments: Array.from({length: count}, (_, i) => ({url: String(i), duration: 2, range: {offset: i * 4, length: 4}}))},
];

test('eight concurrent reads finish out of order but yield in order and never refetch a consumed segment', async () => {
  const starts = [],
    finish = new Map();
  let active = 0,
    peak = 0;
  const download = createRecordingDownload(
    {
      request: async (url, {range}) => {
        starts.push(url);
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => finish.set(url, resolve));
        active--;
        return {data: new Uint8Array([range.offset]).buffer};
      },
    },
    groups(12),
  );
  const iterator = download.segments();
  try {
    const first = iterator.next();
    await tick();
    assert.equal(starts.length, 8);
    assert.equal(peak, 8);
    for (const url of ['7', '6', '5', '4', '3', '2', '1']) finish.get(url)();
    await tick();
    assert.equal(starts.length, 9, 'prefetch must not run through the whole recording');
    finish.get('0')();
    assert.equal((await first).value.index, 0);
    for (let i = 1; i < 12; i++) {
      const next = iterator.next();
      await tick();
      for (const done of finish.values()) done();
      const {value} = await next;
      assert.equal(value.index, i);
      assert.equal(value.data[0], i * 4);
    }
    assert.equal((await iterator.next()).done, true);
    assert.equal(new Set(starts).size, 12);
    assert.equal(starts.length, 12);
  } finally {
    await iterator.return();
    await download.close();
  }
});

for (const concurrency of [6, 8])
  test(`${concurrency} downloads stay active beside a held fragment, then stop at the bounded window`, async () => {
    const metrics = createExportMetrics(),
      finish = new Map(),
      items = groups(30),
      size = 6 * 1024 * 1024;
    for (const segment of items[0].segments) segment.range.length = size;
    let active = 0,
      bytes = 0;
    const download = createRecordingDownload(
      {
        async request(url, {signal}) {
          active++;
          try {
            await new Promise((resolve, reject) => {
              finish.set(url, resolve);
              signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
            return {data: new ArrayBuffer(size)};
          } finally {
            active--;
          }
        },
      },
      items,
      {concurrency, metrics, onRead: size => (bytes += size)},
    );
    const iterator = download.segments();
    try {
      const first = iterator.next();
      await tick();
      assert.equal(active, concurrency);
      finish.get('0')();
      assert.equal((await first).value.index, 0);
      assert.equal(active, concurrency, 'consuming one fragment must leave every download slot available');
      for (const done of finish.values()) done();
      await tick();
      assert.equal(active, 0);
      assert.equal(finish.size, concurrency + 1, 'a stalled consumer bounds completed responses too');
      assert.equal(bytes, (concurrency + 1) * size);
      assert.ok(bytes <= 64 * 1024 * 1024);
      assert.deepEqual(metrics.snapshot().gauges.downloadConcurrency, {current: concurrency, peak: concurrency});
      assert.deepEqual(metrics.snapshot().gauges.activeRequests, {current: 0, peak: concurrency});
    } finally {
      await iterator.return();
      await download.close();
    }
  });

test('byte reservations stop prefetch at the budget and consumption releases space', async () => {
  const seen = [];
  const download = createRecordingDownload(
    {
      request: async url => {
        seen.push(url);
        return {data: new ArrayBuffer(4)};
      },
    },
    groups(10),
    {maxBytes: 8},
  );
  const iterator = download.segments();
  try {
    await iterator.next();
    await tick();
    assert.deepEqual(seen, ['0', '1']);
    await iterator.next();
    await tick();
    assert.deepEqual(seen, ['0', '1', '2']);
  } finally {
    await iterator.return();
    await download.close();
  }
});

test('one oversized demanded segment progresses without downloading the remainder into memory', async () => {
  const seen = [],
    items = groups(4);
  for (const s of items[0].segments) s.range.length = 32;
  const download = createRecordingDownload(
    {
      request: async url => {
        seen.push(url);
        return {data: new ArrayBuffer(32)};
      },
    },
    items,
    {maxBytes: 8},
  );
  const iterator = download.segments();
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal((await iterator.next()).value.index, i);
      assert.equal(seen.length, i + 1);
    }
  } finally {
    await iterator.return();
    await download.close();
  }
});

test('failure or cancellation aborts the other requests and leaves no speculative task running', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(),
      failure = new Error('permanent failure');
    let active = 0,
      fail;
    const download = createRecordingDownload(
      {
        request: (url, {signal}) =>
          new Promise((resolve, reject) => {
            active++;
            signal.addEventListener(
              'abort',
              () => {
                active--;
                reject(signal.reason);
              },
              {once: true},
            );
            if (url === '0') fail = () => reject(failure);
          }),
      },
      groups(8),
      {signal: controller.signal},
    );
    const iterator = download.segments(),
      pending = iterator.next();
    await tick();
    if (cancel) controller.abort(failure);
    else fail();
    await assert.rejects(pending, error => error === failure);
    await download.close();
    assert.equal(active, 0);
  }
});

test('a demand limit admits tail fragments one by one and stops without fetching the next one', async () => {
  let limit = 2;
  const seen = [];
  const download = createRecordingDownload(
    {
      request: async url => {
        seen.push(url);
        return {data: new ArrayBuffer(4)};
      },
    },
    groups(6),
    {concurrency: 2, limit: () => limit},
  );
  const iterator = download.segments();
  try {
    assert.equal((await iterator.next()).value.index, 0);
    assert.equal((await iterator.next()).value.index, 1);
    await tick();
    assert.deepEqual(seen, ['0', '1']);
    limit = 3; // No keyframe yet; inspect one more fragment.
    assert.equal((await iterator.next()).value.index, 2);
    assert.equal((await iterator.next()).done, true);
    assert.deepEqual(seen, ['0', '1', '2']);
  } finally {
    await iterator.return();
    await download.close();
  }
});
