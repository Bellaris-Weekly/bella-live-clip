// Runs inside Chromium against the real player and hls.js.
import {createPlayer} from '../../../src/media/preview-player.js';
import {readFragmentStill} from '../../../src/media/fragment-still.js';
import {createPlayback, bindVideoControls} from '../../../src/media/playback.js';
import {createDanmakuPreview} from '../../../src/danmaku/preview.js';
import {RecordingPlan} from '../../../src/media/recording-plan.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rig({start = 1000} = {}) {
  const video = document.createElement('video');
  video.muted = true;
  const wrap = document.createElement('div'),
    exitButton = document.createElement('button');
  wrap.id = 'playerWrap';
  exitButton.id = 'exitVideoFullscreen';
  exitButton.textContent = '退出全屏';
  wrap.append(video, exitButton);
  document.body.append(wrap);
  const loading = document.createElement('div'),
    still = document.createElement('img');
  still.hidden = true;
  wrap.append(still);
  const counts = new Map();
  const request = async (url, {type, signal} = {}) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    const response = await fetch(url, {signal});
    return {data: type === 'arraybuffer' ? await response.arrayBuffer() : await response.text(), url: response.url};
  };
  const record = {key: 'k', room: 1, start, end: start + 34, live: false};
  const api = {
    request,
    clips: async () => [
      {start_time: start, end_time: start + 34, clockComplete: true, stream: `${location.origin}/v.m3u8`},
    ],
  };
  const player = createPlayer({
    video,
    loading,
    still,
    frameUrl: time => `/still.svg?t=${Math.round(time)}`,
    status() {},
    onTime() {},
    api,
  });
  return {video, loading, still, player, counts, api, record, wrap, exitButton};
}

async function settled({video, loading}, timeout) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (video.readyState >= 2 && !video.seeking && loading.hidden) return Math.round(performance.now() - started);
    await sleep(15);
  }
  return null;
}

const load = r => r.player.load(r.record, new AbortController().signal);

window.setupDanmakuPreview = async () => {
  const r = rig({start: 98});
  const {streams} = await load(r);
  const canvas = document.createElement('canvas');
  canvas.id = 'danmakuPreview';
  canvas.hidden = true;
  r.wrap.append(canvas);
  const playback = createPlayback(r.video, () => {}, {
    getRange: () => null,
    position: () => r.player.position(),
    seek: time => r.player.seek(time),
  });
  bindVideoControls(r.video, playback, () => {}, {fullscreenTarget: r.wrap, exitButton: r.exitButton});
  const errors = [],
    diagnostics = [];
  const preview = createDanmakuPreview({
    video: r.video,
    canvas,
    getFrame: () => (r.framesBlocked ? null : r.player.danmakuFrame()),
    onError: error => errors.push(error.message),
    onDiagnostic: (_, resumed) => {
      const entry = {resumed, status: 'loading'};
      diagnostics.push(entry);
      return {
        observe(provider) {
          entry.provider = provider;
        },
        stage(value) {
          entry.stage = value;
        },
        finish(result = {}) {
          entry.status = result.status ?? 'completed';
          entry.metrics = entry.provider.snapshot();
        },
        fail(error) {
          entry.status = 'failed';
          entry.error = error.message;
        },
      };
    },
  });
  const plan = new RecordingPlan(r.api, streams, new AbortController().signal);
  preview.setSource({
    record: r.record,
    part: streams[0],
    loadGroups: signal => plan.load(signal),
    request: r.api.request,
  });
  r.player.seek(3);
  await settled(r, 4000);
  // Keep frame gating on the same object captured by getFrame.
  window.danmakuRig = Object.assign(r, {preview, canvas, errors, diagnostics});
  window.setPreviewVisibility = hidden => {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.overlayPixels = () => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0,
      left = Infinity;
    for (let i = 3; i < pixels.length; i += 4)
      if (pixels[i]) {
        count++;
        left = Math.min(left, ((i - 3) / 4) % canvas.width);
      }
    return {count, left};
  };
};

window.seekTo = async ({target, timeout}) => {
  const r = rig();
  await load(r);
  r.player.seek(0.4);
  await settled(r, timeout);
  r.player.seek(target);
  const framedAt = await settled(r, timeout);
  return {target, framedAt, time: r.video.currentTime};
};

window.openAt = async ({target, timeout}) => {
  const r = rig();
  await load(r);
  r.player.seek(target);
  return {target, framedAt: await settled(r, timeout), time: r.video.currentTime};
};

