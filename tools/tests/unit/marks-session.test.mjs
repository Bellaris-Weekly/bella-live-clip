import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const buildFixture = async (entry, plugins = []) =>
  (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'fixture',
      define: {__PREVIEW__: 'true'},
      loader: {'.txt': 'text', '.css': 'text'},
      jsx: 'automatic',
      jsxImportSource: 'preact',
      plugins,
    })
  ).outputFiles[0].text;
const appCode = await buildFixture('src/app/application.js');
const marksCode = await buildFixture('src/preview/marks-session.js', [
  {
    name: 'clock-fixture',
    setup(build) {
      build.onResolve({filter: /^\.\/replay\.js$/}, () => ({path: 'clock', namespace: 'fixture'}));
      build.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({
        contents: `export const createReplayClock=()=>async()=>globalThis.parts; export {markSelection} from '${process.cwd()}/src/preview/replay.js';`,
        resolveDir: process.cwd(),
      }));
    },
  },
]);
const tick = () => new Promise(resolve => setImmediate(resolve));
function environment() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://live.bilibili.com/12',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const w = dom.window;
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  w.HTMLMediaElement.prototype.pause = () => {};
  w.HTMLMediaElement.prototype.load = () => {};
  const values = new Map(),
    listeners = [];
  let identity = null;
  const store = {
    get: (key, fallback) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    set: (key, value) => values.set(key, structuredClone(value)),
    keys: () => [...values.keys()],
  };
  const client = {
    identity: () => identity,
    subscribe: fn => listeners.push(fn),
    serverNow: () => 1050000,
    syncClock: async () => {},
    logout() {
      identity = null;
      listeners.forEach(fn => fn());
    },
  };
  const login = () => {
    identity = {token: 'token', name: '成员'};
    listeners.forEach(fn => fn());
  };
  return {dom, w, values, store, client, login};
}

test('preview application opens only login when logged out, blocks editor/export/hotkey/preload, and returns to gate on logout', async t => {
  const f = environment();
  t.after(() => f.w.close());
  const calls = [];
  f.w.eval(appCode);
  const api = {
    request: async () => {
      calls.push('request');
      throw new Error('offline');
    },
    current: async () => {
      calls.push('current');
      return null;
    },
    history: async () => {
      calls.push('history');
      return [];
    },
  };
  const app = f.w.fixture.createApp({api, studio: f.client, storageKeys: f.store.keys, ...f.store});
  const $ = id => app.root.getElementById(id);
  await app.open();
  assert.equal($('panel').hidden, false);
  assert.ok($('panel').hasAttribute('data-logged-out'));
  assert.equal($('studioLogin').hidden, false);
  assert.equal($('studioLogin').querySelector('a').href, 'https://studio.bk0717.com/plugin/link');
  assert.equal($('studioLogin').querySelector('a').target, '_blank');
  for (const id of ['download', 'refreshLibrary', 'currentVideo', 'launcherMark']) $(id)?.click();
  assert.equal($('launcherMark'), null, 'no marking while logged out');
  $('launcher').dispatchEvent(new f.w.Event('pointerenter'));
  f.w.document.dispatchEvent(
    new f.w.KeyboardEvent('keydown', {code: 'KeyM', key: 'M', altKey: true, shiftKey: true, bubbles: true}),
  );
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(f.values.size, 0);
  f.login();
  await tick();
  assert.equal($('studioLogin').hidden, true);
  assert.equal($('panel').hasAttribute('data-logged-out'), false);
  assert.ok(calls.includes('current'));
  f.client.logout();
  assert.equal($('studioLogin').hidden, false);
  assert.ok($('panel').hasAttribute('data-logged-out'));
  const before = calls.length;
  await app.open();
  $('download').click();
  await tick();
  assert.equal(calls.length, before);
});

