import {test} from 'node:test';
import assert from 'node:assert/strict';
import {thumbnailSamples, createThumbnails} from '../../../src/media/thumbnails.js';
const record = {start: 1000};
const streams = [
  {start_time: 1000, end_time: 1020, stream: 'first'},
  {start_time: 1040, end_time: 1060, stream: 'second'},
];
const wait = () => new Promise(resolve => setTimeout(resolve, 230));
test('投稿缩略图使用视频时间，不需要伪造直播时间和 HLS 分片', () => {
  for (const view of [
    {start: 0, end: 60},
    {start: 71, end: 83},
  ]) {
    const submission = {kind: 'submission', duration: 100};
    const samples = thumbnailSamples(submission, [], view);
    assert.equal(samples.length, 6);
    assert.ok(
      samples.every(
        sample =>
          sample.stream === submission &&
          sample.local === sample.time &&
          sample.time > view.start &&
          sample.time < view.end,
      ),
    );
  }
});
class Element {
  children = [];
  textContent = '';
  style = {};
  ownerDocument = {createElement: () => new Element()};
  replaceChildren(...children) {
    this.children = children;
  }
}
test('缩略图均匀采样当前窗口，断流留空，跨段转换到各自局部时间', () => {
  const samples = thumbnailSamples(record, streams, {start: 0, end: 60});
  assert.deepEqual(
    samples.map(s => s.time),
    [5, 15, 25, 35, 45, 55],
  );
  assert.deepEqual(
    samples.map(s => s.local),
    [5, 15, null, null, 5, 15],
  );
  assert.deepEqual(
    samples.map(s => s.stream?.stream),
    ['first', 'first', undefined, undefined, 'second', 'second'],
  );
  assert.deepEqual(
    thumbnailSamples(record, streams, {start: 40, end: 46}).map(s => s.local),
    [0.5, 1.5, 2.5, 3.5, 4.5, 5.5],
  );
});
test('缩放取消旧取帧且旧结果不回填，未变视野不重取，离开清空', async () => {
  const container = new Element(),
    reads = [];
  const strip = createThumbnails({
    container,
    readFrame: (_, sample, signal) =>
      sample.time === 1 || sample.time === 40.5
        ? new Promise(resolve => reads.push({sample, signal, resolve}))
        : Promise.resolve('frame'),
  });
  strip.load(record, streams);
  strip.update({start: 0, end: 12});
  await wait();
  const oldCells = container.children;
  assert.equal(reads.length, 1);
  strip.update({start: 0, end: 12});
  await wait();
  assert.equal(reads.length, 1);
  strip.update({start: 40, end: 46});
  assert.equal(reads[0].signal.aborted, true);
  reads[0].resolve('old');
  await wait();
  assert.equal(oldCells[0].children.length, 0);
  assert.equal(reads.length, 2);
  reads[1].resolve('new');
  await wait();
  assert.deepEqual(container.children[0].children, ['new']);
  strip.clear();
  assert.equal(reads.at(-1).signal.aborted, true);
  assert.deepEqual(container.children, []);
  reads.at(-1).resolve('late');
  await Promise.resolve();
  assert.deepEqual(container.children, []);
});
test('无录像和加载失败有占位，其余帧继续显示，换场次重新加载', async () => {
  const container = new Element();
  let calls = 0;
  const strip = createThumbnails({
    container,
    readFrame: async () => {
      if (++calls === 1) throw new Error('network');
      return 'frame';
    },
  });
  strip.load(record, streams);
  strip.update({start: 0, end: 60});
  await wait();
  assert.equal(calls, 4);
  assert.equal(container.children[0].textContent, '暂无预览');
  assert.equal(container.children[2].textContent, '无录像');
  assert.deepEqual(container.children[5].children, ['frame']);
  strip.load(record, streams);
  strip.update({start: 0, end: 60});
  await wait();
  assert.equal(calls, 8);
  strip.clear();
});

test('缩略图最多并发两路，动画期间只投影旧图', async () => {
  const container = new Element(),
    reads = [],
    flush = () => new Promise(resolve => setImmediate(resolve));
  const strip = createThumbnails({
    container,
    readFrame: (_, sample, signal) => new Promise(resolve => reads.push({sample, signal, resolve})),
  });
  strip.load(record, streams);
  for (const target of [
    {start: 0, end: 12},
    {start: 40, end: 46},
  ]) {
    const offset = reads.length,
      view = {start: 0, end: 60};
    strip.update(view, {animating: true, target});
    assert.equal(reads.length, offset);
    await wait();
    assert.equal(reads.length, offset + 2);
    const old = container.children;
    strip.update({start: 2, end: 58}, {animating: true, target});
    assert.equal(reads.length, offset + 2);
    for (let i = 0; i < 6; i += 2) {
      assert.equal(reads.length, offset + i + 2);
      reads.slice(offset + i, offset + i + 2).forEach((r, j) => r.resolve(`frame-${offset + i + j}`));
      await flush();
    }
    const batch = reads.slice(offset);
    assert.deepEqual(
      batch.map(r => r.sample.time),
      thumbnailSamples(record, streams, target).map(s => s.time),
    );
    assert.equal(container.children, old);
    strip.update(target);
    assert.notEqual(container.children, old);
    assert.equal(reads.length, offset + 6);
    assert.deepEqual(
      container.children.map(c => c.children[0]),
      batch.map((_, i) => `frame-${offset + i}`),
    );
  }
  strip.clear();
});

