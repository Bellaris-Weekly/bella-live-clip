import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeHlsLoader, createPlayer, previewError} from '../../../src/media/preview-player.js';
test('整场播放器加载分片字节区间并返回计量', async () => {
  let options;
  const Loader = makeHlsLoader(async (url, o) => {
    options = o;
    return {url, data: new ArrayBuffer(8)};
  });
  const loader = new Loader();
  await new Promise((resolve, reject) =>
    loader.load(
      {url: 'https://media.example/part', responseType: 'arraybuffer', rangeStart: 4, rangeEnd: 12},
      {},
      {
        onSuccess(response, stats) {
          assert.equal(response.data.byteLength, 8);
          assert.equal(stats.loaded, 8);
          assert.deepEqual(options.range, {offset: 4, length: 8});
          assert.equal(options.auth, undefined);
          resolve();
        },
        onError: reject,
      },
    ),
  );
  loader.destroy();
  assert.equal(loader.stats.aborted, true);
});

function playerFixture(clips, options = {}) {
  const instances = [],
    shown = [];
  class FakeHls {
    constructor(config) {
      this.config = config;
      this.events = new Map();
      instances.push(this);
    }
    on(event, handler) {
      this.events.set(event, handler);
    }
    loadSource(url) {
      this.url = url;
    }
    attachMedia(video) {
      this.video = video;
    }
    destroy() {
      this.destroyed = true;
    }
    startLoad(position) {
      (this.starts ??= []).push(position);
    }
    stopLoad() {
      this.stopped = true;
    }
  }
  const video = new EventTarget();
  Object.assign(video, {
    currentTime: 0,
    readyState: 0,
    seeking: false,
    pause() {},
    removeAttribute() {},
    load() {
      this.currentTime = 0;
    },
  });
  const loading = {hidden: true};
  const player = createPlayer({
    video,
    loading,
    api: {clips, request() {}},
    status() {},
    onTime() {},
    onReady: owner => shown.push(owner),
    HlsClass: FakeHls,
    ...options,
  });
  return {player, video, loading, instances, shown};
}

test('danmaku maps the presented HLS clock to native media time and hides unsettled frames', async () => {
  const part = {start_time: 1000, end_time: 1100, stream: 'first'};
  const f = playerFixture(async () => [part]);
  await f.player.load({start: 1000, end: 1100}, new AbortController().signal);
  f.player.seek(21);
  assert.equal(f.player.danmakuFrame(), null);
  const events = f.instances[0].events;
  events.get('hlsManifestParsed')();
  events.get('hlsLevelLoaded')(null, {
    details: {
      fragments: [
        {cc: 0, start: 0, duration: 50},
        {cc: 1, start: 50, duration: 50},
      ],
    },
  });
  events.get('hlsInitPtsFound')(null, {frag: {cc: 0}, initPTS: 900000, timescale: 1000});
  f.video.readyState = 2;
  f.video.dispatchEvent(new Event('loadeddata'));
  const frame = f.player.danmakuFrame();
  assert.equal(frame.part, part);
  assert.equal(frame.time, 921);
  f.player.beginScrub();
  assert.equal(f.player.danmakuFrame(), null);
  f.player.endScrub();
  assert.equal(f.player.danmakuFrame().time, 921);
  f.video.currentTime = 55;
  assert.equal(f.player.danmakuFrame(), null, 'each discontinuity needs its own native offset');
  events.get('hlsInitPtsFound')(null, {frag: {cc: 1}, initPTS: 1200000, timescale: 1000});
  assert.equal(f.player.danmakuFrame().time, 1255);
  f.player.clear();
  assert.equal(f.player.danmakuFrame(), null);
  f.player.destroy();
});

test('initial preview starts only the selected segment at its requested position', async () => {
  const record = {start: 1000, end: 1300, live: false},
    parts = [
      {start_time: 1000, end_time: 1100, stream: 'first'},
      {start_time: 1200, end_time: 1300, stream: 'latest'},
    ];
  const f = playerFixture(async () => parts),
    signal = new AbortController().signal;
  assert.deepEqual(await f.player.load(record, signal), {streams: parts, total: 300});
  assert.equal(f.instances.length, 0, 'do not load the first segment before the initial selection');
  f.player.seek(285);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].url, 'latest');
  assert.equal(f.instances[0].config.startPosition, 85);
  f.instances[0].events.get('hlsManifestParsed')();
  assert.equal(f.video.currentTime, 85);
  f.video.dispatchEvent(new Event('canplay'));
  assert.equal(f.shown.length, 0);
  f.video.readyState = 2;
  f.video.dispatchEvent(new Event('loadeddata'));
  assert.deepEqual(f.shown, [record]);
  assert.equal(f.loading.hidden, true);
  f.video.dispatchEvent(new Event('canplay'));
  assert.equal(f.shown.length, 1);
  f.player.seek(250);
  assert.equal(f.instances.length, 1);
  assert.equal(f.video.currentTime, 50);
  f.player.seek(10);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[0].destroyed, true);
  assert.equal(f.instances[1].url, 'first');
  f.player.destroy();
});