window.drag = async ({timeout}) => {
  const r = rig();
  await load(r);
  r.player.seek(0.4);
  await settled(r, timeout);
  await sleep(300);
  const loads = () => [...r.counts.values()].reduce((sum, value) => sum + value, 0),
    before = loads();
  let seeks = 0;
  r.video.addEventListener('seeking', () => seeks++);
  r.player.beginScrub();
  for (let i = 0; i < 40; i++) {
    r.player.scrub(1 + i * 0.7);
    await sleep(16);
  }
  const during = {seeks, stillShown: !r.still.hidden};
  r.player.endScrub();
  const framedAt = await settled(r, timeout);
  return {...during, framedAt, stillAfter: !r.still.hidden, time: r.video.currentTime, loads: loads() - before};
};

function controlledRig(range) {
  const r = rig(),
    errors = [];
  const playback = createPlayback(r.video, message => errors.push(message), {
    getRange: () => range,
    position: () => r.player.position(),
    seek: time => r.player.seek(time),
  });
  bindVideoControls(r.video, playback, message => errors.push(message), {
    fullscreenTarget: r.wrap,
    exitButton: r.exitButton,
  });
  return {...r, playback, errors};
}

window.restoreAfterTrim = async ({timeout, paused, settledPreview}) => {
  const r = controlledRig({start: 5, end: 30});
  await load(r);
  r.player.seek(12.7);
  const initialFrame = await settled(r, timeout);
  if (!paused) {
    await r.video.play();
    await sleep(100);
  }
  const saved = r.player.position();
  r.playback.begin();
  r.player.beginScrub();
  r.player.scrub(25.3);
  let previewFrame = null;
  if (settledPreview) {
    await sleep(180);
    previewFrame = await settled(r, timeout);
  }
  const previewTime = r.video.currentTime;
  r.player.endScrub(saved);
  const restoredTime = r.video.currentTime;
  r.playback.end();
  const restoredFrame = await settled(r, timeout);
  await sleep(400);
  return {
    initialFrame,
    previewFrame,
    previewTime,
    saved,
    restoredTime,
    restoredFrame,
    finalTime: r.video.currentTime,
    paused: r.video.paused,
    stillShown: !r.still.hidden,
    errors: r.errors,
  };
};

window.fullscreenPlayback = async ({timeout, container = false}) => {
  const r = controlledRig({start: 10, end: 15}),
    host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({mode: 'open'});
  root.append(container ? r.wrap : r.video);
  await load(r);
  r.player.seek(12.7);
  const initialFrame = await settled(r, timeout);
  await r.video.play();
  const target = container ? r.wrap : r.video;
  await target.requestFullscreen();
  const retargeted = document.fullscreenElement === host && root.fullscreenElement === target,
    positions = [];
  for (const target of [3.4, 25.3]) {
    r.video.currentTime = target;
    const framedAt = await settled(r, timeout);
    await sleep(250);
    positions.push({target, time: r.video.currentTime, paused: r.video.paused, framedAt});
  }
  await document.exitFullscreen();
  await sleep(150);
  const exitFrame = await settled(r, timeout);
  return {
    initialFrame,
    retargeted,
    positions,
    exitFrame,
    exitTime: r.video.currentTime,
    exitPaused: r.video.paused,
    errors: r.errors,
  };
};

const ranged = async (url, {range, signal}) => {
  const response = await fetch(url, {
    signal,
    headers: {Range: `bytes=${range.offset}-${range.offset + range.length - 1}`},
  });
  if (response.status !== 206) throw new Error(`range ignored: ${response.status}`);
  return {data: await response.arrayBuffer()};
};

window.fragmentStill = async ({segment}) => {
  const bytes = [];
  const request = async (url, options) => {
    const result = await ranged(url, options);
    bytes.push(result.data.byteLength);
    return result;
  };
  try {
    const canvas = await readFragmentStill(
      request,
      {segment: {url: segment}, map: {url: '/init.mp4'}},
      {signal: new AbortController().signal},
    );
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) total += pixels[i] + pixels[i + 1] + pixels[i + 2];
    return {
      width: canvas.width,
      height: canvas.height,
      brightness: total / (pixels.length / 4) / 3,
      bytes: bytes.reduce((a, b) => a + b, 0),
    };
  } catch (error) {
    return {error: error.message};
  }
};