test('换视野取消旧请求与未启动任务，慢帧不阻止快帧先显示', async () => {
  const container = new Element(),
    reads = [],
    flush = () => new Promise(resolve => setImmediate(resolve));
  const strip = createThumbnails({
    container,
    readFrame: (_, sample, signal) => new Promise(resolve => reads.push({signal, resolve})),
  });
  strip.load(record, streams);
  strip.update({start: 0, end: 12});
  await wait();
  assert.equal(reads.length, 2);
  strip.update({start: 40, end: 46});
  await wait();
  assert.equal(reads.length, 4);
  assert.ok(reads.slice(0, 2).every(r => r.signal.aborted));
  for (let i = 3; i < 8; i++) {
    reads[i].resolve('new');
    await flush();
  }
  assert.equal(container.children[1].children[0], 'new');
  assert.equal(container.children[0].children.length, 0);
  reads[2].resolve('new');
  await flush();
  const cells = container.children;
  assert.ok(cells.every(c => c.children[0] === 'new'));
  reads.slice(0, 2).forEach(r => r.resolve('old'));
  await flush();
  assert.equal(reads.length, 8);
  assert.equal(container.children, cells);
  strip.clear();
});

test('首帧前不启动缩略图，恢复后只生成最新视野，返回旧视野复用缓存', async () => {
  const container = new Element();
  let calls = 0;
  const strip = createThumbnails({
    container,
    readFrame: async () => {
      calls++;
      return 'frame';
    },
  });
  strip.load(record, streams, {defer: true});
  strip.update({start: 0, end: 12});
  await wait();
  assert.equal(calls, 0);
  strip.update({start: 40, end: 46});
  strip.resume();
  await wait();
  assert.equal(calls, 6);
  strip.update({start: 0, end: 12});
  await wait();
  assert.equal(calls, 12);
  strip.update({start: 40, end: 46});
  await wait();
  assert.equal(calls, 12);
  strip.clear();
});

test('延迟期间连续换选区只生成最终目标的六张图', async () => {
  const container = new Element(),
    reads = [];
  const strip = createThumbnails({
    container,
    readFrame: async (_, sample) => {
      reads.push(sample.time);
      return 'frame';
    },
  });
  strip.load(record, streams);
  strip.update({start: 0, end: 60}, {animating: true, target: {start: 0, end: 12}});
  strip.update({start: 0, end: 60}, {animating: true, target: {start: 40, end: 46}});
  assert.equal(reads.length, 0);
  await wait();
  assert.deepEqual(reads, [40.5, 41.5, 42.5, 43.5, 44.5, 45.5]);
  strip.clear();
});

test('fragment stills do not wait for the first video frame; starting a player does', async () => {
  const container = new Element(),
    stills = [];
  let frames = 0;
  const strip = createThumbnails({
    container,
    locate: async time => ({segment: {url: String(time)}, usable: time < 300}),
    readStill: async (_, place) => {
      if (!place.usable) throw new Error('mid-GOP');
      stills.push(place.segment.url);
      return 'still';
    },
    readFrame: async () => {
      frames++;
      return 'frame';
    },
  });
  strip.load({start: 1000}, [{start_time: 1000, end_time: 1600, stream: 'a'}], {defer: true});
  strip.update({start: 0, end: 600});
  await wait();
  assert.equal(stills.length, 3);
  assert.equal(frames, 0);
  strip.resume();
  await wait();
  assert.equal(frames, 3);
  strip.clear();
});

test('live growth retains cached frames across signed URL changes and fills newly recorded positions', async () => {
  const container = new Element(),
    reads = [];
  const strip = createThumbnails({
    container,
    readFrame: async (_, sample) => {
      reads.push(sample.time);
      return `frame-${sample.time}`;
    },
  });
  strip.load(record, [{start_time: 1000, end_time: 1010, stream: 'old-signed-url'}]);
  strip.update({start: 0, end: 12});
  await wait();
  assert.deepEqual(reads, [1, 3, 5, 7, 9]);
  assert.equal(container.children.at(-1).textContent, '无录像');
  strip.setStreams([{start_time: 1000, end_time: 1020, stream: 'new-signed-url'}]);
  await wait();
  assert.deepEqual(reads, [1, 3, 5, 7, 9, 11]);
  assert.equal(container.children.at(-1).children[0], 'frame-11');
  strip.clear();
});