test('late clip lists cannot replace the newly loaded record', async () => {
  let finish,
    calls = 0;
  const parts = [{start_time: 2000, end_time: 2100, stream: 'new'}];
  const f = playerFixture(() =>
    ++calls === 1
      ? new Promise(resolve => {
          finish = resolve;
        })
      : Promise.resolve(parts),
  );
  const signal = new AbortController().signal,
    old = f.player.load({start: 1000, end: 1100}, signal);
  const rejected = assert.rejects(old, {name: 'AbortError'});
  await f.player.load({start: 2000, end: 2100}, signal);
  finish([{start_time: 1000, end_time: 1100, stream: 'old'}]);
  await rejected;
  f.player.seek(10);
  assert.equal(f.instances[0].url, 'new');
  f.player.destroy();
});
test('切换场次取消整场播放器旧请求，不写入旧数据', async () => {
  let finish,
    aborted = false,
    delivered = false;
  const Loader = makeHlsLoader(
    (_, {signal}) =>
      new Promise(resolve => {
        finish = resolve;
        signal.addEventListener('abort', () => (aborted = true));
      }),
  );
  const loader = new Loader();
  loader.load(
    {url: 'https://media.example/list', responseType: 'text'},
    {},
    {
      onSuccess() {
        delivered = true;
      },
      onError() {
        delivered = true;
      },
    },
  );
  loader.abort();
  finish({url: 'https://media.example/list', data: 'old'});
  await new Promise(r => setImmediate(r));
  assert.equal(aborted, true);
  assert.equal(delivered, false);
});

test('refreshing a live record fetches its growing range again and replaces the old stream', async t => {
  let now = 1100;
  t.mock.method(Date, 'now', () => now * 1000);
  const record = {key: 'same-live', start: 1000, end: 1100, live: true},
    calls = [];
  const f = playerFixture(async (owner, start, end) => {
    calls.push({key: owner.key, start, end});
    return [{start_time: 1000, end_time: now, stream: `stream-${now}`}];
  });
  const signal = new AbortController().signal;
  assert.equal((await f.player.load(record, signal)).total, 100);
  f.player.seek(85);
  now = 1200;
  assert.equal((await f.player.load(record, signal)).total, 200);
  f.player.seek(185);
  assert.deepEqual(calls, [
    {key: 'same-live', start: 0, end: 100},
    {key: 'same-live', start: 0, end: 200},
  ]);
  assert.equal(f.instances[0].destroyed, true);
  assert.equal(f.instances[1].url, 'stream-1200');
  assert.equal(f.instances[1].config.startPosition, 185);
  f.player.destroy();
});

test('live growth keeps the active decoder and playhead, but newly recorded positions use a fresh stream snapshot', async () => {
  const record = {key: 'live', start: 1000, end: 1100, live: true};
  const f = playerFixture(async () => [{start_time: 1000, end_time: 1100, stream: 'old'}]);
  await f.player.load(record, new AbortController().signal);
  f.player.seek(85);
  f.video.currentTime = 85;
  const update = f.player.extend([{start_time: 1000, end_time: 1200, stream: 'fresh'}]);
  assert.equal(update.total, 200);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].destroyed, undefined);
  assert.equal(f.player.position(), 85);
  f.player.seek(90);
  assert.equal(f.instances.length, 1);
  f.player.seek(150);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[0].destroyed, true);
  assert.equal(f.instances[1].url, 'fresh');
  assert.equal(f.instances[1].config.startPosition, 150);
  const reconnect = f.player.extend([
    {start_time: 1000, end_time: 1200, stream: 'fresh-2'},
    {start_time: 1250, end_time: 1300, stream: 'reconnected'},
  ]);
  assert.equal(reconnect.total, 300);
  assert.equal(f.instances.length, 2);
  f.player.seek(220);
  assert.equal(f.loading.textContent, '该位置没有录像');
  assert.equal(f.instances.length, 2);
  f.player.seek(260);
  assert.equal(f.instances.at(-1).url, 'reconnected');
  assert.equal(f.instances.at(-1).config.startPosition, 10);
  f.player.destroy();
});

