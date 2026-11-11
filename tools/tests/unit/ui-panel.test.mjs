import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

// Renders the real Preact panel into jsdom and drives it through the store, as application.js does.
// Disabled/hidden logic lives in the components now, so this is where it is verified.
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let ui;
before(async () => {
  const {outputFiles} = await build({
    stdin: {
      contents: `export {mountApp} from './src/ui/app.jsx'; export {createStore} from './src/app/store.js'; export {MEMBERS} from './src/domain/records.js';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
  });
  const dir = mkdtempSync(join(tmpdir(), 'ui-panel-'));
  const file = join(dir, 'ui.mjs');
  writeFileSync(file, outputFiles[0].text);
  ui = await import(pathToFileURL(file));
  rmSync(dir, {recursive: true});
});

function mount({preview = false, state = {}, feedback = false, overrides = {}} = {}) {
  const store = ui.createStore({member: ui.MEMBERS[0], exportMode: 'copy'});
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) => {
          calls.push([name, ...args]);
          return overrides[name]?.(...args);
        },
    },
  );
  if (preview) store.identity.value = {name: '成员'};
  for (const [key, value] of Object.entries(state)) store[key].value = value;
  const root = document.createElement('div');
  document.body.append(root);
  ui.mountApp(root, {store, actions, preview, feedback, members: ui.MEMBERS, studioUrl: 'https://studio.example'});
  return {
    store,
    calls,
    root,
    $: id => root.querySelector(`#${id}`),
    $$: selector => [...root.querySelectorAll(selector)],
  };
}
const live = {kind: 'live', key: 'k', title: '直播', room: 1, start: 0, end: 100};
const submission = {kind: 'submission', key: 'BV1:1', title: '视频', part: 1};
const editing = (record = live, extra = {}) => ({record, page: 'edit', ready: true, ...extra});

test('editor controls are enabled only when idle and ready; whole mode also locks range editing', () => {
  for (const busy of [false, true])
    for (const ready of [false, true])
      for (const whole of [false, true]) {
        const f = mount({state: editing(live, {busy, ready, whole})}),
          label = `${busy}/${ready}/${whole}`;
        assert.equal(f.$('download').disabled, busy || !ready, label);
        assert.equal(f.$('wholeRecording').disabled, busy || !ready, label);
        assert.equal(f.$('togglePlayback').disabled, busy || !ready, label);
        const locked = busy || !ready || whole;
        for (const id of ['markStart', 'markEnd', 'selectionStart', 'selectionEnd'])
          assert.equal(f.$(id).disabled, locked, `${id} ${label}`);
        assert.equal(f.$('exportMode') === null, whole, label);
        assert.match(f.$('download').textContent, whole ? /导出整场/ : /^\s*导出$/, label);
        assert.equal(f.$('download').hidden, false);
        assert.equal(f.root.querySelector('[aria-label="返回场次列表"]').disabled, busy, label);
        assert.equal(f.$('refreshEditor').disabled, busy, label);
        for (const button of f.$$('[data-mode]')) assert.equal(button.disabled, busy, label);
      }
});

test('the stop button exists only while busy and locks during whole-recording shutdown', () => {
  const idle = mount({state: editing()});
  assert.equal(idle.$('cancel'), null);
  const f = mount({state: editing(live, {busy: true, whole: true})});
  assert.equal(f.$('cancel').disabled, false);
  f.store.stopping.value = true;
  assert.equal(f.$('cancel').disabled, true);
  assert.equal(f.$('download').disabled, true);
  f.store.stopping.value = false;
  assert.equal(f.$('cancel').disabled, false);
  f.$('cancel').click();
  assert.equal(f.calls.at(-1)[0], 'cancel');
  f.store.busy.value = false;
  assert.equal(f.$('cancel'), null);
});

test('the export-mode picker is shown for live and video clips, hiding danmaku for videos and everything for whole', () => {
  for (const [record, modes] of [
    [live, ['copy', 'precise', 'danmaku']],
    [submission, ['copy', 'precise']],
  ]) {
    const f = mount({state: editing(record)});
    assert.deepEqual(
      f.$$('[data-mode]').map(button => button.dataset.mode),
      modes,
    );
    assert.equal(f.$('wholeRecording') === null, record.kind === 'submission');
    f.store.exportMode.value = 'precise';
    assert.deepEqual(
      f.$$('[data-mode][aria-pressed="true"]').map(button => button.dataset.mode),
      ['precise'],
    );
    f.$$('[data-mode]')[0].click();
    assert.deepEqual(f.calls.at(-1).slice(0, 2), ['setExportMode', 'copy']);
    if (record === live) {
      f.store.whole.value = true;
      assert.equal(f.$('exportMode'), null);
    }
  }
});

test('segment picker renders only for two or more segments and marks the selected one', () => {
  const f = mount({state: editing(live, {segments: [{label: 'a'}]})});
  assert.equal(f.$('segments'), null);
  f.store.segments.value = [{label: 'a'}, {label: 'b'}];
  f.store.segmentIndex.value = 1;
  const buttons = f.$$('#segments button');
  assert.deepEqual(
    buttons.map(button => button.getAttribute('aria-pressed')),
    ['false', 'true'],
  );
  buttons[0].click();
  assert.deepEqual(f.calls.at(-1), ['selectSegment', 0]);
  f.store.busy.value = true;
  assert.ok(f.$$('#segments button').every(button => button.disabled));
});

test('editor buttons and typed times call their actions; the refresh label follows the record kind', () => {
  const f = mount({state: editing()});
  f.$('markStart').click();
  f.$('markEnd').click();
  f.$('download').click();
  f.$('selectionStart').value = '0:05';
  f.$('selectionStart').dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  assert.deepEqual(
    f.calls.map(call => call[0]),
    ['markStart', 'markEnd', 'download', 'typeTime'],
  );
  assert.deepEqual(f.calls.at(-1), ['typeTime', 'start', '0:05']);
  assert.equal(f.$('refreshEditor').getAttribute('aria-label'), '刷新录像');
  f.store.record.value = submission;
  assert.equal(f.$('refreshEditor').getAttribute('aria-label'), '重新加载视频');
});

test('library lists records, disables them and member switches while busy, and offers the current video', () => {
  const f = mount();
  assert.equal(f.$('currentVideo'), null);
  f.store.records.value = [
    {...live, key: 'a'},
    {...live, key: 'b', start: 5},
  ];
  f.store.currentVideo.value = true;
  assert.deepEqual(
    f.$$('.records .record').map(button => button.dataset.recordKey),
    ['a', 'b'],
  );
  assert.ok(f.$('currentVideo'));
  f.$$('.records .record')[1].click();
  assert.equal(f.calls.at(-1)[0], 'openRecord');
  assert.equal(f.calls.at(-1)[1].key, 'b');
  assert.equal(f.$$('[data-member][aria-pressed="true"]').length, 1);
  f.store.busy.value = true;
  for (const button of [...f.$$('.record'), ...f.$$('[data-member]'), f.$('refreshLibrary'), f.$('currentVideo')])
    assert.equal(button.disabled, true);
  f.store.page.value = 'edit';
  assert.equal(f.$('library').hidden, true);
  assert.equal(f.$('editPage').hidden, false);
});

test('feedback shows only while busy, on error or with saved downloads, and keeps meters accurate', () => {
  const f = mount();
  assert.equal(f.$('feedback'), null);
  f.store.status.value = {text: '导出完成。', error: false};
  assert.equal(f.$('feedback'), null);
  f.store.status.value = {text: '失败', error: true};
  assert.equal(f.$('status').textContent, '失败');
  assert.equal(f.$('status').dataset.error, 'true');
  f.store.status.value = {text: '', error: false};
  f.store.downloads.value = ['已保存整场 1'];
  assert.equal(f.$$('#downloads p').length, 1);
  f.store.downloads.value = [];
  f.store.busy.value = true;
  f.store.progress.value = 42;
  assert.equal(f.root.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '42');
  f.store.progress.value = NaN;
  const meter = f.root.querySelector('[role=progressbar]');
  assert.equal(meter.hasAttribute('aria-valuenow'), false);
  assert.ok(meter.classList.contains('is-indeterminate'));
  f.store.progress.value = null;
  assert.equal(f.root.querySelector('[role=progressbar]'), null);
});

test('offline page shows the reason and offers history and recheck', () => {
  const f = mount({state: {page: 'offline', offline: {title: '当前没有直播', reason: '可以看看历史回放。'}}});
  assert.equal(f.$('offline').hidden, false);
  assert.match(f.$('offline').textContent, /当前没有直播.*可以看看历史回放。/);
  const [history, recheck] = f.$$('#offline button');
  assert.equal(history.textContent.trim(), '浏览历史场次');
  assert.equal(recheck.textContent.trim(), '重新检查');
  history.click();
  recheck.click();
  assert.deepEqual(
    f.calls.map(call => call[0]),
    ['library', 'retryCurrent'],
  );
});

test('the header follows the page and the version link renders from its state', () => {
  const f = mount({state: editing()});
  assert.equal(f.$('recordTitle').textContent, '直播');
  f.store.recordMeta.value = '成员 · 今天';
  assert.equal(f.root.querySelector('.head-meta').textContent, '成员 · 今天');
  f.store.version.value = {
    label: 'v1',
    update: false,
    href: null,
    title: '点击检查更新',
    description: 'd',
    busy: false,
  };
  assert.equal(f.$('version').getAttribute('role'), 'button');
  assert.equal(f.$('version').hasAttribute('href'), false);
  f.store.version.value = {...f.store.version.value, update: true, href: 'https://example.com/a.user.js'};
  assert.equal(f.$('version').getAttribute('href'), 'https://example.com/a.user.js');
  assert.equal(f.$('version').hasAttribute('role'), false);
  f.store.page.value = 'library';
  assert.equal(f.$('recordTitle'), null);
  assert.equal(f.root.querySelector('[aria-label="返回场次列表"]'), null);
});

test('settings sheet is hidden until opened; preview-only controls and the login gate follow the build and identity', () => {
  const pub = mount();
  assert.equal(pub.root.querySelector('.sheet-layer').hidden, true);
  assert.equal(pub.$('studioLogin'), null);
  assert.equal(pub.$('editorSide'), null);
  assert.ok(pub.$('shortcut'));
  assert.equal(pub.$('markShortcut'), null);
  pub.root.querySelector('[aria-label="设置"]').click();
  assert.equal(pub.root.querySelector('.sheet-layer').hidden, false);
  assert.equal(pub.root.querySelector('#panel')?.hasAttribute('data-logged-out') ?? false, false);

  const preview = mount({preview: true});
  assert.equal(preview.$('studioLogin').hidden, true);
  assert.ok(preview.$('markShortcut'));
  // Internal-only panels are injected by application.js, so the public build never bundles them.
  assert.equal(preview.$('editorSide'), null);
  const none = () => null;
  preview.store.extras.value = {ui: {MarkPins: none, MarksPanel: none, MiniMarks: none, ComposeSheet: none}};
  assert.ok(preview.$('editorSide'));
  preview.store.identity.value = null;
  assert.equal(preview.$('studioLogin').hidden, false);
  assert.ok(preview.$('panel').hasAttribute('data-logged-out'));
  assert.equal(preview.$('version'), null);
  assert.equal(preview.$('studioLogin').querySelector('a').getAttribute('href'), 'https://studio.example/plugin/link');
});

test('launcher toggles through its action and the panel visibility follows store.open', () => {
  const f = mount();
  assert.equal(f.$('panel').hidden, true);
  f.$('openPanel').click();
  assert.equal(f.calls.at(-1)[0], 'launch');
  f.store.open.value = true;
  assert.equal(f.$('panel').hidden, false);
  f.$('close').click();
  assert.equal(f.calls.at(-1)[0], 'close');
});

test('feedback sits beside settings only when logs are configured, and sends the chosen kind', async () => {
  assert.equal(mount().root.querySelector('[aria-label="反馈"]'), null, 'builds without a log endpoint hide it');
  const results = ['failed', 'rate_limited', 'sent'];
  const f = mount({feedback: true, overrides: {sendFeedback: async () => results.shift()}});
  const button = f.root.querySelector('button[aria-label="反馈"]');
  assert.equal(button.nextElementSibling.getAttribute('aria-label'), '设置');
  const sheet = f.root.querySelector('form.sheet').parentElement;
  assert.equal(sheet.hidden, true);
  button.click();
  assert.equal(sheet.hidden, false);
  const submit = sheet.querySelector('button[type="submit"]'),
    text = f.$('feedbackText');
  const kinds = [...sheet.querySelectorAll('[aria-label="反馈类型"] button')];
  assert.deepEqual(
    kinds.map(item => [item.textContent, item.getAttribute('aria-pressed')]),
    [
      ['问题反馈', 'true'],
      ['功能建议', 'false'],
    ],
  );
  assert.equal(submit.disabled, true, 'empty text cannot be sent');
  text.value = '   ';
  text.dispatchEvent(new window.Event('input', {bubbles: true}));
  assert.equal(submit.disabled, true, 'whitespace only cannot be sent');
  kinds[1].click();
  assert.equal(kinds[1].getAttribute('aria-pressed'), 'true');
  assert.match(submit.textContent, /发送功能建议/);
  text.value = '想要批量导出';
  text.dispatchEvent(new window.Event('input', {bubbles: true}));
  const settle = () => new Promise(resolve => setTimeout(resolve));
  submit.click();
  await settle();
  assert.deepEqual(f.calls.at(-1), ['sendFeedback', 'suggestion', '想要批量导出']);
  assert.match(sheet.querySelector('[role="alert"]').textContent, /没有发送成功/);
  assert.equal(text.value, '想要批量导出', 'a failed send keeps the draft');
  submit.click();
  await settle();
  assert.match(sheet.querySelector('[role="alert"]').textContent, /太频繁/);
  text.dispatchEvent(new window.Event('input', {bubbles: true}));
  assert.equal(sheet.querySelector('[role="alert"]'), null, 'editing clears a stale error');
  submit.click();
  await settle();
  assert.equal(sheet.hidden, true);
  assert.equal(text.value, '');
  assert.match(f.root.querySelector('.toast').textContent, /功能建议已发送/);
});
