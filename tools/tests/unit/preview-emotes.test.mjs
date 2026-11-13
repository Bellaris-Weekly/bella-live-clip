import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewEmoteCache} from '../../../src/danmaku/preview-emotes.js';
import {deferred} from '../../../src/shared/deferred.js';

const entry = file => ({file});
test('preview shares catalog and compressed bytes across seeks; canceling a waiter preserves the download', async () => {
  const started = deferred(),
    gate = deferred(),
    urls = [];
  let downloadSignal;
  const cache = createPreviewEmoteCache(1, {
    fetcher: async (url, {signal}) => {
      urls.push(url);
      if (url.endsWith('index.json')) return Response.json({catalog: 'catalog.json'});
      if (url.endsWith('catalog.json')) return Response.json({emotes: []});
      downloadSignal = signal;
      started.resolve();
      await gate.promise;
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  try {
    assert.equal(await cache.catalog(), await cache.catalog());
    const old = new AbortController();
    const a = cache.read(entry('a.png'), old.signal);
    const rejected = assert.rejects(a, {name: 'AbortError'});
    await started.promise;
    old.abort();
    await rejected;
    assert.equal(downloadSignal.aborted, false);
    const b = cache.read(entry('a.png'));
    gate.resolve();
    assert.deepEqual(Array.from((await b).bytes), [1, 2, 3]);
    await cache.read(entry('a.png'));
    assert.equal(urls.length, 3);
  } finally {
    cache.close();
  }
  assert.throws(() => cache.read(entry('a.png')), {name: 'AbortError'});
});

test('preview emote cache obeys byte and entry budgets and retries failed resources', async () => {
  const counts = new Map();
  let fail = true;
  const cache = createPreviewEmoteCache(1, {
    maxBytes: 4,
    maxEntries: 2,
    fetcher: async url => {
      const key = url.split('/').at(-1);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (key === 'bad.png' && fail) return new Response('', {status: 503});
      return new Response(new Uint8Array(2));
    },
  });
  try {
    await cache.read(entry('a.png'));
    await cache.read(entry('b.png'));
    await cache.read(entry('a.png'));
    await cache.read(entry('c.png'));
    await cache.read(entry('b.png'));
    assert.equal(counts.get('a.png'), 1);
    assert.equal(counts.get('b.png'), 2);
    await assert.rejects(cache.read(entry('bad.png')), /503/);
    fail = false;
    await cache.read(entry('bad.png'));
    assert.equal(counts.get('bad.png'), 2);
    cache.discard(entry('bad.png'));
    await cache.read(entry('bad.png'));
    assert.equal(counts.get('bad.png'), 3);
  } finally {
    cache.close();
  }
});

test('rapid seeks share at most three emote downloads and releasing the source cancels them', async () => {
  const started = deferred();
  let active = 0,
    peak = 0,
    requests = 0;
  const cache = createPreviewEmoteCache(1, {
    fetcher: async (_, {signal}) => {
      requests++;
      active++;
      peak = Math.max(peak, active);
      if (active === 3) started.resolve();
      try {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      } finally {
        active--;
      }
    },
  });
  const pending = Array.from({length: 9}, (_, i) => cache.read(entry(`${i}.png`)));
  const settled = Promise.allSettled(pending);
  await started.promise;
  cache.close();
  assert.ok((await settled).every(r => r.status === 'rejected'));
  assert.equal(peak, 3);
  assert.equal(requests, 3);
  assert.equal(active, 0);
});

test('a failed shared catalog is retried and successful results are retained', async () => {
  let requests = 0;
  const cache = createPreviewEmoteCache(1, {
    fetcher: async url => {
      if (++requests === 1) return new Response('', {status: 503});
      return Response.json(url.endsWith('index.json') ? {catalog: 'catalog.json'} : {emotes: []});
    },
  });
  try {
    await assert.rejects(cache.catalog(), /503/);
    const selected = await cache.catalog();
    assert.equal(await cache.catalog(), selected);
    assert.equal(requests, 3);
  } finally {
    cache.close();
  }
});