test('wide views land on shared times, so zooming and growth reuse pictures', async () => {
  const read = [];
  const strip = createThumbnails({
    container: new Element(),
    locate: async time => ({segment: {url: String(time)}}),
    readStill: async (_, place) => {
      read.push(Number(place.segment.url));
      return 'still';
    },
  });
  strip.load({start: 1000}, [{start_time: 1000, end_time: 10000, stream: 'a'}]);
  strip.update({start: 0, end: 7200});
  await wait();
  assert.ok(read.length === 6 && read.every(time => time % 300 === 0), String(read));
  const known = read.length;
  strip.update({start: 0, end: 7300});
  await wait();
  assert.ok(read.length <= known + 2, 'most cells are already known');
  strip.clear();
});

test('close up every cell gets its exact position', async () => {
  const read = [];
  const strip = createThumbnails({
    container: new Element(),
    locate: async time => ({segment: {url: String(time)}}),
    readStill: async (_, place) => {
      read.push(Number(place.segment.url));
      return 'still';
    },
  });
  strip.load({start: 1000}, [{start_time: 1000, end_time: 10000, stream: 'a'}]);
  strip.update({start: 100, end: 160});
  await wait();
  assert.deepEqual(
    read.sort((a, b) => a - b),
    [105, 115, 125, 135, 145, 155],
  );
  strip.clear();
});

test('fragments that keep failing stop being tried, and a player takes over', async () => {
  let attempts = 0,
    frames = 0;
  const strip = createThumbnails({
    container: new Element(),
    locate: async () => ({segment: {url: 'a'}}),
    readStill: async () => {
      attempts++;
      throw new Error('mid-GOP');
    },
    readFrame: async () => {
      frames++;
      return 'frame';
    },
  });
  strip.load({start: 1000}, [{start_time: 1000, end_time: 1060, stream: 'a'}]);
  strip.update({start: 0, end: 60});
  await wait();
  assert.equal(frames, 6);
  assert.ok(attempts <= 6);
  const before = attempts;
  strip.update({start: 10, end: 20});
  await wait();
  assert.equal(attempts, before);
  strip.clear();
});

test('a background sweep covers the recording from the current position, one read at a time', async () => {
  const read = [];
  let active = 0,
    peak = 0;
  const strip = createThumbnails({
    container: new Element(),
    locate: async time => ({segment: {url: String(time)}}),
    readStill: async (_, place) => {
      peak = Math.max(peak, ++active);
      read.push(Number(place.segment.url));
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return 'still';
    },
  });
  strip.load({start: 1000}, [{start_time: 1000, end_time: 4000, stream: 'a'}]);
  strip.sweep(1800);
  await wait();
  assert.deepEqual(read.slice(0, 3), [1800, 1200, 2400]);
  assert.equal(read.length, 5);
  assert.equal(peak, 1);
  strip.clear();
});
test('a drag decodes only the newest position, three at a time, and never repeats one', async () => {
  const reads = [],
    flush = async () => {
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    };
  const strip = createThumbnails({
    container: new Element(),
    locate: async time => ({segment: {url: String(time)}}),
    readStill: (_, place) => new Promise(resolve => reads.push({time: Number(place.segment.url), resolve})),
  });
  strip.load({start: 1000}, [{start_time: 1000, end_time: 9000, stream: 'a'}]);
  for (const time of [60, 120, 180, 240, 300, 360]) strip.frameUrl(time);
  await flush();
  assert.deepEqual(
    reads.map(read => read.time),
    [60, 120, 180],
    'the path in between is skipped',
  );
  reads[0].resolve('frame');
  await flush();
  assert.deepEqual(
    reads.map(read => read.time),
    [60, 120, 180, 360],
    'the free slot takes the newest position',
  );
  strip.frameUrl(60);
  strip.frameUrl(360);
  await flush();
  assert.equal(reads.length, 4);
  strip.clear();
});

test('a position whose grid point falls outside the recording still gets a picture', async () => {
  const read = [];
  const strip = createThumbnails({
    container: new Element(),
    locate: async time => ({segment: {url: String(time)}}),
    readStill: async (_, place) => {
      read.push(Number(place.segment.url));
      return 'still';
    },
  });
  strip.load({start: 1000}, [{start_time: 1038, end_time: 17000, stream: 'a'}]);
  strip.update({start: 38, end: 16000});
  strip.frameUrl(38);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(read.includes(38), String(read));
  strip.clear();
});
