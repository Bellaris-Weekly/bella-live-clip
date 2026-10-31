// Runs inside Chromium against the real player and hls.js.
import {createPlayer} from '../../../src/media/preview-player.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rig() {
  const video = document.createElement('video');
  video.muted = true;
  document.body.append(video);
  const loading = document.createElement('div'), still = document.createElement('img');
  still.hidden = true;
  document.body.append(still);
  const counts = new Map();
  const request = async (url, {type, signal} = {}) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    const response = await fetch(url, {signal});
    return {data: type === 'arraybuffer' ? await response.arrayBuffer() : await response.text(), url: response.url};
  };
  const player = createPlayer({
    video, loading, still, frameUrl: time => `/still.svg?t=${Math.round(time)}`, status() {}, onTime() {},
    api: {request, clips: async () => [{start_time: 1000, end_time: 1034, stream: `${location.origin}/v.m3u8`}]},
  });
  return {video, loading, still, player, counts};
}

async function settled({video, loading}, timeout) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (video.readyState >= 2 && !video.seeking && loading.hidden) return Math.round(performance.now() - started);
    await sleep(15);
  }
  return null;
}

const load = (r) => r.player.load({key: 'k', start: 1000, end: 1034, live: false}, new AbortController().signal);

window.seekTo = async ({target, timeout}) => {
  const r = rig();
  await load(r);
  r.player.seek(.4);
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
  r.player.seek(.4);
  await settled(r, timeout);
  await sleep(300);
  const loads = () => [...r.counts.values()].reduce((sum, value) => sum + value, 0), before = loads();
  let seeks = 0;
  r.video.addEventListener('seeking', () => seeks++);
  r.player.beginScrub();
  for (let i = 0; i < 40; i++) {
    r.player.scrub(1 + i * .7);
    await sleep(16);
  }
  const during = {seeks, stillShown: !r.still.hidden};
  r.player.endScrub();
  const framedAt = await settled(r, timeout);
  return {...during, framedAt, stillAfter: !r.still.hidden, time: r.video.currentTime, loads: loads() - before};
};
