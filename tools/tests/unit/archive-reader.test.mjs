import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createCommentReader, prepareComments} from '../../../src/danmaku/archive.js';
import {readMetadata, snapshotCoverage} from '../../../src/danmaku/parquet.js';
import {deferred} from '../../../src/shared/deferred.js';
import {memoryFile} from '../support/memory-file.mjs';
import {createExportMetrics} from '../../../src/media/export-metrics.js';
import {performanceLog} from '../../../src/shared/performance-log.js';
import {waitForRetry} from '../../../src/services/retry-request.js';

const fixture = new Uint8Array(await readFile(new URL('../fixtures/danmaku.parquet', import.meta.url))).buffer;
const metadata = await readMetadata(fixture);
const file = {byteLength: fixture.byteLength, slice: (a, b) => Promise.resolve(fixture.slice(a, b))};
const prepared = count => ({
  file,
  metadata,
  parts: Array.from({length: count}, (_, part) => ({path: `live-archive/p${part}.parquet`, snapshot: true})),
});
const range = {origin: 0, start: 90, end: 110};

test('a failed part open can be requested again instead of caching the rejection', async () => {
  let requests = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: prepared(2),
      fetcher: async () => {
        if (++requests <= 2) throw new TypeError('temporary failure');
        return new Response(fixture);
      },
    },
  );
  try {
    await assert.rejects(reader.read(range), /读取失败/);
    assert.equal((await reader.read(range)).length, 4);
    assert.equal(requests, 3);
  } finally {
    await reader.close();
  }
});

test('a snapshot survives a failed disk write, removes the partial file, and is never fetched again', async () => {
  let requests = 0,
    writes = 0,
    removed = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: prepared(2),
      fetcher: async () => {
        requests++;
        return new Response(fixture);
      },
      createTemporary: async () => {
        let data;
        return {
          handle: {
            async createWritable() {
              return {
                async write(chunk) {
                  if (++writes === 1) throw new Error('disk failure');
                  data = chunk.data;
                },
                async close() {},
                async abort() {},
              };
            },
            async getFile() {
              return new Blob([data]);
            },
          },
          async remove() {
            removed++;
          },
        };
      },
    },
  );
  try {
    await assert.rejects(reader.read(range), /disk failure/);
    assert.equal(removed, 1);
    assert.equal((await reader.read(range)).length, 4);
    assert.equal(requests, 1, 'a retry must keep the same live snapshot');
    assert.equal(removed, 1);
  } finally {
    await reader.close();
  }
  assert.equal(removed, 2);
});

test('creating a reader does not start additional archive requests before demand', async () => {
  let requests = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: prepared(5),
      fetcher: async () => {
        requests++;
        return new Response(fixture);
      },
    },
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests, 0, 'unused archive opens must not compete with video startup');
  } finally {
    await reader.close();
  }
});

test('current rows start before later archive opens; concurrent windows reuse each read', async () => {
  const payload = deferred(),
    release = deferred();
  let requests = 0,
    slices = 0;
  const initial = prepared(5);
  initial.file = {
    byteLength: fixture.byteLength,
    async slice(a, b) {
      slices++;
      payload.resolve();
      await release.promise;
      return fixture.slice(a, b);
    },
  };
  const reader = createCommentReader(
    {},
    {
      prepared: initial,
      fetcher: async () => {
        requests++;
        return new Response(fixture);
      },
    },
  );
  const one = reader.read(range),
    two = reader.read(range);
  try {
    await payload.promise;
    assert.equal(requests, 0, 'current row reads must not wait for later metadata');
    assert.equal(slices, 1, 'concurrent callers share the row payload');
    release.resolve();
    const results = await Promise.all([one, two]);
    assert.equal(requests, 4);
    assert.equal(results[0].length, 10);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(
      results[0].map(row => row.order),
      [0, 2, 4, 6, 8, 1, 3, 5, 7, 9],
    );
  } finally {
    release.resolve();
    await Promise.allSettled([one, two]);
    await reader.close();
  }
});