test('partial, reordered, overlapping or regressing live responses never shrink or relabel loaded segments', async () => {
  const parts = [
    {start_time: 1000, end_time: 1100, stream: 'first'},
    {start_time: 1200, end_time: 1250, stream: 'last'},
  ];
  const f = playerFixture(async () => parts);
  await f.player.load({start: 1000, live: true}, new AbortController().signal);
  for (const next of [
    [],
    [parts[1]],
    [parts[1], parts[0]],
    [parts[0], {...parts[1], end_time: 1240}],
    [{...parts[0], end_time: 1210}, parts[1]],
    [parts[0], {...parts[1], stream: ''}],
  ])
    assert.equal(f.player.extend(next), null);
  f.player.seek(220);
  assert.equal(f.instances.at(-1).url, 'last');
  assert.equal(f.instances.at(-1).config.startPosition, 20);
  f.player.destroy();
});

function still() {
  const attributes = new Map();
  return {
    hidden: true,
    attributes,
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
}
function playing(f) {
  const hls = f.instances.at(-1);
  hls.events.get('hlsManifestParsed')();
  f.video.readyState = 2;
  f.video.dispatchEvent(new Event('loadeddata'));
}
async function scrubFixture(t, options = {}) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const parts = [{start_time: 1000, end_time: 2000, stream: 'first'}],
    image = still();
  const f = playerFixture(async () => parts, {still: image, frameUrl: time => `still-${Math.round(time)}`, ...options});
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(0);
  playing(f);
  return {...f, image};
}
test('a drag paints stills and seeks the video only where the pointer rests', async t => {
  const f = await scrubFixture(t);
  const seeks = [];
  Object.defineProperty(f.video, 'currentTime', {
    get: () => seeks.at(-1) ?? 0,
    set: value => {
      seeks.push(value);
    },
  });
  f.player.beginScrub();
  for (let time = 100; time < 700; time += 7) {
    f.player.scrub(time);
    t.mock.timers.tick(16);
  }
  assert.equal(seeks.length, 0, 'fragment loading must not restart on every pointer move');
  assert.equal(f.image.getAttribute('src'), 'still-695');
  assert.equal(f.image.hidden, false);
  assert.equal(f.loading.hidden, true);
  assert.equal(f.player.position(), 695, 'the time follows the pointer without the video');
  t.mock.timers.tick(160);
  assert.deepEqual(seeks, [695]);
  assert.equal(f.image.hidden, false, 'stays until the frame is decoded');
  f.video.dispatchEvent(new Event('seeked'));
  assert.equal(f.image.hidden, true);
  f.player.scrub(800);
  f.player.endScrub();
  assert.deepEqual(seeks, [695, 800], 'release seeks at once');
  t.mock.timers.tick(1000);
  assert.equal(seeks.length, 2);
  f.player.destroy();
});
test('a release after the rest seek does not seek again and clears the still', async t => {
  const f = await scrubFixture(t);
  const seeks = [];
  Object.defineProperty(f.video, 'currentTime', {
    get: () => seeks.at(-1) ?? 0,
    set: value => {
      seeks.push(value);
    },
  });
  f.player.beginScrub();
  f.player.scrub(300);
  t.mock.timers.tick(160);
  f.video.dispatchEvent(new Event('seeked'));
  f.player.endScrub();
  assert.deepEqual(seeks, [300]);
  assert.equal(f.image.hidden, true);
  f.player.destroy();
});
test('restoring a trim preview cancels its pending seek and returns to the saved position', async t => {
  const f = await scrubFixture(t);
  f.video.currentTime = 420;
  const restoreTime = f.player.position(),
    seeks = [];
  Object.defineProperty(f.video, 'currentTime', {
    get: () => seeks.at(-1) ?? restoreTime,
    set: value => {
      seeks.push(value);
    },
  });
  f.player.beginScrub();
  f.player.scrub(700);
  assert.equal(f.player.position(), 700);
  assert.equal(f.image.getAttribute('src'), 'still-700');
  f.player.endScrub(restoreTime);
  assert.deepEqual(seeks, [420], 'release restores playback without seeking to the pending trim point');
  assert.equal(f.player.position(), restoreTime);
  assert.equal(f.image.hidden, true);
  t.mock.timers.tick(1000);
  assert.deepEqual(seeks, [420], 'the delayed trim seek cannot move playback again');
  f.player.destroy();
});
test('restoring a settled trim preview seeks back even when there is no pending preview', async t => {
  const f = await scrubFixture(t),
    restoreTime = f.player.position(),
    seeks = [];
  Object.defineProperty(f.video, 'currentTime', {
    get: () => seeks.at(-1) ?? restoreTime,
    set: value => {
      seeks.push(value);
    },
  });
  f.player.beginScrub();
  f.player.scrub(700);
  t.mock.timers.tick(160);
  f.video.dispatchEvent(new Event('seeked'));
  assert.deepEqual(seeks, [700]);
  f.player.endScrub(restoreTime);
  assert.deepEqual(seeks, [700, 0], 'the saved recording start is a valid restoration target');
  assert.equal(f.player.position(), restoreTime);
  t.mock.timers.tick(1000);
  assert.deepEqual(seeks, [700, 0]);
  f.player.destroy();
});
test('without platform stills a drag still shows video, at a bounded seek rate', async t => {
  const f = await scrubFixture(t, {frameUrl: () => null});
  const seeks = [];
  Object.defineProperty(f.video, 'currentTime', {
    get: () => seeks.at(-1) ?? 0,
    set: value => {
      seeks.push(value);
    },
  });
  let clock = 10000;
  t.mock.method(performance, 'now', () => clock);
  f.player.beginScrub();
  for (let time = 0; time < 60; time++) {
    f.player.scrub(100 + time);
    clock += 16;
    t.mock.timers.tick(16);
  }
  assert.ok(seeks.length >= 3 && seeks.length <= 5, `${seeks.length} seeks in one second`);
  f.player.endScrub();
  f.player.destroy();
});
test('the poster covers the black screen and the first frame removes it', async () => {
  const image = still(),
    f = playerFixture(async () => [{start_time: 1000, end_time: 2000, stream: 'first'}], {
      still: image,
      frameUrl: () => 'grid-still',
    });
  const loading = f.player.load({start: 1000, end: 2000, live: true, poster: 'cover'}, new AbortController().signal);
  assert.equal(image.getAttribute('src'), 'cover');
  assert.equal(image.hidden, false);
  await loading;
  f.player.seek(500);
  f.player.refreshStill();
  assert.equal(image.getAttribute('src'), 'grid-still', 'a real frame replaces the room cover');
  playing(f);
  assert.equal(image.hidden, true);
  f.player.refreshStill();
  assert.equal(image.hidden, true, 'late index results do not cover decoded video');
  f.player.destroy();
});

