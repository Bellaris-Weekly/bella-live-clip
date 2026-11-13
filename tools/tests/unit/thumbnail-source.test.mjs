import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createThumbnailSource} from '../../../src/services/thumbnail-source.js';

const record = {key: '742106027349433696', start: 1000, uid: 123};
const sample = time => ({time, local: time, stream: {stream: 'media', start_time: 1000, end_time: 100000}});
const signal = () => new AbortController().signal;
const makeCanvas = () => ({
  width: 0,
  height: 0,
  args: [],
  getContext() {
    return {drawImage: (...args) => this.args.push(args), fillRect() {}};
  },
});
const decoded = () => ({...makeCanvas(), width: 320, height: 180, toBlob: callback => callback({size: 1})});

function fixture(overrides = {}) {
  const reads = [],
    urls = [],
    revoked = [];
  const original = {create: URL.createObjectURL, revoke: URL.revokeObjectURL};
  URL.createObjectURL = () => {
    urls.push(`blob:${urls.length}`);
    return urls.at(-1);
  };
  URL.revokeObjectURL = url => revoked.push(url);
  const source = createThumbnailSource({
    record,
    makeCanvas,
    request: async () => {},
    readFrame: async (_, item) => {
      reads.push(item.time);
      return decoded();
    },
    ...overrides,
  });
  return {
    source,
    reads,
    urls,
    revoked,
    restore() {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    },
  };
}

test('a decoded picture is reused and copied rather than moved out of the strip', async t => {
  const f = fixture(),
    s = signal();
  t.after(f.restore);
  const first = await f.source.read(sample(60), s),
    again = await f.source.read(sample(60), s);
  assert.deepEqual(f.reads, [60]);
  assert.notEqual(first, again, 'cached canvases must not be moved out of the visible strip');
  assert.equal(first.width, 160);
  assert.equal(first.height, 90);
  f.source.dispose();
});

test('a drag finds the nearest decoded picture, within reason', async t => {
  const f = fixture(),
    s = signal();
  t.after(f.restore);
  for (const time of [600, 60, 1200]) await f.source.read(sample(time), s);
  assert.equal(f.source.frameUrl(100), 'blob:1');
  assert.equal(f.source.frameUrl(590), 'blob:0');
  assert.equal(f.source.frameUrl(1000), 'blob:2');
  assert.equal(f.source.frameUrl(1600), null, 'a picture from far away would mislead');
  assert.equal(f.source.hasFrame(600), true);
  assert.equal(f.source.hasFrame(601), false);
});

test('each new picture is announced, and leaving releases them all', async t => {
  let announced = 0;
  const f = fixture({onFrames: () => announced++}),
    s = signal();
  t.after(f.restore);
  await f.source.read(sample(60), s);
  await f.source.read(sample(120), s);
  assert.equal(announced, 2);
  f.source.dispose();
  assert.deepEqual(f.revoked, ['blob:0', 'blob:1']);
  assert.equal(f.source.frameUrl(60), null);
});

test('the picture cache is bounded across long timeline exploration', async t => {
  const f = fixture(),
    s = signal();
  t.after(f.restore);
  for (let time = 0; time < 301; time++) await f.source.read(sample(time), s);
  await f.source.read(sample(300), s);
  assert.equal(f.reads.length, 301);
  await f.source.read(sample(0), s);
  assert.equal(f.reads.length, 302);
  f.source.dispose();
});

test('cancelled reads and disposal publish nothing late', async t => {
  let finish;
  const f = fixture({readFrame: () => new Promise(resolve => (finish = resolve))}),
    s = signal();
  t.after(f.restore);
  const pending = f.source.read(sample(60), s);
  await Promise.resolve();
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  f.source.dispose();
  finish(decoded());
  await rejected;
  assert.equal(f.urls.length, 0);
});

test('submission strips use the platform storyboard and keep decoding as a fallback', async t => {
  let disposed = false,
    reads = 0;
  const f = fixture({
    record: {kind: 'submission', bvid: 'BV-test', cid: 12},
    createStoryboard: () => ({
      async read(time) {
        reads++;
        if (time === 20) throw new Error('no storyboard');
        return {image: {}, x: 10, y: 20, width: 320, height: 180};
      },
      dispose() {
        disposed = true;
      },
    }),
  });
  t.after(f.restore);
  const s = signal();
  const frame = await f.source.read(sample(10), s);
  await f.source.read(sample(20), s);
  assert.equal(frame.args[0][0].args[0].length, 9);
  assert.equal(reads, 2);
  assert.deepEqual(f.reads, [20]);
  f.source.dispose();
  assert.equal(disposed, true);
});