test('cancellation stops the demanded archive and never starts later parts', async () => {
  const controller = new AbortController(),
    requested = deferred();
  let requests = 0,
    active = 0;
  const reader = createCommentReader(
    {},
    {
      signal: controller.signal,
      prepared: prepared(5),
      fetcher: async (_, {signal}) => {
        requests++;
        active++;
        requested.resolve();
        try {
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        } finally {
          active--;
        }
      },
    },
  );
  const rejected = assert.rejects(reader.read(range), {name: 'AbortError'});
  await requested.promise;
  controller.abort();
  await rejected;
  await reader.close();
  assert.equal(requests, 1);
  assert.equal(active, 0);
});

test('a transient open failure retries once inside the first demanded window', async () => {
  let requests = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: prepared(2),
      fetcher: async () => (++requests === 1 ? new Response('', {status: 503}) : new Response(fixture)),
    },
  );
  try {
    assert.equal((await reader.read(range)).length, 4);
    assert.equal(requests, 2);
  } finally {
    await reader.close();
  }
});

test('missing archives do not retry, and failed cleanup remains owned until close', async () => {
  let requests = 0;
  const missing = createCommentReader(
    {},
    {
      prepared: prepared(2),
      fetcher: async () => {
        requests++;
        return new Response('', {status: 404});
      },
    },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(missing.read(range), /没有弹幕归档/);
  await missing.close();
  assert.equal(requests, 1);
  let removes = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: prepared(2),
      fetcher: async () => new Response(fixture),
      createTemporary: async () => ({
        handle: {
          async createWritable() {
            throw new Error('disk creation failed');
          },
        },
        async remove() {
          if (++removes === 1) throw new Error('cleanup busy');
        },
      }),
    },
  );
  await assert.rejects(reader.read(range), /disk creation failed/);
  await reader.close();
  assert.equal(removes, 2);
});

test('initial index and first snapshot preparation also retry transient reads once', async () => {
  const {prepareComments} = await import('../../../src/danmaku/archive.js');
  let indexes = 0,
    snapshots = 0;
  const result = await prepareComments(
    {room: 1, key: 'initial'},
    {
      fetcher: async url => {
        if (url.endsWith('index.json')) {
          if (++indexes === 1) return new Response('', {status: 503});
          return new Response(
            JSON.stringify({schemaVersion: 1, live: [{live_key: 'initial', part: 0, path: 'live-archive/p0.parquet'}]}),
          );
        }
        if (++snapshots === 1) throw new TypeError('temporary connection failure');
        return new Response(fixture);
      },
    },
  );
  assert.equal(indexes, 2);
  assert.equal(snapshots, 2);
  assert.equal(result.file.byteLength, fixture.byteLength);
});

function sealedFetch(data, bytes, {ignoreRange = false} = {}) {
  const requests = [];
  return {
    requests,
    async fetcher(url, options) {
      if (url.endsWith('index.json'))
        return Response.json({
          schemaVersion: 1,
          sessions: [{live_key: 'x', part: 0, path: 'live-archive/x.parquet', bytes}],
        });
      requests.push(options.headers?.Range);
      if (!options.headers?.Range || ignoreRange) return new Response(data);
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      return new Response(data.slice(Number(a), Number(b) + 1), {
        status: 206,
        headers: {'Content-Range': `bytes ${a}-${b}/${data.byteLength}`, ETag: 'sealed'},
      });
    },
  };
}

// Preserve column offsets while moving the footer past padding to exercise the cutoff.
function paddedFixture(size) {
  const footerLength = new DataView(fixture).getUint32(fixture.byteLength - 8, true) + 8;
  const data = new Uint8Array(size);
  data.set(new Uint8Array(fixture));
  data.set(new Uint8Array(fixture.slice(-footerLength)), size - footerLength);
  return data.buffer;
}

for (const size of [fixture.byteLength, 8 * 1024 * 1024])
  test(`sealed archive of ${size} bytes uses one download for metadata and disk-backed row windows`, async () => {
    const network = sealedFetch(paddedFixture(size), size);
    const initial = await prepareComments({room: 1, key: 'x'}, network);
    assert.ok(initial.file instanceof ArrayBuffer);
    const handle = memoryFile('comments.parquet');
    let removed = 0;
    const reader = createCommentReader(
      {},
      {
        prepared: initial,
        fetcher: network.fetcher,
        createTemporary: async () => ({
          handle,
          remove: async () => {
            removed++;
          },
        }),
      },
    );
    try {
      assert.equal((await reader.read(range)).length, 2);
      assert.equal((await reader.read({...range, start: 91})).length, 2);
      assert.equal(handle.stats.writes, 1);
      assert.equal((await handle.getFile()).size, size);
      assert.ok(!(initial.file instanceof ArrayBuffer), 'the buffer is handed off to temporary disk');
      assert.deepEqual(network.requests, [undefined]);
    } finally {
      await reader.close();
    }
    assert.equal(removed, 1);
  });

