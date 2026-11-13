import {createDanmakuPainter} from '../../../src/danmaku/compositor.js';
import {createStreamingCompositor} from '../../../src/danmaku/streaming-compositor.js';
import {createAvatarCache} from '../../../src/danmaku/avatars.js';
import {createExportMetrics} from '../../../src/media/export-metrics.js';
import {commentPreroll} from '../../../src/danmaku/super-chat.js';
import {VideoSample} from 'mediabunny';

const make = (extra = {}) => ({
  time: 0,
  order: 0,
  kind: 'sc',
  mode: 1,
  color: 0xffffff,
  price: 30,
  bg_color: '#EDF5FF',
  header_color: '#2A60B2',
  text: '今天也要加油哦！',
  ...extra,
});
const resources = () => ({assets: new Map(), close() {}});
const options = (width = 1920, height = 1080) => ({width, height, start: 0, sourceTime: t => t});

function paintOverlay(painter, time, target) {
  const overlay = painter.renderOverlay(time);
  target.clearRect(0, 0, target.canvas.width, target.canvas.height);
  target.globalAlpha = painter.overlayOpacity;
  target.drawImage(overlay, 0, 0);
  if (painter.superChatOverlay) {
    target.globalAlpha = painter.superChatOpacity;
    target.drawImage(painter.superChatOverlay, 0, 0);
  }
}

window.checkSuperChat = async () => {
  const face = new OffscreenCanvas(96, 96),
    faceInk = face.getContext('2d');
  faceInk.fillStyle = '#ff00ff';
  faceInk.fillRect(0, 0, 96, 96);
  const blob = await face.convertToBlob({type: 'image/webp'});
  let fetches = 0;
  const avatars = createAvatarCache({
    fetcher: async () => {
      fetches++;
      return new Response(blob, {headers: {'Content-Type': 'image/webp'}});
    },
  });
  const event = make({face: 'https://i0.hdslb.com/bfs/face/test.jpg'});
  avatars.prefetch([event]);
  await avatars.settled();
  const metrics = createExportMetrics();
  const painter = createDanmakuPainter(
    [event, make({kind: undefined, order: 1, text: '普通弹幕'})],
    {...resources(), avatars},
    {...options(), metrics},
  );
  painter.layout.advance(0);
  painter.layout.x = () => 40;
  const ink = new OffscreenCanvas(1920, 1080).getContext('2d');
  paintOverlay(painter, 0, ink);
  const item = painter.layout.active[0];
  const alpha = ink.getImageData(40 + item.width - 10, item.top + item.height / 2, 1, 1).data[3];
  const avatarPixel = [...ink.getImageData(40 + 27, item.top + item.height / 2, 1, 1).data];
  for (let i = 1; i < 60; i++) painter.renderOverlay(i / 60);
  const counters = metrics.snapshot().counters;
  const normal = painter.layout.active[1];
  let normalAlpha = 0;
  const pixels = ink.getImageData(40, normal.top, normal.width, normal.height).data;
  for (let i = 3; i < pixels.length; i += 4) normalAlpha = Math.max(normalAlpha, pixels[i]);
  // Export uses exactly the same premultiplied ink and opacity as preview.
  const background = new OffscreenCanvas(1920, 1080),
    base = background.getContext('2d');
  base.fillStyle = '#506070';
  base.fillRect(0, 0, 1920, 1080);
  const sample = new VideoSample(background, {timestamp: 1, duration: 1 / 60});
  const exported = painter.render(sample, 1);
  const expected = new OffscreenCanvas(1920, 1080).getContext('2d');
  expected.drawImage(background, 0, 0);
  expected.globalAlpha = painter.overlayOpacity;
  expected.drawImage(painter.renderOverlay(1), 0, 0);
  if (painter.superChatOverlay) {
    expected.globalAlpha = painter.superChatOpacity;
    expected.drawImage(painter.superChatOverlay, 0, 0);
  }
  const actual = new OffscreenCanvas(1920, 1080).getContext('2d');
  exported.draw(actual, 0, 0);
  const a = expected.getImageData(0, 0, 1920, 300).data,
    b = actual.getImageData(0, 0, 1920, 300).data;
  let maxDifference = 0;
  for (let i = 0; i < a.length; i++) maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]));
  const result = {
    alpha,
    normalAlpha,
    avatarPixel,
    counters,
    fetches,
    maxDifference,
    height: item.height,
    normalHeight: normal.height,
  };
  exported.close();
  sample.close();
  painter.close();
  avatars.close();
  metrics.close();
  return result;
};

// A placed SC keeps its width; an avatar that arrives later fills its slot.
window.checkLateAvatar = () => {
  const face = new OffscreenCanvas(48, 48),
    faceInk = face.getContext('2d');
  faceInk.fillStyle = '#ff00ff';
  faceInk.fillRect(0, 0, 48, 48);
  let ready = false;
  const avatars = {get: url => (ready && url ? face : null)};
  const painter = createDanmakuPainter([make({face: 'late'})], {...resources(), avatars}, options());
  painter.layout.advance(0);
  painter.layout.x = () => 40;
  const ink = new OffscreenCanvas(1920, 1080).getContext('2d');
  const item = painter.layout.active[0],
    width = item.width;
  const sample = () => [...ink.getImageData(40 + 24, item.top + item.height / 2, 1, 1).data];
  paintOverlay(painter, 0, ink);
  const before = sample();
  ready = true;
  paintOverlay(painter, 1 / 60, ink);
  const after = sample();
  painter.close();
  return {before, after, widthBefore: width, widthAfter: item.width};
};