test('concurrent identical reads share decoding and cancel only their own wait', async t => {
  let finish,
    child,
    reads = 0;
  const f = fixture({
    readFrame: (_, __, signal) => {
      reads++;
      child = signal;
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  t.after(f.restore);
  const a = new AbortController(),
    b = new AbortController();
  const first = assert.rejects(f.source.read(sample(60), a.signal), {name: 'AbortError'});
  const second = f.source.read(sample(60), b.signal);
  assert.equal(reads, 1);
  a.abort();
  await first;
  assert.equal(child.aborted, false);
  finish(decoded());
  const canvas = await second;
  assert.notEqual(await f.source.read(sample(60), signal()), canvas);
  assert.equal(reads, 1);
  assert.equal(f.urls.length, 1);
  f.source.dispose();
  assert.equal(child.aborted, true);
});

test('the last canceled waiter aborts immediately, allows retry and cannot publish a late frame', async t => {
  const pending = [];
  const f = fixture({readFrame: (_, __, signal) => new Promise(resolve => pending.push({resolve, signal}))});
  t.after(f.restore);
  const a = new AbortController(),
    b = new AbortController();
  const first = assert.rejects(f.source.read(sample(60), a.signal), {name: 'AbortError'});
  const second = assert.rejects(f.source.read(sample(60), b.signal), {name: 'AbortError'});
  a.abort();
  b.abort();
  assert.equal(pending[0].signal.aborted, true);
  const next = f.source.read(sample(60), signal());
  assert.equal(pending.length, 2);
  pending[0].resolve(decoded());
  await Promise.all([first, second]);
  assert.equal(f.urls.length, 0);
  pending[1].resolve(decoded());
  await next;
  assert.equal(f.urls.length, 1);
  f.source.dispose();
});

test('fragment-only drag reads do not wait on an unrelated slow fallback at the same time', async t => {
  let finish;
  const f = fixture({
    readFrame: (_, item) =>
      item.fragmentOnly
        ? Promise.resolve(decoded())
        : new Promise(resolve => {
            finish = resolve;
          }),
  });
  t.after(f.restore);
  const controller = new AbortController();
  const slow = assert.rejects(f.source.read(sample(60), controller.signal), {name: 'AbortError'});
  await f.source.read({...sample(60), fragmentOnly: true}, signal());
  assert.equal(f.urls.length, 1);
  controller.abort();
  finish(decoded());
  await slow;
  f.source.dispose();
});

test('JPEG URLs are LRU bounded and can be recreated from cached canvases without decoding again', async t => {
  const f = fixture({maxStills: 2});
  t.after(f.restore);
  for (const time of [0, 10]) await f.source.read(sample(time), signal());
  assert.equal(f.source.frameUrl(0), 'blob:0');
  await f.source.read(sample(20), signal());
  assert.deepEqual(f.revoked, ['blob:1']);
  assert.equal(f.source.hasFrame(10), false);
  await f.source.read(sample(10), signal());
  assert.equal(f.source.hasFrame(10), true);
  assert.deepEqual(f.reads, [0, 10, 20]);
  assert.equal(f.source.frameUrl(10), 'blob:3');
  f.source.dispose();
  assert.equal(f.revoked.length, f.urls.length);
  assert.equal(new Set(f.revoked).size, f.revoked.length);
});

test('JPEG cache also honors byte limits, and oversized or late blobs do not allocate URLs', async t => {
  const callbacks = [];
  const f = fixture({
    maxStillBytes: 3,
    readFrame: async () => ({...decoded(), toBlob: callback => callbacks.push(callback)}),
  });
  t.after(f.restore);
  for (const time of [0, 10, 20, 30]) await f.source.read(sample(time), signal());
  callbacks[0]({size: 2});
  callbacks[1]({size: 2});
  assert.deepEqual(f.revoked, ['blob:0']);
  callbacks[2]({size: 4});
  assert.equal(f.urls.length, 2);
  f.source.dispose();
  callbacks[3]({size: 2});
  assert.equal(f.urls.length, 2);
  assert.equal(f.revoked.length, 2);
});