for (const bytes of [fixture.byteLength - 1, fixture.byteLength + 1, '123', null, 8.5, 0])
  test(`sealed archive rejects inconsistent index bytes ${JSON.stringify(bytes)}`, async () => {
    const network = sealedFetch(fixture, bytes);
    await assert.rejects(prepareComments({room: 1, key: 'x'}, network), /归档读取期间发生变化/);
    assert.equal(network.requests.length, 1, 'integrity errors must not retry');
  });

for (const ignoreRange of [false, true])
  test(`large sealed archives retain Range probing (server ignores Range: ${ignoreRange})`, async () => {
    const size = 8 * 1024 * 1024 + 1;
    const network = sealedFetch(paddedFixture(size), size, {ignoreRange});
    const initial = await prepareComments({room: 1, key: 'x'}, network);
    const reader = createCommentReader({}, {prepared: initial, fetcher: network.fetcher});
    try {
      assert.equal((await reader.read(range)).length, 2);
      assert.equal(network.requests[0], 'bytes=0-0');
      assert.equal(initial.file instanceof ArrayBuffer, ignoreRange);
      assert.ok(ignoreRange ? network.requests.length === 1 : network.requests.length > 2);
    } finally {
      await reader.close();
    }
  });

test('Range fallback and ignored Range responses still validate indexed size', async () => {
  for (const ignoreRange of [false, true]) {
    const network = sealedFetch(fixture, 8 * 1024 * 1024 + 1, {ignoreRange});
    await assert.rejects(prepareComments({room: 1, key: 'x'}, network), /归档读取期间发生变化/);
    assert.deepEqual(network.requests, ['bytes=0-0']);
  }
});

const before = new Uint8Array(await readFile(new URL('../fixtures/live-before.parquet', import.meta.url))).buffer;
const after = new Uint8Array(await readFile(new URL('../fixtures/live-after.parquet', import.meta.url))).buffer;
const livePart = {live_key: 'growing', part: 1, started_ms: 95000, path: 'live-archive/live/growing.parquet', bytes: 1};

function liveReader({files = [before, after], index, wait, onFile, time = 110000, onWait, waitForCoverage} = {}) {
  const state = {indexes: 0, files: [], waits: [], temporary: []};
  const controller = new AbortController();
  const metrics = createExportMetrics();
  const reader = createCommentReader(
    {room: 1, key: 'growing'},
    {
      signal: controller.signal,
      metrics,
      onWait,
      waitForCoverage,
      now: () => time,
      wait: async (ms, signal) => {
        state.waits.push(ms);
        if (wait) await wait(ms, signal);
        time += ms;
      },
      fetcher: async (url, options) => {
        if (url.endsWith('index.json')) {
          const count = ++state.indexes;
          return Response.json(index ? index(count) : {schemaVersion: 1, live: [livePart]});
        }
        assert.equal(options.headers?.Range, undefined, 'live snapshots and small sealed replacements download whole');
        const bytes = files[Math.min(state.files.length, files.length - 1)];
        state.files.push(url);
        await onFile?.(options.signal, state.files.length);
        return bytes === null ? new Response('', {status: 404}) : new Response(bytes);
      },
      createTemporary: async () => {
        const storage = {
          handle: memoryFile(),
          removes: 0,
          async remove() {
            this.removes++;
          },
        };
        state.temporary.push(storage);
        return storage;
      },
    },
  );
  return {reader, state, metrics, controller};
}

const firstWindow = {origin: 0, start: 98, end: 108};
const nextWindow = {origin: 0, start: 108, end: 118};

