import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {installLiveScreenshot} from '../../../src/ui/live-screenshot.js';
import {
  createScreenshotShortcut,
  bindScreenshotShortcut,
  SCREENSHOT_PREF_KEY,
} from '../../../src/ui/screenshot-shortcut.js';

const key = (code = 'KeyP') => ({code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false});
const saved = (code, updatedAt, source = 'gif') => ({shortcut: key(code), updatedAt, source});
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const dom = new JSDOM('<!doctype html><body></body>', {url: 'https://live.bilibili.com/123'});
  const {window} = dom;
  const {document} = window;
  t.after(() => window.close());
  let frames = 0,
    downloads = 0;
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {
      frames++;
    },
  });
  window.HTMLCanvasElement.prototype.toBlob = callback => callback(new window.Blob(['png']));
  const mount = (width = 640) => {
    const player = document.createElement('section');
    player.innerHTML = '<video></video><div><button class="web-player-icon-feedback"></button></div>';
    document.body.append(player);
    const video = player.querySelector('video');
    Object.defineProperties(video, {
      readyState: {value: 2},
      videoWidth: {value: width},
      videoHeight: {value: 360},
    });
    video.getBoundingClientRect = () => ({width, height: 360});
    return {player, video, control: player.querySelector('button')};
  };
  const install = () =>
    installLiveScreenshot({
      rootDocument: document,
      selectVideo: root => root.querySelector('video'),
      getIdentity: () => ({roomId: '123'}),
      download: () => downloads++,
    });
  const press = (code = 'KeyP', target = document.body, options = {}) => {
    const event = new window.KeyboardEvent('keydown', {
      key: code.replace('Key', ''),
      ...key(code),
      bubbles: true,
      composed: true,
      cancelable: true,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  return {window, document, mount, install, press, frames: () => frames, downloads: () => downloads};
}

function isolatedFactory() {
  const module = {exports: {}};
  runInNewContext(
    readFileSync(new URL('../../../src/ui/screenshot-shortcut.js', import.meta.url), 'utf8').replace(
      'export {',
      'module.exports = {',
    ),
    {module},
  );
  return module.exports.createScreenshotShortcut;
}

for (const order of [
  ['gif', 'clip'],
  ['clip', 'gif'],
]) {
  test(`one screenshot and synchronous config propagation across sandboxes: ${order}`, async t => {
    const f = fixture(t);
    f.mount();
    const stores = [{}, {}];
    const clients = order.map((clientId, i) =>
      isolatedFactory()({
        document: f.document,
        clientId,
        write: value => {
          stores[i].value = JSON.parse(JSON.stringify(value));
        },
      }),
    );
    assert.equal(f.install(), true);
    assert.equal(f.install(), false);
    f.press();
    assert.equal(f.frames(), 1); // Capture occurs during keydown, before yielding.
    await flush();
    assert.equal(f.downloads(), 1);
    assert.equal(clients[1].set(key('KeyK')), true);
    assert.equal(clients[0].get().code, 'KeyK');
    assert.deepEqual(stores[0], stores[1]);
    f.press();
    assert.equal(f.frames(), 1);
    f.press('KeyK');
    await flush();
    assert.equal(f.downloads(), 2);
  });
}

test('a new keyboard owner calls an existing legacy screenshot owner', async t => {
  const f = fixture(t);
  f.mount();
  f.install();
  createScreenshotShortcut({document: f.document, clientId: 'new'});
  f.press();
  await flush();
  assert.equal(f.downloads(), 1);
});

test('hidden controls remain usable in fullscreen and player replacement', async t => {
  const f = fixture(t);
  const large = f.mount(1280),
    small = f.mount(320);
  f.install();
  createScreenshotShortcut({document: f.document, clientId: 'gif'});
  let full = small.player;
  Object.defineProperty(f.document, 'fullscreenElement', {get: () => full});
  small.control.style.display = 'none';
  const captured = [];
  f.window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage(video) {
      captured.push(video);
    },
  });
  f.press();
  await flush();
  assert.deepEqual(captured, [small.video]);
  full = small.video;
  f.press();
  await flush();
  assert.equal(captured[1], small.video);
  full = null;
  small.player.remove();
  large.player.remove();
  const replacement = f.mount();
  await new Promise(resolve => setTimeout(resolve, 300));
  f.press();
  await flush();
  assert.equal(captured[2], replacement.video);
});