window.checkSuperChatWindows = async () => {
  const events = [make({time: 0, text: '长'.repeat(40)}), make({time: 10, order: 1, text: '第二条'})];
  const windows = [];
  const reader = {
    async read({start, end}) {
      windows.push({start, end});
      return events.filter(e => e.time >= start && e.time < end).map(e => ({...e}));
    },
    async close() {},
  };
  const compositor = await createStreamingCompositor(
    {room: 1},
    {...options(), reader, fetcher: async () => new Response('{}')},
  );
  const direct = createDanmakuPainter(events, resources(), options());
  let maxDifference = 0;
  for (const time of [0, 9.99, 10, 10.5, 15, 18, 24]) {
    await compositor.prepare(time);
    const left = new OffscreenCanvas(1920, 1080).getContext('2d'),
      right = new OffscreenCanvas(1920, 1080).getContext('2d');
    paintOverlay(compositor, time, left);
    paintOverlay(direct, time, right);
    const a = left.getImageData(0, 0, 1920, 260).data,
      b = right.getImageData(0, 0, 1920, 260).data;
    for (let i = 0; i < a.length; i++) maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]));
  }
  await compositor.close();
  direct.close();
  return {maxDifference, firstWindow: windows[0], preroll: commentPreroll(1920, 1080)};
};

window.superChatBenchmark = () => {
  const results = [];
  for (const width of [1920, 3840])
    for (const sc of [false, true]) {
      const height = (width * 9) / 16,
        metrics = createExportMetrics();
      const events = Array.from({length: 120}, (_, i) =>
        make({time: i / 10, order: i, kind: sc && i % 20 === 0 ? 'sc' : undefined, text: '这是一条测试弹幕 ' + i}),
      );
      const painter = createDanmakuPainter(events, resources(), {...options(width, height), metrics});
      const times = [];
      for (let i = 0; i < 600; i++) {
        const start = performance.now();
        painter.renderOverlay(i / 60);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      results.push({
        width,
        sc,
        frames: times.length,
        meanMs: times.reduce((a, b) => a + b, 0) / times.length,
        p95Ms: times[Math.floor(times.length * 0.95)],
        metrics: metrics.snapshot(),
      });
      painter.close();
      metrics.close();
    }
  return results;
};

// A local, interactive visual review uses the real painter, not a separate mock.
window.startSuperChatDemo = () => {
  document.body.innerHTML = `<style>body{margin:0;padding:24px;background:#101820;color:#edf5ff;font:16px system-ui}h1{font-size:22px}p{color:#abb9c8}canvas{width:100%;aspect-ratio:16/9;background:linear-gradient(135deg,#17495b,#28353e 55%,#69786f)}button,input{margin:8px;padding:8px}label{margin-right:20px}</style><h1>SC 滚动效果预览</h1><p>样例留言 · 方案 B · 固定速度 · 40 字截断 · 单行高度。使用切片助手的实际渲染器。</p><button id="restart">重新播放</button><label><input id="light" type="checkbox">浅色背景</label><label><input id="pause" type="checkbox">暂停</label><canvas id="scDemo" width="1920" height="1080"></canvas>`;
  const canvas = document.getElementById('scDemo'),
    ink = canvas.getContext('2d');
  const face = new OffscreenCanvas(64, 64),
    f = face.getContext('2d');
  f.fillStyle = '#f3ca8b';
  f.fillRect(0, 0, 64, 64);
  f.fillStyle = '#354c58';
  f.font = 'bold 38px sans-serif';
  f.fillText('B', 18, 47);
  const events = [
    make({time: 0, order: 0, face: 'demo', text: '今天也要加油哦！'}),
    make({
      time: 1,
      order: 1,
      price: 100,
      bg_color: '#DBFFFD',
      header_color: '#427D9E',
      text: '这是一条长一点的醒目留言，长度不会改变滚动速度',
    }),
    make({
      time: 2,
      order: 2,
      price: 1000,
      bg_color: '#FFE7E4',
      header_color: '#A92258',
      face: 'demo',
      text: '感谢今天的直播，祝大家每天开心！'.repeat(4),
    }),
    ...Array.from({length: 30}, (_, i) =>
      make({
        kind: undefined,
        time: i * 0.35,
        order: 3 + i,
        text: ['晚上好！', '今天也辛苦啦', '普通弹幕和 SC 混排测试'][i % 3],
      }),
    ),
  ];
  let painter,
    elapsed = 0,
    last = performance.now();
  const restart = () => {
    painter?.close();
    painter = createDanmakuPainter(
      events,
      {...resources(), avatars: {get: faceUrl => (faceUrl ? face : null)}},
      options(),
    );
    elapsed = 0;
  };
  document.getElementById('restart').onclick = restart;
  restart();
  const tick = now => {
    if (!document.getElementById('pause').checked) elapsed += (now - last) / 1000;
    last = now;
    if (elapsed > 28) restart();
    canvas.style.background = document.getElementById('light').checked ? 'linear-gradient(135deg,#f6ead3,#bacbd0)' : '';
    ink.clearRect(0, 0, 1920, 1080);
    paintOverlay(painter, elapsed, ink);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