test('preview refreshes live coverage once and returns available comments without polling', async () => {
  const {reader, state} = liveReader({files: [before], waitForCoverage: false});
  try {
    const events = await reader.read(nextWindow);
    assert.deepEqual(
      events.map(event => event.text),
      ['110000'],
    );
    assert.equal(state.indexes, 2, 'initial index plus one immediate refresh');
    assert.equal(state.files.length, 2);
    assert.deepEqual(state.waits, [], 'the video clock must not wait for a future snapshot');
  } finally {
    await reader.close();
  }
});

test('growing snapshots supply later windows without duplicate boundary comments and retire old disk/cache generations', async () => {
  const {reader, state, metrics} = liveReader();
  try {
    const first = await reader.read(firstWindow);
    assert.deepEqual(
      first.map(row => row.text),
      ['100000'],
    );
    assert.equal(state.files.length, 1, 'the initial snapshot already covers this window');
    assert.equal(await reader.read({...nextWindow, prefetch: true}), null);
    assert.equal(state.indexes, 1, 'prefetch cannot poll the index');
    assert.equal(state.files.length, 1, 'prefetch cannot refresh a snapshot');
    const next = await reader.read(nextWindow);
    const last = await reader.read({origin: 0, start: 118, end: 128});
    assert.deepEqual(
      [...first, ...next, ...last].map(row => row.text),
      ['100000', '110000', '120000'],
    );
    assert.equal(state.files.length, 2, 'covered windows reuse the replacement');
    assert.equal(state.indexes, 2);
    assert.equal(state.temporary[0].removes, 1);
    assert.equal(state.temporary[1].removes, 0);
    const logged = performanceLog(metrics.snapshot());
    assert.equal(logged.counters.archiveRefreshes, 1);
    assert.equal(logged.stages.archiveRefreshWait.count, 1);
    assert.equal(logged.gauges.archiveLagMs.current, 0);
  } finally {
    await reader.close();
  }
  assert.ok(state.temporary.every(storage => storage.removes === 1));
});

test('sealing mid-export switches paths and uses the sealed file even past its last event', async () => {
  const {reader, state} = liveReader({
    index: count =>
      count === 1
        ? {schemaVersion: 1, live: [livePart]}
        : {schemaVersion: 1, sessions: [{...livePart, bytes: after.byteLength, path: 'live-archive/sealed.parquet'}]},
  });
  try {
    await reader.read(firstWindow);
    assert.deepEqual(
      (await reader.read({origin: 0, start: 108, end: 200})).map(row => row.text),
      ['110000', '120000', '130000'],
    );
    assert.ok(state.files.at(-1).endsWith('/sealed.parquet'));
    assert.deepEqual(await reader.read({origin: 0, start: 200, end: 210}), []);
    assert.equal(state.files.length, 2);
    assert.equal(state.temporary[0].removes, 1);
    assert.deepEqual(state.waits, []);
  } finally {
    await reader.close();
  }
});

test('a changed live path is reread from the index and growing bytes never use sealed size validation', async () => {
  const {reader, state} = liveReader({
    index: count => ({
      schemaVersion: 1,
      live: [
        {
          ...livePart,
          bytes: count === 1 ? before.byteLength - 1 : before.byteLength,
          path: count === 1 ? livePart.path : 'live-archive/live/new-path.parquet',
        },
      ],
    }),
  });
  try {
    await reader.read(firstWindow);
    assert.equal((await reader.read(nextWindow)).length, 1);
    assert.ok(state.files.at(-1).endsWith('/new-path.parquet'));
  } finally {
    await reader.close();
  }
});

test('a stale snapshot stops polling at the bound, returns available rows and logs the remaining coverage gap', async () => {
  const {reader, state, metrics} = liveReader({files: [before]});
  try {
    const rows = await reader.read(nextWindow);
    assert.deepEqual(
      rows.map(row => row.text),
      ['110000'],
    );
    assert.deepEqual(state.waits, [10000, 10000, 10000]);
    assert.equal(state.files.length, 5);
    const logged = performanceLog(metrics.snapshot());
    assert.equal(logged.counters.archiveRefreshes, 4);
    assert.deepEqual(logged.gauges.archiveLagMs, {current: 10000, peak: 10000});
    assert.ok(state.temporary.slice(0, -1).every(storage => storage.removes === 1));
  } finally {
    await reader.close();
  }
  assert.ok(state.temporary.every(storage => storage.removes === 1));
});

