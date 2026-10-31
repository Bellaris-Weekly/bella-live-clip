import test from 'node:test';
import assert from 'node:assert/strict';
import {captureVideoPng, findScreenshotVideo, formatScreenshotFileName} from '../../../src/ui/live-screenshot.js';

function captureFixture(width, height, { blob = new Blob(['png'], { type: 'image/png' }), error = null } = {}) {
  const calls = [];
  const video = { videoWidth: width, videoHeight: height, readyState: 2, seeking: false, currentTime: 12 };
  let finish;
  const canvas = {
    getContext(type, options) {
      calls.push({ type, options });
      return { drawImage(...args) { calls.push({ args, time: video.currentTime }); } };
    },
    toBlob(callback, type) {
      calls.push({ type, width: this.width, height: this.height });
      if (error) throw error;
      finish = () => callback(blob);
    },
  };
  const doc = { createElement(tag) { assert.equal(tag, 'canvas'); return canvas; } };
  return { video, canvas, calls, doc, finish: () => finish() };
}

for (const [width, height] of [[3840, 2160], [1080, 1920], [2560, 1080]]) {
  test(`PNG keeps the full ${width}×${height} frame regardless of player CSS size`, async () => {
    const fixture = captureFixture(width, height);
    fixture.video.clientWidth = 320;
    fixture.video.clientHeight = 180;
    const pending = captureVideoPng(fixture.video, fixture.doc);
    assert.deepEqual(fixture.calls[1].args, [fixture.video, 0, 0, width, height]);
    assert.deepEqual(fixture.calls[2], { type: 'image/png', width, height });
    fixture.finish();
    assert.equal((await pending).type, 'image/png');
    assert.equal(fixture.canvas.width, 0);
  });
}

test('freezes the click-time frame before asynchronous encoding finishes', async () => {
  const fixture = captureFixture(1920, 1080);
  const pending = captureVideoPng(fixture.video, fixture.doc);
  assert.equal(fixture.calls[1].time, 12);
  fixture.video.currentTime = 13;
  fixture.finish();
  await pending;
  assert.equal(fixture.calls.filter(call => call.args).length, 1);
});

test('rejects unavailable or seeking video without exporting a blank image', async () => {
  for (const video of [null, { readyState: 1 }, { readyState: 2, videoWidth: 0, videoHeight: 1080 },
    { readyState: 2, videoWidth: 1920, videoHeight: 1080, seeking: true }]) {
    await assert.rejects(captureVideoPng(video, { createElement() { assert.fail('must not create a canvas'); } }), /暂无画面/);
  }
});

test('reports failed encoding and browser cross-origin rejection', async () => {
  const fixture = captureFixture(1920, 1080, { blob: null });
  const pending = captureVideoPng(fixture.video, fixture.doc);
  fixture.finish();
  await assert.rejects(pending, /截图失败/);
  const restricted = captureFixture(1920, 1080, { error: new DOMException('tainted', 'SecurityError') });
  await assert.rejects(captureVideoPng(restricted.video, restricted.doc), { name: 'SecurityError' });
});

test('selects the video within the clicked player instead of another player or the editor', () => {
  const other = { id: 'editor' };
  const own = { id: 'live' };
  const page = { querySelector: () => other, parentElement: null };
  const player = { querySelector: () => own, parentElement: page };
  const toolbar = { querySelector: () => null, parentElement: player };
  assert.equal(findScreenshotVideo({ parentElement: toolbar }, root => root.querySelector('video')), own);
  // An unready local video must not fall through to a different ready player.
  assert.equal(findScreenshotVideo({ parentElement: toolbar }, () => null), null);
});

test('names screenshots using local click time and safe streamer names', () => {
  const date = new Date(2026, 9, 31, 20, 1, 2, 7);
  assert.equal(formatScreenshotFileName(date, { streamerName: '贝拉/测试:直播' }), '贝拉_测试_直播_20261031_200102_007.png');
  assert.equal(formatScreenshotFileName(date, { roomId: '1234' }), '1234_20261031_200102_007.png');
});

import {JSDOM} from 'jsdom';
import {installLiveScreenshot} from '../../../src/ui/live-screenshot.js';
const flush = () => new Promise(resolve => setImmediate(resolve));