const fragments = [
  {start: 0, duration: 1},
  {start: 1, duration: 1},
  {start: 2, duration: 0.17},
  {start: 2.17, duration: 1},
];
test('seeks stay off fragment boundaries, where hls.js would reload forever', async () => {
  const f = playerFixture(async () => [{start_time: 1000, end_time: 2000, stream: 'first'}]);
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(1);
  f.instances[0].events.get('hlsLevelLoaded')(null, {details: {fragments}});
  assert.equal(f.video.currentTime, 1.1, 'the opening position moves off the boundary');
  assert.deepEqual(f.instances[0].starts, [1.1]);
  f.player.seek(2);
  assert.equal(f.video.currentTime, 2.085, 'short fragments keep the position inside them');
  f.player.seek(2.5);
  assert.equal(f.video.currentTime, 2.5, 'other positions stay exact');
  f.player.seek(0);
  assert.equal(f.video.currentTime, 0, 'the recording start begins on a keyframe');
  f.player.destroy();
});
test('a fragment reload loop is rebuilt a bounded number of times, then stops downloading', async () => {
  const f = playerFixture(async () => [{start_time: 1000, end_time: 2000, stream: 'first'}]);
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(10);
  const load = sn => f.instances.at(-1).events.get('hlsFragLoaded')(null, {frag: {sn}});
  for (let i = 0; i < 9; i++) load('initSegment');
  assert.equal(f.instances.length, 1, 'init segments are not media reloads');
  load(5);
  load(6);
  load(5);
  load(6);
  load(5);
  assert.equal(f.instances.length, 1);
  load(5);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[0].destroyed, true);
  assert.equal(f.instances[1].config.startPosition, 10.1);
  for (let i = 0; i < 4; i++) load(5);
  assert.equal(f.instances.length, 3);
  for (let i = 0; i < 4; i++) load(5);
  assert.equal(f.instances.length, 3);
  assert.equal(f.instances[2].stopped, true);
  assert.match(f.loading.textContent, /暂时无法预览/);
  f.player.seek(20);
  assert.equal(f.video.currentTime, 20);
  for (let i = 0; i < 4; i++) load(5);
  assert.equal(f.instances.length, 4, 'a new position gets a fresh recovery budget');
  f.player.destroy();
});
test('normal playback across many fragments is not mistaken for a loop', async () => {
  const f = playerFixture(async () => [{start_time: 1000, end_time: 2000, stream: 'first'}]);
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(10);
  for (let sn = 0; sn < 100; sn++) f.instances[0].events.get('hlsFragLoaded')(null, {frag: {sn}});
  assert.equal(f.instances.length, 1);
  for (let i = 0; i < 3; i++) {
    f.instances[0].events.get('hlsFragLoaded')(null, {frag: {sn: 7}});
    f.player.seek(10 + i);
  }
  assert.equal(f.instances.length, 1, 'seeking back over old fragments is not a loop');
  f.player.destroy();
});