test('an already expired wall-clock bound still tries one fresh snapshot but does not sleep', async () => {
  const {reader, state, metrics} = liveReader({files: [before], time: 200000});
  try {
    assert.equal((await reader.read(nextWindow)).length, 1);
    assert.equal(state.files.length, 2);
    assert.deepEqual(state.waits, []);
    assert.equal(metrics.snapshot().gauges.archiveLagMs.current, 10000);
  } finally {
    await reader.close();
  }
});

for (const close of [false, true])
  test(`cancel interrupts a real polling wait and removes every temporary snapshot (reader close: ${close})`, async () => {
    const waiting = deferred();
    const {reader, state, controller} = liveReader({
      files: [before],
      wait: (ms, signal) => {
        waiting.resolve();
        return waitForRetry(ms, signal);
      },
    });
    const rejected = assert.rejects(reader.read(nextWindow), {name: 'AbortError'});
    await waiting.promise;
    if (close) await reader.close();
    else controller.abort();
    await rejected;
    if (!close) await reader.close();
    assert.equal(state.files.length, 2);
    assert.ok(state.temporary.every(storage => storage.removes === 1));
  });

test('live object deletion during sealing polls the index again instead of losing the usable snapshot', async () => {
  const {reader, state} = liveReader({
    files: [before, null, after],
    index: count =>
      count < 3
        ? {schemaVersion: 1, live: [livePart]}
        : {schemaVersion: 1, sessions: [{...livePart, bytes: after.byteLength, path: 'live-archive/sealed.parquet'}]},
  });
  try {
    assert.equal((await reader.read(nextWindow)).length, 1);
    assert.deepEqual(state.waits, [10000]);
    assert.ok(state.files.at(-1).endsWith('/sealed.parquet'));
  } finally {
    await reader.close();
  }
});

test('a regressed live snapshot cannot replace a newer generation', async () => {
  const {reader, state, metrics} = liveReader({files: [after, before], time: 200000});
  try {
    assert.deepEqual(
      (await reader.read({origin: 0, start: 118, end: 140})).map(row => row.text),
      ['120000', '130000'],
    );
    assert.equal(state.temporary[0].removes, 0);
    assert.equal(state.temporary[1].removes, 1);
    assert.equal(metrics.snapshot().gauges.archiveLagMs.current, 12000);
  } finally {
    await reader.close();
  }
});

test('coverage comes from reception statistics even with null rows, never sent times or upload metadata', async () => {
  const metadata = await readMetadata(before);
  assert.equal(snapshotCoverage(metadata), 110);
  const copy = structuredClone(metadata);
  const stats = copy.row_groups[0].columns.find(column => column.meta_data.path_in_schema[0] === 't').meta_data;
  stats.statistics.null_count = 1n;
  assert.equal(snapshotCoverage(copy), 110);
  stats.statistics.is_max_value_exact = false;
  assert.equal(snapshotCoverage(copy), 0, 'an inexact maximum cannot claim coverage');
  delete stats.statistics;
  assert.equal(snapshotCoverage(copy), 0, 'missing reception statistics must not claim coverage');
});

test('a stalled refresh request is canceled by the total budget and proceeds with available rows', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const requested = deferred();
  let canceled = false;
  const {reader, metrics, state} = liveReader({
    files: [before],
    onFile: (signal, count) => {
      if (count === 1) return;
      requested.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            reject(signal.reason);
          },
          {once: true},
        ),
      );
    },
  });
  try {
    const pending = reader.read(nextWindow);
    await requested.promise;
    t.mock.timers.tick(30000);
    assert.deepEqual(
      (await pending).map(row => row.text),
      ['110000'],
    );
    assert.equal(canceled, true);
    assert.equal(state.files.length, 2);
    assert.equal(metrics.snapshot().gauges.archiveLagMs.current, 10000);
  } finally {
    await reader.close();
  }
});