function pageFixture(t, { embedded = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://live.bilibili.com/1234' });
  t.after(() => dom.window.close());
  let document = dom.window.document;
  if (embedded) {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    document = iframe.contentDocument;
  }
  const window = document.defaultView;
  const downloads = [];
  const frames = [];
  let encode;
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage: video => frames.push({ video, width: this.width, height: this.height }) };
  };
  window.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
    encode = () => callback(new Blob(['png'], { type }));
  };
  const mount = (width = 1920, height = 1080) => {
    const player = document.createElement('section');
    player.innerHTML = '<video></video><div class="toolbar"><div class="web-player-icon-feedback"><svg></svg></div></div>';
    const video = player.querySelector('video');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: width }, videoHeight: { value: height },
    });
    const control = player.querySelector('.web-player-icon-feedback');
    let feedbackClicks = 0;
    // The site's listener already exists when our script finds the control.
    control.addEventListener('click', () => feedbackClicks++);
    document.body.append(player);
    return { player, video, control, feedbackClicks: () => feedbackClicks };
  };
  const install = () => installLiveScreenshot({ rootDocument: document,
    selectVideo: root => root.querySelector('video'), getIdentity: () => ({ streamerName: '测试主播' }),
    download: (blob, name) => downloads.push({ blob, name }),
  });
  return { document, window, downloads, frames, mount, install, finish: () => encode() };
}

test('replaces feedback in place and one click downloads once without opening feedback', async t => {
  const page = pageFixture(t);
  const { control, feedbackClicks } = page.mount();
  page.install();
  await flush();
  assert.equal(control.getAttribute('aria-label'), '截图');
  assert.equal(control.getAttribute('role'), 'button');
  assert.ok(control.querySelector('[data-bella-screenshot-icon]'));
  control.querySelector('path').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  assert.equal(page.frames.length, 1);
  assert.equal(feedbackClicks(), 0);
  control.click();
  assert.equal(page.frames.length, 1, 'concurrent click must not start a second encoding');
  page.finish();
  await flush();
  assert.equal(page.downloads.length, 1);
  assert.equal(control.hasAttribute('aria-busy'), false);
  assert.equal(page.document.querySelector('[role=status]'), null);
});

test('late loading, player replacement and icon redraw do not lose the action or duplicate it', async t => {
  const page = pageFixture(t);
  page.install();
  const first = page.mount();
  await flush();
  first.control.innerHTML = '<svg><title>反馈</title></svg>';
  await flush();
  assert.ok(first.control.querySelector('[data-bella-screenshot-icon]'));
  first.player.remove();
  const second = page.mount(1080, 1920);
  await flush();
  second.control.click();
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].video, second.video);
  assert.equal(page.frames[0].width, 1080);
  page.finish();
  await flush();
  assert.equal(page.downloads.length, 1);
  assert.equal(second.feedbackClicks(), 0);
});

test('an embedded player captures in its own document and supports keyboard activation', async t => {
  const page = pageFixture(t, { embedded: true });
  const { control, video } = page.mount(2560, 1440);
  page.install();
  await flush();
  control.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(page.frames[0].video, video);
  page.finish();
  await flush();
  assert.equal(page.downloads.length, 1);
  control.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true }));
  assert.equal(page.frames.length, 1);
});

test('no local video never captures a different player, and failure permits a retry', async t => {
  const page = pageFixture(t);
  const first = page.mount();
  page.mount();
  page.install();
  first.video.remove();
  first.control.click();
  await flush();
  assert.equal(page.frames.length, 0);
  assert.equal(page.downloads.length, 0);
  assert.match(page.document.querySelector('[role=status]').textContent, /暂无画面/);
  first.player.prepend(first.video);
  first.control.click();
  assert.equal(page.document.querySelector('[role=status]'), null);
  page.finish();
  await flush();
  assert.equal(page.downloads.length, 1);
});

test('replacing a player during PNG encoding still completes the original download', async t => {
  const page = pageFixture(t);
  const first = page.mount();
  page.install();
  first.control.click();
  first.player.remove();
  page.mount(3840, 2160);
  page.finish();
  await flush();
  assert.equal(page.downloads.length, 1);
  assert.equal(page.frames[0].video, first.video);
  assert.equal(page.document.querySelector('[role=status]'), null);
});


import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function isolatedScreenshotInstaller() {
  const module = {exports: {}};
  runInNewContext(readFileSync(new URL('../../../src/ui/live-screenshot.js', import.meta.url), 'utf8').replace('export {', 'module.exports = {'), {module});
  return module.exports.installLiveScreenshot;
}

for (const order of [['gif', 'clip'], ['clip', 'gif']]) {
  test(`independent userscript sandboxes share one screenshot owner: ${order.join(' then ')}`, async t => {
    const page = pageFixture(t);
    const downloads = [];
    let observers = 0;
    const Observer = page.window.MutationObserver;
    page.window.MutationObserver = class extends Observer {
      constructor(callback) { super(callback); observers++; }
    };
    // Separate VM contexts model userscript managers with isolated JavaScript globals.
    const installers = order.map(() => isolatedScreenshotInstaller());
    const install = (index) => installers[index]({rootDocument: page.document,
      selectVideo: root => root.querySelector('video'), getIdentity: () => ({roomId: '123'}),
      download: () => downloads.push(order[index]),
    });
    assert.equal(install(0), true);
    assert.equal(install(1), false);
    assert.equal(observers, 1);
    // Claiming must work before the site has even created its player.
    const first = page.mount();
    await flush();
    first.control.click(); page.finish(); await flush();
    assert.deepEqual(downloads, [order[0]]);
    first.player.remove();
    const second = page.mount(1080, 1920);
    await flush();
    second.control.click(); page.finish(); await flush();
    assert.deepEqual(downloads, [order[0], order[0]]);
    assert.equal(second.control.querySelectorAll('[data-bella-screenshot-icon]').length, 1);
    assert.equal(second.feedbackClicks(), 0);
  });
}