async function session(t) {
  const f = environment();
  f.login();
  f.w.eval(marksCode);
  // Only the shortcut field is DOM the session binds to; everything else is state.
  const root = f.w.document.createElement('div');
  root.innerHTML = '<input id="markShortcut">';
  root.getElementById = id => root.querySelector(`#${id}`);
  f.w.document.body.append(root);
  let record = {key: 'session', room: 99, start: 1000, end: 1200, live: true},
    marks = [],
    conflict = false,
    refreshes = 0,
    open = true;
  f.w.parts = [{start_time: 1000, end_time: 1200, firstDecodeTime: 10, origin: 990.49, index: 0}];
  const requests = [],
    selections = [],
    notices = [];
  f.client.request = async (path, options = {}) => {
    requests.push({path, ...options});
    if (options.method) {
      if (conflict) {
        conflict = false;
        throw Object.assign(new Error('conflict'), {status: 409});
      }
      const id = path.split('/')[2].split('?')[0];
      const previous = marks.find(mark => mark.id === id);
      const mark = {
        ...previous,
        ...options.body,
        id,
        created_by: '成员',
        rev: (previous?.rev || 0) + 1,
        deleted: options.method === 'DELETE',
      };
      marks = [...marks.filter(mark => mark.id !== id), mark];
      return mark;
    }
    if (path.endsWith('/revisions'))
      return [{rev: 1, op: 'create', by: '成员', at_time: 1000000, changes: {note: ['', 'note']}}];
    return marks;
  };
  f.client.check = async () => {};
  const ui = f.w.fixture.createMarksSession({
    root,
    client: f.client,
    ...f.store,
    api: {current: async () => ({room: 12000, live: true, start: 1000, title: '直播', member: '贝拉'})},
    mediaRequest: async () => {},
    pageUrl: () => 'https://live.bilibili.com/12',
    notify: (text, options) => notices.push({text, ...options}),
    onLogout() {},
    session: {
      isOpen: () => open,
      open() {},
      record: () => record,
      ready: () => true,
      groups: async () => [],
      signal: () => new AbortController().signal,
      select: value => selections.push(value),
      refresh: async () => {
        refreshes++;
        f.w.parts = [{...f.w.parts[0], end_time: 1200}];
      },
    },
  });
  t.after(() => {
    ui.dispose();
    f.w.close();
  });
  await tick();
  return {
    ...f,
    root,
    ui,
    state: ui.state,
    actions: ui.actions,
    requests,
    selections,
    notices,
    setMarks: value => {
      marks = value;
    },
    setRecord: value => {
      record = value;
    },
    setOpen: value => {
      open = value;
    },
    conflict: () => {
      conflict = true;
    },
    refreshes: () => refreshes,
  };
}

test('marks capture drafts in memory, moves the time, saves notes, drops blank drafts, and avoids shortcut conflicts', async t => {
  const f = await session(t);
  await f.ui.refresh();
  f.actions.capture();
  await tick();
  assert.equal(
    [...f.values.values()].some(value => value?.mark),
    false,
    'a draft is not queued yet',
  );
  assert.equal(f.state.capture.value.at, 1050000);
  assert.equal(f.state.capture.value.room, 99);
  assert.equal(f.state.mini.value, false, 'the open panel shows the note row itself');
  f.actions.shiftCapture(-5);
  assert.equal(f.state.capture.value.at, 1045000);
  f.actions.shiftCapture(30);
  assert.equal(f.state.capture.value.at, 1050000, 'never later than now');
  f.actions.shiftCapture(-5);
  f.actions.restamp();
  assert.equal(f.state.capture.value.at, 1050000);
  f.actions.releaseCapture();
  assert.equal(f.state.capture.value.deadline, null, 'a blank note is not auto-saved');
  f.actions.setNote(' note ');
  f.actions.releaseCapture();
  assert.ok(f.state.capture.value.deadline, 'a written note counts down once left alone');
  f.actions.holdCapture();
  assert.equal(f.state.capture.value.deadline, null, 'focusing again stops the countdown');
  f.actions.saveCapture();
  await tick();
  const put = f.requests.find(request => request.method === 'PUT');
  assert.equal(put.body.note, 'note');
  assert.equal(put.body.at, 1050000);
  assert.equal(f.state.capture.value, null);
  assert.equal(f.state.items.value.filter(mark => mark.time !== null).length, 1, 'mapped onto the timeline');
  f.setOpen(false);
  f.setRecord(null);
  f.w.document.dispatchEvent(
    new f.w.KeyboardEvent('keydown', {code: 'KeyM', key: 'M', altKey: true, shiftKey: true, bubbles: true}),
  );
  await tick();
  assert.equal(f.state.capture.value.room, 12000, 'closed panel uses the real room of the current page');
  assert.equal(f.state.mini.value, true, 'marking with the panel closed opens the mini window');
  const puts = f.requests.filter(request => request.method === 'PUT').length;
  f.actions.capture();
  await tick();
  assert.equal(
    f.requests.filter(request => request.method === 'PUT').length,
    puts,
    'a replaced blank draft is dropped',
  );
  f.actions.discardCapture();
  assert.equal(f.state.capture.value, null);
  const field = f.root.getElementById('markShortcut');
  field.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'C', code: 'KeyC', altKey: true, shiftKey: true}));
  assert.equal(f.store.get('marks.shortcut', null), null, 'Alt+Shift+C cannot be assigned to marks');
  assert.equal(f.state.shortcut.value, 'Alt+Shift+M');
});