test('new partitions discovered while sealing also supply the demanded window', async () => {
  const {reader, state} = liveReader({
    files: [before, before, after],
    index: count =>
      count === 1
        ? {schemaVersion: 1, live: [livePart]}
        : {
            schemaVersion: 1,
            sessions: [
              {...livePart, bytes: before.byteLength, path: 'live-archive/sealed-1.parquet'},
              {...livePart, part: 2, bytes: after.byteLength, path: 'live-archive/sealed-2.parquet'},
            ],
          },
  });
  try {
    assert.deepEqual(
      (await reader.read({origin: 0, start: 118, end: 128})).map(row => row.text),
      ['120000'],
    );
    assert.equal(state.files.length, 3);
    assert.ok(state.files.at(-1).endsWith('/sealed-2.parquet'));
  } finally {
    await reader.close();
  }
});

test('a malformed replacement remains fatal instead of being mistaken for archive lag', async () => {
  const {reader, state} = liveReader({files: [before, new Uint8Array(20).buffer]});
  try {
    await assert.rejects(reader.read(nextWindow), /parquet|PAR1/i);
    assert.equal(state.temporary[0].removes, 0);
  } finally {
    await reader.close();
  }
  assert.ok(state.temporary.every(storage => storage.removes === 1));
});

const progressBefore = new Uint8Array(
  await readFile(new URL('../fixtures/live-progress-before.parquet', import.meta.url)),
).buffer;
const progressAfter = new Uint8Array(
  await readFile(new URL('../fixtures/live-progress-after.parquet', import.meta.url)),
).buffer;

test('the collector-stated completeness, schedule and stream clock are read from the snapshot', async () => {
  const {snapshotSchedule, streamClock} = await import('../../../src/danmaku/parquet.js');
  const metadata = await readMetadata(progressBefore);
  assert.equal(snapshotCoverage(metadata), 112, 'complete_through_ms beats the 110 s maximum event');
  assert.deepEqual(snapshotSchedule(metadata), {published: 110.5, interval: 10});
  assert.equal(streamClock(metadata).epochs[0].origin_us, 95_500_000);
  const old = await readMetadata(before);
  assert.equal(snapshotCoverage(old), 110, 'older snapshots keep the reception-statistics fallback');
  assert.equal(snapshotSchedule(old), null);
  assert.equal(streamClock(old), null);
});

test('a quiet stretch inside the stated completeness needs no refresh', async () => {
  const {reader, state} = liveReader({files: [progressBefore, progressAfter], time: 113000});
  try {
    // Platform window ends at 111 s: no event there, but the collector says it is complete through 112 s.
    const rows = await reader.read({origin: 0, start: 100, end: 109});
    assert.deepEqual(
      rows.map(row => row.text),
      ['110000'],
    );
    assert.equal(state.indexes, 1, 'only the initial index read, no refresh poll');
    assert.equal(state.files.length, 1);
  } finally {
    await reader.close();
  }
});

test('waiting reports the missing seconds and polls at the collector schedule', async () => {
  const reports = [];
  const {reader, state} = liveReader({
    files: [progressBefore, progressBefore, progressAfter],
    time: 113000,
    onWait: value => reports.push(value),
  });
  try {
    const rows = await reader.read(nextWindow);
    assert.deepEqual(
      rows.map(row => row.text),
      ['110000'],
    );
    assert.deepEqual(state.waits, [10000], 'the same snapshot again: the collector is quiet, back off');
    assert.deepEqual(reports, [{coverage: 112, needed: 120, delay: 10000}, null]);
  } finally {
    await reader.close();
  }
});

test('next snapshot delay follows the schedule with upload slack, bounded to 3-10 s', async () => {
  const {nextSnapshotDelay} = await import('../../../src/danmaku/archive.js');
  const schedule = {published: 110.5, interval: 10};
  assert.equal(nextSnapshotDelay(schedule, 100, 113000), 9500);
  assert.equal(nextSnapshotDelay(schedule, 100, 121000), 3000, 'overdue: retry soon, never hammer');
  assert.equal(nextSnapshotDelay(schedule, 110.5, 113000), 10000, 'unchanged snapshot');
  assert.equal(nextSnapshotDelay(null, undefined, 113000), 10000);
});

test('the wait message states how much danmaku is still missing', async () => {
  const {danmakuWaitMessage} = await import('../../../src/media/streaming-export.js');
  assert.equal(
    danmakuWaitMessage({coverage: 112, needed: 120, delay: 9500}),
    '等待直播弹幕：还差约 8 秒弹幕，约 10 秒后更新',
  );
  assert.equal(
    danmakuWaitMessage({coverage: 0, needed: 120, delay: 10000}),
    '等待直播弹幕：正在确认弹幕进度，约 10 秒后更新',
  );
});