test('top document ownership does not suppress screenshots in an iframe document', async t => {
  const page = pageFixture(t, {embedded: true});
  const install = isolatedScreenshotInstaller();
  const top = page.window.parent.document;
  assert.equal(install({rootDocument: top, selectVideo() {}, getIdentity() {}, download() {}}), true);
  const {control} = page.mount();
  page.install();
  control.click(); page.finish(); await flush();
  assert.equal(page.downloads.length, 1);
});

import {startLiveScreenshot} from '../../../src/app/live-screenshot.js';

for (const embedded of [false, true]) {
  test(`clip startup downloads a native-sized PNG in ${embedded ? 'an iframe' : 'the top page'}`, async t => {
    const page = pageFixture(t, {embedded});
    const {control, video} = page.mount(3840, 2160);
    video.getBoundingClientRect = () => ({width: 640, height: 360});
    page.document.title = '直播标题 - 切片主播 - 哔哩哔哩直播';
    const urls = [];
    page.window.URL.createObjectURL = blob => { urls.push(blob); return 'blob:screenshot-test'; };
    const saved = [];
    page.window.HTMLAnchorElement.prototype.click = function () {
      saved.push({name: this.download, href: this.href});
    };
    assert.equal(startLiveScreenshot(page.document), true);
    assert.equal(startLiveScreenshot(page.document), false);
    control.click();
    page.finish(); await flush();
    assert.equal(urls.length, 1);
    assert.equal(urls[0].type, 'image/png');
    assert.deepEqual([page.frames[0].width, page.frames[0].height], [3840, 2160]);
    assert.match(saved[0].name, /^切片主播_\d{8}_\d{6}_\d{3}\.png$/);
    assert.equal(saved[0].href, 'blob:screenshot-test');
    assert.equal(page.document.querySelector('a[download]'), null);
  });
}

import {createScreenshotControls} from '../../../src/ui/live-screenshot.js';
import {downloadScreenshot} from '../../../src/app/live-screenshot.js';

for (const [width, height] of [[3840,2160], [1080,1920], [3440,1440]]) {
  test(`editor in a shadow root captures its active ${width}x${height} source independently of live ownership`, async t => {
    const page = pageFixture(t);
    const live = page.mount();
    page.install(); // Another userscript may already own the native live button.
    const host = page.document.createElement('div');page.document.body.append(host);
    const root = host.attachShadow({mode:'open'});
    root.innerHTML = '<div><video></video><canvas></canvas><button type="button"></button></div>';
    const button = root.querySelector('button'), video = root.querySelector('video');
    Object.defineProperties(video, {readyState:{value:2},videoWidth:{value:width},videoHeight:{value:height}});
    let active = video;
    const saved=[];
    page.window.URL.createObjectURL = blob => {assert.equal(blob.type,'image/png');return 'blob:preview';};
    page.window.HTMLAnchorElement.prototype.click = function(){saved.push(this.download);};
    const enhance = createScreenshotControls({rootDocument:page.document,getVideo:()=>active,
      getIdentity:()=>({streamerName:'预览主播'}),download:(blob,name)=>downloadScreenshot(page.document,blob,name)});
    enhance(button);enhance(button);
    assert.equal(button.title,'截图');assert.equal(button.querySelectorAll('svg').length,1);
    button.click();button.click();
    assert.deepEqual(page.frames,[{video,width,height}]);
    page.finish();await flush();
    assert.equal(saved.length,1);assert.match(saved[0],/^预览主播_\d{8}_\d{6}_\d{3}\.png$/);
    assert.equal(page.downloads.length,0,'editor must not trigger the live-page handler');
    assert.equal(root.querySelector('[role=status]'),null);
    // Switching sources must be read at click time, including a page-backed mirror.
    active=live.video;button.click();assert.equal(page.frames.at(-1).video,live.video);
    page.finish();await flush();assert.equal(saved.length,2);
    active=null;button.click();await flush();
    assert.match(root.querySelector('[role=status]').textContent,/暂无画面/);
    assert.equal(saved.length,2,'unavailable preview must not fall back to a nearby player');
    active=video;button.dispatchEvent(new page.window.KeyboardEvent('keydown',{key:' ',bubbles:true}));
    page.finish();await flush();assert.equal(saved.length,3);
    assert.equal(root.querySelector('[role=status]'),null);
  });
}
