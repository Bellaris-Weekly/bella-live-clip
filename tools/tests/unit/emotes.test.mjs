import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadEmotes} from '../../../src/danmaku/emotes.js';

function codecs(t, fail = false) {
  const decoders = [],
    images = [],
    bitmaps = [];
  for (const key of ['ImageDecoder', 'createImageBitmap']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  globalThis.ImageDecoder = class {
    constructor({data}) {
      this.id = data[0];
      this.tracks = {ready: Promise.resolve(), selectedTrack: {frameCount: 2, repetitionCount: Infinity}};
      decoders.push(this);
    }
    async decode({frameIndex}) {
      const image = {
        id: this.id,
        frameIndex,
        displayWidth: 128,
        displayHeight: 128,
        duration: 100000,
        close() {
          this.closed = true;
        },
      };
      images.push(image);
      return {image};
    }
    close() {
      this.closed = true;
    }
  };
  globalThis.createImageBitmap = async (image, {resizeWidth, resizeHeight}) => {
    await new Promise(resolve => setImmediate(resolve));
    if (fail && image.id === 1 && image.frameIndex === 1) throw new Error('bitmap failed');
    const bitmap = {
      width: resizeWidth,
      height: resizeHeight,
      close() {
        this.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return bitmap;
  };
  return {decoders, images, bitmaps};
}

const catalog = {
  emotes: Array.from({length: 5}, (_, i) => ({
    name: `表情${i}`,
    kind: 'emoji',
    file: `${i}.png`,
    width: 128,
    height: 128,
  })),
};
const comments = catalog.emotes.map(entry => ({text: `[${entry.name}]`}));
const metadata = url => (url.endsWith('index.json') ? {catalog: 'catalog.json'} : catalog);

test('three emotes load concurrently, decoded animation order and cleanup stay intact', {timeout: 5000}, async t => {
  const owned = codecs(t);
  let active = 0,
    maximum = 0,
    release,
    started;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const firstThree = new Promise(resolve => {
    started = resolve;
  });
  const fetcher = async url => {
    if (url.endsWith('.json')) return new Response(JSON.stringify(metadata(url)));
    active++;
    maximum = Math.max(maximum, active);
    if (active === 3) started();
    await gate;
    active--;
    return new Response(new Uint8Array([Number(url.match(/(\d+)\.png$/)[1])]), {
      headers: {'Content-Type': 'image/png'},
    });
  };
  const loading = loadEmotes(comments, 1, 45, {fetcher});
  await firstThree;
  assert.equal(active, 3);
  release();
  const resources = await loading;
  assert.equal(maximum, 3);
  assert.equal(resources.assets.size, 5);
  for (const asset of resources.assets.values()) {
    assert.deepEqual(asset.ends, [0.1, 0.2]);
    assert.equal(asset.frames.length, 2);
    assert.equal(asset.width, 81);
  }
  assert.ok(owned.decoders.every(item => item.closed));
  assert.ok(owned.images.every(item => item.closed));
  resources.close();
  assert.ok(owned.bitmaps.every(item => item.closed));
});

test('one failed image releases sibling decoders and every bitmap before rejecting', async t => {
  const owned = codecs(t, true);
  const fetcher = async url =>
    new Response(
      url.endsWith('.json') ? JSON.stringify(metadata(url)) : new Uint8Array([Number(url.match(/(\d+)\.png$/)[1])]),
      {headers: {'Content-Type': 'image/png'}},
    );
  await assert.rejects(loadEmotes(comments, 1, 45, {fetcher}), /bitmap failed/);
  assert.ok(owned.decoders.length >= 2);
  assert.ok(owned.decoders.every(item => item.closed));
  assert.ok(owned.images.every(item => item.closed));
  assert.ok(owned.bitmaps.length > 0);
  assert.ok(owned.bitmaps.every(item => item.closed));
});

test('lazy emotes fetch only when visible and decode only the required animation phase', async t => {
  const owned = codecs(t),
    requests = [],
    budget = {used: 0, compressed: 0};
  const fetcher = async url => {
    requests.push(url);
    return new Response(
      url.endsWith('.json') ? JSON.stringify(metadata(url)) : new Uint8Array([Number(url.match(/(\d+)\.png$/)[1])]),
      {headers: {'Content-Type': 'image/png'}},
    );
  };
  const resources = await loadEmotes(comments, 1, 45, {fetcher, lazy: true, budget});
  assert.equal(requests.filter(url => url.endsWith('.png')).length, 0);
  assert.equal(owned.images.length, 0);
  const asset = resources.assets.get('[表情0]');
  await asset.prepare(0.05);
  assert.equal(requests.filter(url => url.endsWith('.png')).length, 1);
  assert.equal(owned.images.length, 1);
  await asset.prepare(0.08);
  assert.equal(owned.images.length, 1);
  await asset.prepare(0.15);
  assert.equal(owned.images.length, 2);
  await asset.prepare(3);
  assert.equal(owned.images.length, 2);
  assert.equal(budget.compressed, 0, 'completed animation releases its compressed decoder input');
  resources.close();
  assert.equal(budget.used, 0);
  assert.ok(owned.bitmaps.every(bitmap => bitmap.closed));
});

test('canceling an in-flight lazy bitmap releases a late result and its byte reservation', async t => {
  const owned = codecs(t),
    controller = new AbortController(),
    budget = {used: 0, compressed: 0};
  let release, started;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const beginning = new Promise(resolve => {
    started = resolve;
  });
  const original = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (...args) => {
    started();
    await gate;
    return original(...args);
  };
  const fetcher = async url =>
    new Response(url.endsWith('.json') ? JSON.stringify(metadata(url)) : new Uint8Array([0]), {
      headers: {'Content-Type': 'image/png'},
    });
  const resources = await loadEmotes(comments, 1, 45, {fetcher, lazy: true, signal: controller.signal, budget});
  const preparing = resources.assets.get('[表情0]').prepare(0);
  const canceled = assert.rejects(preparing, {name: 'AbortError'});
  await beginning;
  controller.abort();
  release();
  await canceled;
  resources.close();
  assert.equal(budget.used, 0);
  assert.equal(budget.compressed, 0);
  assert.ok(owned.bitmaps.every(bitmap => bitmap.closed));
  assert.ok(owned.images.every(image => image.closed));
});

test('prefetch keeps bounded compressed bytes without a decoder and demand reuses them', async t => {
  const owned = codecs(t),
    budget = {used: 0, compressed: 0};
  let requests = 0;
  const counters = {};
  const resources = await loadEmotes([comments[0]], 1, 45, {
    lazy: true,
    budget,
    selected: new Map([['[表情0]', catalog.emotes[0]]]),
    metrics: {start() {}, add: name => (counters[name] = (counters[name] ?? 0) + 1)},
    fetcher: async () => {
      requests++;
      return new Response(new Uint8Array([0]));
    },
  });
  const asset = resources.assets.get('[表情0]');
  await Promise.all([asset.prefetch(), asset.prefetch()]);
  assert.equal(requests, 1);
  assert.equal(owned.decoders.length, 0);
  assert.equal(budget.compressed, 1);
  await asset.prepare(0);
  assert.equal(requests, 1);
  assert.equal(counters.emotePrefetches, 1);
  assert.equal(counters.emotePrefetchHits, 1);
  resources.close();
  assert.equal(budget.used, 0);
  assert.equal(budget.compressed, 0);
  assert.ok(owned.decoders.every(item => item.closed));
});

test('failed speculative fetch and compressed budget overflow retry on demand', async t => {
  codecs(t);
  let requests = 0;
  const budget = {used: 0, compressed: 16 * 1024 * 1024};
  const resources = await loadEmotes([comments[0]], 1, 45, {
    lazy: true,
    budget,
    selected: new Map([['[表情0]', catalog.emotes[0]]]),
    fetcher: async () => {
      if (++requests === 1) throw new Error('speculation failed');
      return new Response(new Uint8Array([0]));
    },
  });
  const asset = resources.assets.get('[表情0]');
  await asset.prefetch();
  await asset.prefetch();
  assert.equal(budget.compressed, 16 * 1024 * 1024);
  budget.compressed = 0;
  await asset.prepare(0);
  assert.equal(requests, 3);
  resources.close();
  assert.equal(budget.compressed, 0);
});

test('abort closes a speculative fetch and ignores late bytes without creating decoders', async t => {
  const owned = codecs(t),
    controller = new AbortController(),
    budget = {used: 0, compressed: 0};
  let release, fetchSignal;
  const resources = await loadEmotes([comments[0]], 1, 45, {
    lazy: true,
    budget,
    signal: controller.signal,
    selected: new Map([['[表情0]', catalog.emotes[0]]]),
    fetcher: (_, {signal}) => {
      fetchSignal = signal;
      return new Promise(resolve => {
        release = resolve;
      });
    },
  });
  const pending = resources.assets.get('[表情0]').prefetch();
  controller.abort();
  assert.ok(fetchSignal.aborted);
  release(new Response(new Uint8Array([0])));
  await pending;
  resources.close();
  assert.equal(budget.compressed, 0);
  assert.equal(owned.decoders.length, 0);
});

test('lazy metadata still enforces the 128-entry cap before starting image requests', async t => {
  codecs(t);
  const entries = Array.from({length: 129}, (_, i) => [`[图${i}]`, catalog.emotes[0]]);
  await assert.rejects(
    loadEmotes(
      entries.map(([text]) => ({text})),
      1,
      40,
      {
        lazy: true,
        selected: new Map(entries),
        fetcher() {
          assert.fail('entry cap must precede fetching');
        },
      },
    ),
    /缓存上限/,
  );
});

test('evicting an in-flight speculative asset cannot reserve bytes after it closes', async t => {
  codecs(t);
  const budget = {used: 0, compressed: 0};
  const resources = await loadEmotes([comments[0]], 1, 40, {
    lazy: true,
    budget,
    selected: new Map([['[表情0]', catalog.emotes[0]]]),
    fetcher: async () => new Response(new Uint8Array([0])),
  });
  const asset = resources.assets.get('[表情0]');
  budget.makeRoom = () => asset.close();
  await asset.prefetch();
  assert.equal(budget.compressed, 0);
  assert.equal(budget.used, 0);
  resources.close();
});