test('list filters session range, jumps with margins, refreshes frozen live replay, handles conflicts/delete/restore/history, and stops hidden polling', async t => {
  const f = await session(t);
  const mark = {id: 'id', room_id: 99, at: 1040000, note: 'note', rev: 1, created_by: '成员', bvid: 'BV1234567890'};
  f.setMarks([mark, {...mark, id: 'outside', at: 999000}, {...mark, id: 'other', room_id: 1}]);
  await f.ui.refresh();
  assert.deepEqual([...f.state.items.value.map(item => item.id)], ['id']);
  const item = () => f.state.items.value.find(entry => entry.id === 'id');
  assert.equal(item().mine, true);
  assert.equal(await f.actions.jump(item()), true);
  assert.ok(Math.abs(f.selections[0].start - 9.51) < 1e-6);
  assert.ok(Math.abs(f.selections[0].end - 54.51) < 1e-6);
  assert.equal(f.state.selected.value, 'id');
  await f.actions.history(item());
  assert.equal(f.state.history.value.rows[0].op, 'create');
  f.conflict();
  await f.actions.remove(item());
  assert.match(f.notices.at(-1).text, /修改/);
  await f.actions.remove(item());
  assert.equal(item().deleted, true);
  await f.actions.restore(item());
  assert.equal(item().deleted, false);
  await f.actions.save(item(), '08:17:25', '改过');
  assert.equal(f.requests.at(-2).body.note, '改过');
  f.actions.setMargin('before', 'bad');
  assert.equal(f.store.get('marks.before'), 30);
  f.w.parts = [{...f.w.parts[0], end_time: 1045}];
  await f.ui.refresh();
  assert.equal(item().waiting, true);
  assert.equal(await f.actions.jump(item()), false);
  assert.equal(f.refreshes(), 1);
  assert.match(f.notices.at(-1).text, /还没生成/);
  await f.ui.refresh();
  assert.equal(f.selections.length, 2);
  const count = f.requests.length;
  f.setOpen(false);
  await f.ui.refresh();
  assert.equal(f.requests.length, count);
  f.setOpen(true);
  Object.defineProperty(f.w.document, 'hidden', {value: true, configurable: true});
  await f.ui.refresh();
  assert.equal(f.requests.length, count);
});

test('preview live screenshot control is hidden on logout and returns on login', async t => {
  const f = environment();
  t.after(() => f.w.close());
  f.w.document.body.innerHTML = '<div><video></video><button class="web-player-icon-feedback"></button></div>';
  f.w.eval(await buildFixture('src/app/live-screenshot.js'));
  f.w.fixture.startLiveScreenshot(f.w.document, f.client);
  const button = f.w.document.querySelector('button');
  assert.equal(f.w.getComputedStyle(button).display, 'none');
  f.login();
  assert.notEqual(f.w.getComputedStyle(button).display, 'none');
  f.client.logout();
  assert.equal(f.w.getComputedStyle(button).display, 'none');
});
