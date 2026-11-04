import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createCommentReader} from '../../../src/danmaku/archive.js';
import {readMetadata} from '../../../src/danmaku/parquet.js';
import {deferred} from '../../../src/shared/deferred.js';

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