test('typing, recording, IME and holding the key do not capture', async t => {
  const f = fixture(t);
  f.mount();
  f.install();
  createScreenshotShortcut({document: f.document, clientId: 'gif'});
  for (const tag of ['input', 'textarea', 'select']) {
    const input = f.document.createElement(tag);
    f.document.body.append(input);
    f.press('KeyP', input);
  }
  const host = f.document.createElement('div');
  f.document.body.append(host);
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = '<input readonly>';
  f.press('KeyP', shadow.querySelector('input'));
  const editing = f.document.createElement('span');
  Object.defineProperty(editing, 'isContentEditable', {value: true});
  f.document.body.append(editing);
  f.press('KeyP', editing);
  f.press('KeyP', f.document.body, {repeat: true});
  f.press('KeyP', f.document.body, {isComposing: true});
  f.press('KeyP', f.document.body, {keyCode: 229});
  f.press('KeyP', f.document.body, {ctrlKey: true});
  await flush();
  assert.equal(f.downloads(), 0);
});

test('latest persisted edit wins without live updates from another tab', t => {
  const f = fixture(t);
  f.document.documentElement.setAttribute('data-bella-screenshot-shortcut-v1', JSON.stringify(saved('KeyJ', 1)));
  f.window.localStorage.setItem(SCREENSHOT_PREF_KEY, JSON.stringify(saved('KeyK', 3)));
  let persisted;
  const api = createScreenshotShortcut({
    document: f.document,
    clientId: 'gif',
    read: () => saved('KeyL', 2),
    write: value => {
      persisted = value;
    },
  });
  assert.equal(api.get().code, 'KeyK');
  assert.equal(persisted.shortcut.code, 'KeyK');
  f.window.localStorage.setItem(SCREENSHOT_PREF_KEY, JSON.stringify(saved('KeyM', 4)));
  f.window.dispatchEvent(new f.window.StorageEvent('storage', {key: SCREENSHOT_PREF_KEY}));
  assert.equal(api.get().code, 'KeyK');
  // Reload / a newly installed client recovers the saved edit.
  createScreenshotShortcut({document: f.document, clientId: 'clip'});
  assert.equal(api.get().code, 'KeyM');
});

test('conflicts reject edits and recording follows changes from the other plugin', t => {
  const f = fixture(t);
  const api = createScreenshotShortcut({document: f.document, clientId: 'gif'});
  const other = createScreenshotShortcut({document: f.document, clientId: 'clip'});
  other.registerAction('clip-launcher', key('KeyC'));
  assert.equal(api.set(key('KeyC')), false);
  assert.equal(api.conflicts(key(), 'gif-launcher'), true);
  const input = f.document.createElement('input');
  input.readOnly = true;
  f.document.body.append(input);
  let conflicts = 0;
  bindScreenshotShortcut({input, shortcut: api, format: value => value.code.slice(3), onConflict: () => conflicts++});
  assert.equal(input.value, 'P');
  input.focus();
  assert.equal(input.value, '按下快捷键');
  f.press('KeyC', input);
  assert.equal(conflicts, 1);
  assert.equal(api.get().code, 'KeyP');
  f.press('KeyJ', input);
  assert.equal(input.value, 'J');
  other.set(key('KeyK'));
  assert.equal(input.value, 'K');
  input.focus();
  f.press('Escape', input, {key: 'Escape'});
  assert.equal(input.value, 'K');
});

test('unavailable storage and malformed saved values do not prevent default screenshots', async t => {
  const f = fixture(t);
  f.mount();
  f.install();
  f.window.localStorage.setItem(SCREENSHOT_PREF_KEY, '{');
  createScreenshotShortcut({
    document: f.document,
    clientId: 'gif',
    read: () => ({shortcut: key(), updatedAt: Infinity}),
    write: () => {
      throw Error('blocked');
    },
  });
  f.press();
  await flush();
  assert.equal(f.downloads(), 1);
});

test('an unenhanced feedback button is never invoked and the key is not swallowed', t => {
  const f = fixture(t);
  const {control} = f.mount();
  let clicks = 0;
  control.addEventListener('click', () => clicks++);
  createScreenshotShortcut({document: f.document, clientId: 'gif'});
  assert.equal(f.press().defaultPrevented, false);
  assert.equal(clicks, 0);
});
