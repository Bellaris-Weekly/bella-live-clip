import {h, render, options} from 'preact';
import {signal} from '@preact/signals';
import {ComposeSheet} from '../../../src/ui/compose.jsx';
import {createTemplateForm} from '../../../src/preview/template-form.js';
import {createCover} from '../../../src/preview/cover.js';
import theme from '../../../src/ui/theme.css';

options.debounceRendering = callback => callback();
const host = document.createElement('div');
document.body.append(host);
const root = host.attachShadow({mode: 'open'}),
  style = document.createElement('style');
style.textContent = theme;
root.append(style);
const panel = document.createElement('section');
panel.id = 'panel';
Object.assign(panel.style, {
  inset: '16px',
  padding: '16px',
  font: '14px system-ui',
  color: 'hsl(var(--foreground))',
  animation: 'none',
});
root.append(panel);
render(h(ComposeSheet, {composer: null}), panel);
const form = createTemplateForm(root.getElementById('composeForm'));
const get = (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
const set = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const cover = createCover({get, set});
const frame = document.createElement('canvas');
frame.width = 1920;
frame.height = 1080;
const ctx = frame.getContext('2d');
const gradient = ctx.createLinearGradient(0, 0, 1920, 1080);
gradient.addColorStop(0, '#f6d7d2');
gradient.addColorStop(1, '#dbc5df');
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, 1920, 1080);
cover.setFrame({image: frame, time: 20, key: 'record'});
cover.setText({value: '贝拉直播切片'});
const event = {uid: 'live', start: Date.now() / 1000 - 3600, title: '周末杂谈', participants: [{id: 'bella'}]};
form.configure(
  [
    {
      id: 1,
      name: '贝拉单播',
      payload: {
        title: '{live_title} 精彩片段',
        tags: ['贝拉', 'A-SOUL'],
        tid: 27,
        desc: '{live}\n视频二创组——{clipper}',
        includeAntiCollision: true,
        liveParticipants: ['bella'],
      },
    },
  ],
  {matched: event, recent: [event]},
  '二创组成员',
  false,
);
const view = signal({
  open: true,
  locked: false,
  title: '贝拉直播回放',
  selection: '00:20–01:10 · 50 秒',
  stage: '上传完成，等待确认投稿',
  confirmText: '确认投稿',
  export: 1,
  upload: 1,
});
let submissions = 0;
const composer = {
  cover,
  view,
  actions: {
    confirm() {
      submissions++;
      window.controls.request = form.fields();
    },
    close() {},
  },
};
render(h(ComposeSheet, {composer}), panel);
window.controls = {
  form,
  cover,
  view,
  host,
  get submissions() {
    return submissions;
  },
};
