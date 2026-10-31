// Browser integration fixture. Serve /growth-{10,20,30}.m3u8 as expanding
// snapshots of the same HLS recording, with real media segments beside them.
import {createApp} from '../../../src/app/application.js';
import metadata from '../../../src/header.txt';
import {Input, BufferSource, MP4} from 'mediabunny';

const record = {
  key: 'growth-fixture',
  title: '直播增长与断流验证',
  start: Math.floor(Date.now() / 1000) - 120,
  end: 0,
  live: true,
  room: 22632424,
  uid: 672353429,
  member: '贝拉',
};
const state = {duration: 10, reconnected: false, clips: 0, current: 0, reads: [], saved: null};
const timers = new Map(),
  nativeSetTimeout = window.setTimeout.bind(window),
  nativeClearTimeout = window.clearTimeout.bind(window);
let timerId = 0;
window.setTimeout = (fn, delay, ...args) => {
  if (delay !== 30000) return nativeSetTimeout(fn, delay, ...args);
  const id = `live-poll-${++timerId}`;
  timers.set(id, () => fn(...args));
  return id;
};
window.clearTimeout = id => {
  if (!timers.delete(id)) nativeClearTimeout(id);
};
const api = {
  history: async () => [],
  current: async () => {
    state.current++;
    return record;
  },
  clips: async owner => {
    state.clips++;
    return [
      {
        start_time: owner.start,
        end_time: owner.start + state.duration,
        stream: `${location.origin}/growth-${state.duration}.m3u8`,
      },
      ...(state.reconnected
        ? [{start_time: owner.start + 40, end_time: owner.start + 50, stream: `${location.origin}/growth-10.m3u8`}]
        : []),
    ];
  },
  request: async (url, {type, signal} = {}) => {
    if (url.startsWith('https://share.bellaris.fans/')) return {url, data: metadata};
    if (url.startsWith('https://calendar.')) return {url, data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'};
    state.reads.push(url);
    const response = await fetch(url, {signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {url: response.url, data: type === 'arraybuffer' ? await response.arrayBuffer() : await response.text()};
  },
};
const saveFilePicker = async ({suggestedName}) => ({
  name: suggestedName,
  async createWritable() {
    const writes = [];
    return {
      async write(value) {
        writes.push({...value, data: value.data.slice()});
      },
      async close() {
        const bytes = new Uint8Array(Math.max(...writes.map(value => value.position + value.data.length)));
        for (const value of writes) bytes.set(value.data, value.position);
        const input = new Input({source: new BufferSource(bytes), formats: [MP4]});
        try {
          state.saved = {
            name: suggestedName,
            bytes: bytes.length,
            duration: await input.computeDuration(),
            audio: Boolean(await input.getPrimaryAudioTrack()),
            video: Boolean(await input.getPrimaryVideoTrack()),
          };
        } finally {
          input.dispose();
        }
      },
      async abort() {
        state.saved = {aborted: true};
      },
    };
  },
});
const app = createApp({api, saveFilePicker, pageUrl: 'https://www.bilibili.com/'});
window.liveGrowth = {
  state,
  app,
  timers,
  async poll() {
    const entry = timers.entries().next().value;
    if (!entry) throw new Error('No live poll scheduled');
    timers.delete(entry[0]);
    await entry[1]();
  },
};
void app.open();