test('an expired address is renewed once and playback continues from the same position', async () => {
  let clips = 0;
  const applied = [],
    parts = () => [{start_time: 1000, end_time: 2000, stream: `signed-${++clips}`}];
  const f = playerFixture(async () => parts(), {
    onStreams: next => {
      applied.push(next);
      f.player.extend(next);
    },
  });
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(300);
  const network = {type: 'networkError', details: 'fragLoadError', fatal: true};
  f.instances[0].events.get('hlsError')(null, network);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(applied.length, 1);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[1].url, 'signed-2');
  assert.equal(f.instances[1].config.startPosition, 300);
  f.instances[1].events.get('hlsError')(null, network);
  assert.equal(f.instances.length, 2, 'the same position is not retried forever');
  f.player.reload();
  assert.equal(f.instances.length, 3, 'the refresh button retries a failed preview');
  f.player.seek(400);
  f.instances[2].events.get('hlsError')(null, network);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.instances.length, 4, 'a new position may renew again');
  f.player.destroy();
});
test('a failed renewal reports the original error; reload leaves working playback alone', async () => {
  let clips = 0;
  const errors = [];
  const f = playerFixture(
    async () => {
      if (++clips > 1) throw new Error('offline');
      return [{start_time: 1000, end_time: 2000, stream: 'first'}];
    },
    {onError: error => errors.push(error.message)},
  );
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(10);
  f.player.reload();
  assert.equal(f.instances.length, 1);
  f.instances[0].events.get('hlsError')(null, {type: 'networkError', details: 'fragLoadError', fatal: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errors[0], /fragLoadError/);
  f.player.destroy();
});
test('replay addresses may change but the recording itself cannot', async () => {
  const parts = [{start_time: 1000, end_time: 2000, stream: 'first'}];
  const f = playerFixture(async () => parts);
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  const next = f.player.extend([{...parts[0], stream: 'renewed'}]);
  assert.equal(next.changed, false);
  assert.equal(next.streams[0].stream, 'renewed');
  assert.equal(f.player.extend([parts[0], {start_time: 2100, end_time: 2200, stream: 'x'}]), null);
  f.player.destroy();
});

test('a paused preview buffers one fragment and playback buffers ahead', async () => {
  const f = playerFixture(async () => [{start_time: 1000, end_time: 2000, stream: 'first'}]);
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(10);
  const {config} = f.instances[0];
  assert.equal(config.maxBufferLength, 2);
  f.video.dispatchEvent(new Event('play'));
  assert.equal(config.maxBufferLength, 12);
  f.video.dispatchEvent(new Event('pause'));
  assert.equal(config.maxBufferLength, 2);
  f.player.destroy();
});
test('during a drag a decoded still appears as soon as it is ready', async () => {
  const image = still();
  let url = null;
  const f = playerFixture(async () => [{start_time: 1000, end_time: 2000, stream: 'first'}], {
    still: image,
    frameUrl: () => url,
  });
  await f.player.load({start: 1000, end: 2000, live: false}, new AbortController().signal);
  f.player.seek(0);
  f.player.beginScrub();
  f.player.scrub(500);
  assert.equal(image.hidden, true);
  url = 'decoded';
  f.player.refreshStill();
  assert.equal(image.getAttribute('src'), 'decoded');
  assert.equal(image.hidden, false);
  f.player.destroy();
});

test('预览失败携带编码、浏览器原因和是否支持该编码', () => {
  const cause = new DOMException("Failed to execute 'addSourceBuffer'", 'NotSupportedError');
  const checked = [];
  const error = previewError(
    {
      type: 'mediaError',
      details: 'bufferAddCodecError',
      fatal: true,
      sourceBufferName: 'video',
      mimeType: 'video/mp4;codecs=hvc1.1.6.L150.90',
      error: cause,
    },
    {
      isTypeSupported(type) {
        checked.push(type);
        return false;
      },
    },
  );
  assert.equal(error.message, '录像预览失败：mediaError / bufferAddCodecError');
  assert.deepEqual(error.diagnostic, {
    hlsType: 'mediaError',
    hlsDetails: 'bufferAddCodecError',
    sourceBuffer: 'video',
    mimeType: 'video/mp4;codecs=hvc1.1.6.L150.90',
    typeSupported: false,
  });
  assert.equal(error.cause, cause);
  assert.deepEqual(checked, ['video/mp4;codecs=hvc1.1.6.L150.90']);
  assert.deepEqual(previewError({type: 'networkError', details: 'fragLoadError'}).diagnostic, {
    hlsType: 'networkError',
    hlsDetails: 'fragLoadError',
  });
});

test('long recordings locate frames with a bounded search and reuse the current fragment', async () => {
  const count = 50000,
    part = {start_time: 1000, end_time: 1000 + count, stream: 'long'};
  const f = playerFixture(async () => [part]);
  let visited = 0;
  const fragments = Array.from({length: count}, (_, index) => ({
    get start() {
      visited++;
      return index;
    },
    duration: 1,
    cc: 0,
  }));
  try {
    await f.player.load({start: 1000, end: 1000 + count}, new AbortController().signal);
    f.player.seek(count - 0.5);
    const events = f.instances[0].events;
    events.get('hlsManifestParsed')();
    events.get('hlsLevelLoaded')(null, {details: {fragments}});
    events.get('hlsInitPtsFound')(null, {frag: {cc: 0}, initPTS: 0, timescale: 1});
    f.video.readyState = 2;
    f.video.dispatchEvent(new Event('loadeddata'));
    visited = 0;
    f.video.currentTime = 12345.5;
    assert.equal(f.player.danmakuFrame().time, 12345.5);
    assert.ok(visited < 80, `visited ${visited} starts for one seek`);
    visited = 0;
    for (let i = 0; i < 100; i++) assert.equal(f.player.danmakuFrame().time, 12345.5);
    assert.ok(visited < 600, `visited ${visited} starts while staying in one fragment`);
  } finally {
    f.player.destroy();
  }
});

test('fragment lookup preserves gaps, overlap boundaries, backward seeks and updated HLS times', async () => {
  const part = {start_time: 0, end_time: 10, stream: 'test'};
  const f = playerFixture(async () => [part]);
  try {
    await f.player.load({start: 0, end: 10}, new AbortController().signal);
    f.player.seek(0.5);
    const events = f.instances[0].events;
    events.get('hlsManifestParsed')();
    const fragments = [
      {start: 0, duration: 1, cc: 0},
      {start: 2, duration: 2.5, cc: 0},
      {start: 4, duration: 1, cc: 1},
    ];
    events.get('hlsLevelLoaded')(null, {details: {fragments}});
    for (const [cc, offset] of [
      [0, 10],
      [1, 100],
    ])
      events.get('hlsInitPtsFound')(null, {frag: {cc}, initPTS: offset, timescale: 1});
    f.video.readyState = 2;
    f.video.dispatchEvent(new Event('loadeddata'));
    for (const [time, expected] of [
      [4.75, 104.75],
      [4.25, 14.25],
      [1.5, null],
      [0.5, 10.5],
      [4.5, 104.5],
      [5, null],
    ]) {
      f.video.currentTime = time;
      assert.equal(f.player.danmakuFrame()?.time ?? null, expected);
    }
    fragments[1].duration = 2;
    f.video.currentTime = 4.25;
    assert.equal(
      f.player.danmakuFrame().time,
      104.25,
      'read hls.js timing refinements without rebuilding a stale index',
    );
    events.get('hlsLevelLoaded')(null, {details: {fragments: [{start: 0, duration: 10, cc: 1}]}});
    f.video.currentTime = 0.5;
    assert.equal(f.player.danmakuFrame().time, 100.5);
  } finally {
    f.player.destroy();
  }
});