test('canceling one preview read leaves shared archives usable by the next seek', async () => {
  const started = deferred();
  let requests = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: {
        file: fixture,
        metadata,
        parts: [0, 1].map(part => ({part, path: `live-archive/p${part}.parquet`, bytes: fixture.byteLength})),
      },
      fetcher: async (_, {signal}) => {
        if (++requests === 1) {
          started.resolve();
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        }
        return new Response(fixture);
      },
    },
  );
  const oldSeek = new AbortController();
  try {
    const pending = reader.read({...range, signal: oldSeek.signal});
    const rejected = assert.rejects(pending, {name: 'AbortError'});
    await started.promise;
    const next = reader.read(range);
    oldSeek.abort();
    await rejected;
    assert.equal((await next).length, 4);
    assert.equal((await reader.read(range)).length, 4);
    assert.equal(requests, 2, 'only the canceled partition is requested again');
  } finally {
    await reader.close();
  }
});

test('preview file budget evicts old partitions but retains bounds to skip unrelated seeks', async () => {
  const initial = {
    file: before,
    metadata: await readMetadata(before),
    parts: [0, 1].map(part => ({part, path: `live-archive/p${part}.parquet`, bytes: before.byteLength})),
  };
  const requests = [];
  const reader = createCommentReader(
    {},
    {
      prepared: initial,
      maxArchiveBytes: before.byteLength,
      fetcher: async url => {
        requests.push(url.split('/').at(-1));
        return new Response(before);
      },
    },
  );
  try {
    assert.equal((await reader.read(range)).length, 4);
    assert.deepEqual(requests, ['p1.parquet']);
    assert.equal(initial.file, null, 'the first prepared buffer must not bypass eviction');
    assert.deepEqual(await reader.read({...range, start: 200, end: 210}), []);
    assert.deepEqual(requests, ['p1.parquet'], 'cached time bounds skip evicted files too');
    assert.equal((await reader.read(range)).length, 4);
    assert.deepEqual(requests, ['p1.parquet', 'p0.parquet', 'p1.parquet']);
  } finally {
    await reader.close();
  }
});

test('an evicted live snapshot reloads metadata and rows from the new generation', async () => {
  const initial = {
    file: before,
    metadata: await readMetadata(before),
    parts: [{...livePart, snapshot: true}],
  };
  let requests = 0;
  const reader = createCommentReader(
    {},
    {
      prepared: initial,
      maxArchiveBytes: 0,
      waitForCoverage: false,
      fetcher: async () => {
        requests++;
        return new Response(after);
      },
    },
  );
  try {
    assert.deepEqual(
      (await reader.read(firstWindow)).map(row => row.text),
      ['100000'],
    );
    assert.equal(initial.file, null);
    assert.deepEqual(
      (await reader.read({origin: 0, start: 98, end: 128})).map(row => row.text),
      ['100000', '110000', '120000'],
    );
    assert.equal(requests, 1);
    assert.equal(snapshotCoverage(initial.metadata), 130);
  } finally {
    await reader.close();
  }
});

test('Range-backed archives bind payload reads to the current seek after cancellation', async () => {
  const network = sealedFetch(fixture);
  const started = deferred();
  let reading = false,
    requests = 0;
  const fetcher = async (url, options) => {
    if (reading && ++requests === 1) {
      started.resolve();
      await new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}),
      );
    }
    return network.fetcher(url, options);
  };
  const initial = await prepareComments({room: 1, key: 'x'}, {fetcher});
  const reader = createCommentReader({}, {prepared: initial, fetcher});
  const oldSeek = new AbortController();
  try {
    reading = true;
    const pending = reader.read({...range, signal: oldSeek.signal});
    const rejected = assert.rejects(pending, {name: 'AbortError'});
    await started.promise;
    oldSeek.abort();
    await rejected;
    assert.equal((await reader.read(range)).length, 2);
    const loaded = requests;
    assert.equal((await reader.read(range)).length, 2);
    assert.equal(requests, loaded, 'the completed row groups remain cached');
  } finally {
    await reader.close();
  }
});
