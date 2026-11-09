import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';

const buildFixture = async (entry, plugins = []) =>
  (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'fixture',
      define: {__PREVIEW__: 'true'},
      loader: {'.txt': 'text', '.html': 'text', '.css': 'text'},
      plugins,
    })
  ).outputFiles[0].text;
const appCode = await buildFixture('src/app/application.js');
const workflowCode = await buildFixture('src/preview/workflow.js', [
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
const template = await readFile('src/ui/template.html', 'utf8');
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
  for (const id of ['download', 'refreshLibrary', 'currentVideo', 'recordMark']) $(id).click();
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

async function workflow(t) {
  const f = environment();
  f.login();
  f.w.eval(workflowCode);
  const host = f.w.document.createElement('div');
  f.w.document.body.append(host);
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = template;
  const $ = id => root.getElementById(id);
  $('panel').hidden = false;
  let record = {key: 'session', room: 99, start: 1000, end: 1200, live: true},
    marks = [],
    conflict = false,
    refreshes = 0;
  f.w.parts = [{start_time: 1000, end_time: 1200, firstDecodeTime: 10, origin: 990.49, index: 0}];
  const requests = [],
    selections = [];
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
  const ui = f.w.fixture.createWorkflow({
    root,
    client: f.client,
    ...f.store,
    api: {current: async () => ({room: 12000})},
    mediaRequest: async () => {},
    open() {},
    onLogout() {},
    session: {
      record: () => record,
      ready: () => true,
      view: () => ({start: 0, end: 200}),
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
    $,
    ui,
    requests,
    selections,
    setMarks: value => {
      marks = value;
    },
    setRecord: value => {
      record = value;
    },
    conflict: () => {
      conflict = true;
    },
    refreshes: () => refreshes,
  };
}

test('marks capture uses server time immediately, resolves page short IDs with panel closed, saves notes, and avoids shortcut conflicts', async t => {
  const f = await workflow(t);
  await f.ui.refresh();
  f.$('recordMark').click();
  let entry = [...f.values.values()].find(value => value?.mark);
  assert.equal(entry.mark.at, 1050000);
  assert.equal(entry.mark.room_id, 99);
  const input = f.$('studioToast').querySelector('input');
  input.value = 'note';
  input.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
  await tick();
  const put = f.requests.find(request => request.method === 'PUT');
  assert.equal(put.body.note, 'note');
  assert.equal(put.body.at, 1050000);
  assert.equal(f.$('studioTicks').children.length, 1);
  input.blur();
  f.$('panel').hidden = true;
  f.w.document.dispatchEvent(
    new f.w.KeyboardEvent('keydown', {code: 'KeyM', key: 'M', altKey: true, shiftKey: true, bubbles: true}),
  );
  entry = [...f.values.values()].find(value => value?.mark);
  assert.equal(entry.mark.room_id, 12000, 'closed panel uses the real room of the current page');
  const note = f.$('studioToast').querySelector('input');
  note.value = 'discard';
  note.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await tick();
  assert.equal(f.requests.filter(request => request.method === 'PUT').at(-1).body.note, '');
  const field = f.$('markShortcut');
  field.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'C', code: 'KeyC', altKey: true, shiftKey: true}));
  assert.equal(f.store.get('marks.shortcut', null), null, 'Alt+Shift+C cannot be assigned to marks');
});

test('list filters session range, jumps with margins, refreshes frozen live replay, handles conflicts/delete/restore/history, and stops hidden polling', async t => {
  const f = await workflow(t);
  const mark = {id: 'id', room_id: 99, at: 1040000, note: 'note', rev: 1, created_by: '成员', bvid: 'BV1234567890'};
  f.setMarks([mark, {...mark, id: 'outside', at: 999000}, {...mark, id: 'other', room_id: 1}]);
  await f.ui.refresh();
  assert.equal(f.$('studioMarks').children.length, 1);
  const click = text =>
    [...f.$('studioMarks').querySelectorAll('button')].find(button => button.textContent === text).click();
  click('08:17:20');
  await tick();
  assert.ok(Math.abs(f.selections[0].start - 9.51) < 1e-6);
  assert.ok(Math.abs(f.selections[0].end - 54.51) < 1e-6);
  click('历史');
  await tick();
  assert.match(f.$('studioMarks').textContent, /#1 create/);
  f.conflict();
  click('删除');
  await tick();
  assert.match(f.$('studioToast').textContent, /已被修改/);
  click('删除');
  await tick();
  assert.match(f.$('studioMarks').textContent, /已删除/);
  click('撤销删除');
  await tick();
  assert.doesNotMatch(f.$('studioMarks').textContent, /已删除/);
  f.w.parts = [{...f.w.parts[0], end_time: 1045}];
  await f.ui.refresh();
  click('08:17:20');
  await tick();
  assert.equal(f.refreshes(), 1);
  assert.match(f.$('studioToast').textContent, /等待回放/);
  await f.ui.refresh();
  assert.equal(f.selections.length, 2);
  const count = f.requests.length;
  f.$('panel').hidden = true;
  await f.ui.refresh();
  assert.equal(f.requests.length, count);
  f.$('panel').hidden = false;
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
