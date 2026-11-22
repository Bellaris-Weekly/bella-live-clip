import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {deferred} from '../../../src/shared/deferred.js';

const code = (
  await build({
    // The composer drives the real sheet: it builds its form into hosts the sheet renders.
    stdin: {
      contents: `import {h, render, options} from 'preact';
        import {ComposeSheet} from './src/ui/compose.jsx';
        export {createComposer} from './src/preview/compose.js';
        export {createTemplateForm} from './src/preview/template-form.js';
        options.debounceRendering = callback => callback();
        export const show = (root, composer) => render(h(ComposeSheet, {composer}), root);`,
      resolveDir: process.cwd(),
    },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'fixture',
    define: {__PREVIEW__: 'true'},
    plugins: [
      {
        name: 'media-fixture',
        setup(build) {
          build.onLoad({filter: /src\/media\/export.js$/}, () => ({
            contents: `export async function readExportDimensions() { return {fileWidth: 2560, fileHeight: 1440}; }
    export async function exportSelection(api, record, groups, selection, options) {
      window.exports.push({record, selection, precise: options.precise, danmaku: options.danmaku});
      const destination = await options.createFile();
      window.destinations.push(destination);
      options.onProgress({progress: 0.5});
      await Promise.race([window.exportWait, new Promise((_, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
      })]);
      options.signal.throwIfAborted();
      options.onProgress({progress: 1});
    }`,
          }));
        },
      },
    ],
  })
).outputFiles[0].text;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.ok(predicate(), 'expected UI state');
}
const templates = [
  {
    id: 2,
    name: '贝拉单播',
    payload: {
      liveParticipants: ['bella'],
      title: '{live} 切片',
      tid: 8,
      tags: ['模板标签'],
      desc: '{live} 视频二创组——{clipper}',
      copyright: 2,
      source: '直播间',
      human_type2: 100,
    },
  },
  {
    id: 1,
    name: '自定义',
    payload: {title: '自选标题', desc: '自选 {clipper}', tid: 9, tags: ['自选模板']},
  },
];
// Types into a field as a user would, so template-bound fields see the edit.
function type(element, value) {
  element.value = value;
  element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', {bubbles: true}));
}
function fixture(defaults = {account_mid: 7}, items = templates, matched = true, submissions = [], settings = {}) {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com',
    pretendToBeVisual: true,
  });
  const w = dom.window,
    gate = deferred(),
    root = w.document.getElementById('host').attachShadow({mode: 'open'});
  Object.assign(w, {
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    File,
    FormData,
    structuredClone,
    exports: [],
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    destinations: [],
    exportWait: gate.promise,
  });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const urls = {made: [], revoked: [], paused: 0};
  w.URL.createObjectURL = file => {
    urls.made.push(file.name);
    return `blob:${file.name}`;
  };
  w.URL.revokeObjectURL = url => urls.revoked.push(url);
  w.HTMLMediaElement.prototype.pause = () => urls.paused++;
  // Any 2D call works; pixels read back as mid-grey so frames never count as black.
  const context = new Proxy(
    {
      measureText: text => ({width: text.length * 10}),
      getImageData: (x, y, width, height) => ({data: new Uint8ClampedArray(width * height * 4).fill(128)}),
    },
    {get: (target, key) => target[key] ?? (() => {}), set: () => true},
  );
  w.HTMLCanvasElement.prototype.getContext = () => context;
  w.HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob(['jpeg'], {type: 'image/jpeg'}));
  w.eval(code);
  w.fixture.show(root, null);
  const preferences = new Map();
  const calls = [],
    captured = [],
    removed = [],
    files = new Map();
  const directory = {
    entries: async function* () {},
    removeEntry: async name => {
      removed.push(name);
      files.delete(name);
    },
    getFileHandle: async name => {
      const handle = {name, getFile: async () => new File(['video'], name)};
      files.set(name, handle);
      return handle;
    },
  };
  let selection = {start: 2, end: 8};
  const logs = [];
  const api = w.fixture.createComposer({
    root,
    get: (key, fallback) => preferences.get(key) ?? fallback,
    set: (key, value) => {
      if (settings.storageFails) throw new Error('storage unavailable');
      preferences.set(key, structuredClone(value));
    },
    pageUrl: () => 'https://live.bilibili.com/7',
    diagnostics: {
      begin: (action, details) => {
        logs.push(['begin', action, details.mode]);
        return {
          stage: value => logs.push(['stage', value]),
          progress() {},
          observe() {},
          note: value => logs.push(['note', value]),
          finish: result => logs.push(['finish', result?.status ?? 'completed']),
          fail: error => logs.push(['fail', error.message]),
        };
      },
      event: (action, details, message) => logs.push(['event', action, details.facts, message]),
    },
    client: {
      request: async (path, options = {}) => {
        calls.push([path, options]);
        if (path === '/clip-defaults') return defaults;
        if (path === '/templates') return items;
        if (path === '/me') return {name: '成员', lines: {bda2: 'upos-test.bilivideo.com'}};
        if (path === '/upload-options') return {cos_enabled: true, max_file_bytes: 100};
        if (path === '/uploads')
          return {id: 'u', url: 'https://upos-test.bilivideo.com/file', auth: 'auth', biz_id: 42, chunk_size: 4};
        if (path.endsWith('/append')) return settings.appendResult || {bvid: 'BV1KRxx6QEkN', part: 2, parts: 3};
        if (path === '/covers') return {id: `cover-${calls.filter(([p]) => p === '/covers').length}`};
        if (path === '/submissions')
          return options.method ? settings.result || {id: 's', bvid: 'BV1234567890', status: 'submitted'} : submissions;
      },
    },
    gmRequest: options => {
      queueMicrotask(() =>
        options.onload({
          status: 200,
          responseText: options.url.includes('?uploads') ? '{"upload_id":"r"}' : '{"OK":1}',
        }),
      );
      return {abort() {}};
    },
    mediaApi: {
      request: async () => ({
        url: 'https://media.test/list.m3u8',
        data: '#EXTM3U\n#EXTINF:10,\nseg.m4s\n#EXT-X-ENDLIST',
      }),
    },
    storage: {getDirectory: async () => directory},
    schedules: {
      calendar: async month => {
        if (month === '1970-01')
          return matched
            ? [{uid: 'record', room: 7, title: '排期标题', start: 100000, participants: [{id: 'bella'}]}]
            : [];
        if (month === new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7))
          return Array.from({length: 5}, (_, i) => ({
            uid: `recent-${i}`,
            room: 7,
            title: `近期场次${i}`,
            start: Date.now() / 1000 - (i + 1) * 86400,
            participants: [{id: 'bella'}, {id: 'diana'}],
          }));
        throw new Error('no calendar');
      },
    },
    session: {
      ready: () => true,
      pause() {},
      captureFrame: async clip => {
        captured.push(clip);
        const image = w.document.createElement('canvas');
        image.width = 1920;
        image.height = 1080;
        return {image, time: clip.start, key: 'record'};
      },
      isSubmission: () => false,
      related: async record => [record, ...(settings.earlier || [])],
      whole: () => false,
      snapshot: () => ({
        record: {key: 'record', title: '直播标题', room: 7, start: 100000},
        selection: {...selection},
        mode: 'danmaku',
        streams: [{start_time: 100000, end_time: 100020, stream: 'https://media.test/list.m3u8'}],
        segmentIndex: 0,
      }),
    },
  });
  w.fixture.show(root, api);
  const field = key => root.querySelector(`[data-${key}]`);
  return {
    dom,
    w,
    root,
    gate,
    api,
    field,
    calls,
    logs,
    captured,
    preferences,
    urls,
    files,
    removed,
    select: value => {
      selection = value;
    },
  };
}

test('composer exports to OPFS while form is open, takes a cover frame inside the clip, persists while hidden, then submits both covers and cleans', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.dom.window.close();
  });
  f.api.markSelected({id: 'mark', at: 100000000, note: '备注'});
  f.api.actions.start();
  await until(() => f.w.exports.length === 1 && !f.field('confirm').disabled);
  assert.equal(f.w.exports[0].precise, true);
  assert.equal(f.w.exports[0].danmaku.adjustment, 0);
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.captured, [{start: 2, end: 8}]);
  await until(() => f.root.querySelector('[data-cover-source]').textContent.includes('00:00:02.000'));
  assert.match(f.field('mark').textContent, /备注/);
  assert.equal(f.field('template').value, '2');
  // The description shows its variables resolved, as in the studio.
  assert.match(f.field('desc').value, /1970\.1\.2 {2}排期标题.*成员/);
  assert.equal(f.field('live').options.length, 7);
  type(f.field('title'), '投稿标题');
  f.root.querySelector('[aria-label="删除标签 模板标签"]').click();
  f.root.querySelector('[aria-label="添加标签"]').click();
  type(f.field('tags'), '自选');
  f.api.actions.close();
  assert.equal(f.root.querySelector('form').hidden, true);
  f.api.actions.start();
  assert.equal(f.root.querySelector('form').hidden, false);
  assert.equal(f.field('title').value, '投稿标题');
  f.field('confirm').click();
  await until(() => f.field('confirm').textContent.includes('等待上传'));
  assert.equal(f.calls.filter(([path, options]) => path === '/submissions' && options.method).length, 0);
  f.gate.resolve();
  await until(() => f.field('state').textContent === '投稿完成');
  assert.ok(f.logs.some(([kind, value]) => kind === 'note' && value.fileWidth === 2560 && value.fileHeight === 1440));
  const submitted = f.calls.find(([path, options]) => path === '/submissions' && options.method)[1].body;
  assert.equal(submitted.mark_id, 'mark');
  assert.equal(submitted.cover_id, 'cover-1');
  assert.equal(submitted.cover43_id, 'cover-2');
  assert.deepEqual([...submitted.tags], ['自选']);
  assert.equal(submitted.tid, 8);
  assert.equal(submitted.copyright, 2);
  assert.equal(submitted.no_reprint, false);
  assert.equal(submitted.source, '直播间');
  assert.equal(submitted.human_type2, 100);
  assert.equal(submitted.desc, '1970.1.2  排期标题 视频二创组——成员');
  assert.ok(!f.calls.some(([path]) => path.includes('/seasons/')));
  assert.equal(f.field('cancel'), null);
  assert.match(f.field('result').textContent, /BV1234567890/);
  assert.equal(f.files.size, 0);
  assert.equal(f.removed.length, 1);
});

test('a changed clip is offered on return: exporting it cancels the old export, relinks the mark and keeps the text', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.dom.window.close();
  });
  f.api.markSelected({id: 'one', at: 100000000, note: '第一条'});
  f.api.actions.start();
  await until(() => f.w.exports.length === 1 && !f.field('confirm').disabled);
  type(f.field('title'), '保留标题');
  f.api.actions.close();
  f.select({start: 10, end: 15});
  f.api.markSelected({id: 'two', at: 100001000, note: '第二条'});
  f.api.actions.start();
  assert.match(f.field('stale').textContent, /00:10–00:15/);
  assert.equal(f.w.exports.length, 1, 'nothing restarts by itself');
  f.field('restart').click();
  await until(() => f.w.exports.length === 2 && !f.field('confirm').disabled);
  assert.equal(f.field('stale'), null);
  assert.equal(f.removed.length, 1);
  assert.equal(f.w.exports[1].selection.start, 10);
  assert.match(f.field('mark').textContent, /第二条/);
  assert.equal(f.field('title').value, '保留标题');
  f.field('mark').querySelector('button').click();
  assert.equal(f.field('mark'), null);
  f.field('cancel').click();
  await until(() => f.files.size === 0);
  assert.equal(f.calls.filter(([path, options]) => path === '/submissions' && options.method).length, 0);
});

test('the exported clip plays on the page until it is cleaned up, and stops when the page is left', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.dom.window.close();
  });
  f.api.actions.start();
  await until(() => f.field('preview-waiting'));
  f.gate.resolve();
  await until(() => f.field('preview'));
  const url = f.field('preview').getAttribute('src');
  assert.match(url, /^blob:/);
  f.api.actions.close();
  assert.equal(f.urls.paused, 1);
  f.api.actions.start();
  f.field('cancel').click();
  await until(() => f.field('preview') === null && f.files.size === 0);
  assert.deepEqual(f.urls.revoked, [url]);
});

test('missing studio configuration prevents export and upload and explains the required admin setting', async t => {
  const f = fixture({account_mid: null, tid: null});
  t.after(() => {
    f.api.dispose();
    f.dom.window.close();
  });
  f.api.actions.start();
  await until(() => f.field('error')?.textContent.includes('创作台尚未配置投稿账号，请联系管理员'));
  assert.equal(f.w.exports.length, 0);
  assert.equal(f.files.size, 0);
  assert.equal(f.calls.filter(([path]) => path === '/uploads').length, 0);
  assert.ok(f.field('retry'));
  f.field('cancel').click();
  await tick();
});

test('template switching and free-text live/clipper edits affect only this submission', async t => {
  const original = structuredClone(templates);
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  f.field('clipper').value = '自选署名 $&';
  f.field('clipper').dispatchEvent(new f.w.Event('input', {bubbles: true}));
  f.field('template').value = '1';
  f.field('template').dispatchEvent(new f.w.Event('change'));
  assert.equal(f.field('title').value, '自选标题');
  assert.equal(f.field('tid').value, '9');
  assert.match(f.root.querySelector('[data-tag-list]').textContent, /自选模板/);
  assert.equal(f.field('desc').value, '自选 自选署名 $&');
  // Only the inputs the template's variables need are shown, as in the studio.
  assert.equal(f.field('live-label').hidden, true);
  assert.equal(f.field('clipper-label').hidden, false);
  f.field('template').value = '2';
  f.field('template').dispatchEvent(new f.w.Event('change'));
  f.field('live').value = 'custom';
  f.field('live').dispatchEvent(new f.w.Event('change'));
  assert.equal(f.field('live-label').hidden, false);
  assert.equal(f.field('live-custom-label').hidden, false);
  // The date starts at the recording's day (UTC+8); the title is typed.
  assert.equal(f.field('live-date').value, '1970-01-02');
  f.field('live-title').value = '手动直播';
  f.field('live-title').dispatchEvent(new f.w.Event('input', {bubbles: true}));
  assert.equal(f.field('desc').value, '1970.1.2  手动直播 视频二创组——自选署名 $&');
  f.field('confirm').click();
  await until(() => f.field('confirm').textContent.includes('等待上传'));
  f.gate.resolve();
  await until(() => f.field('state').textContent === '投稿完成');
  const body = f.calls.find(([path, options]) => path === '/submissions' && options.method)[1].body;
  assert.equal(body.title, '1970.1.2  手动直播 切片');
  assert.equal(body.desc, '1970.1.2  手动直播 视频二创组——自选署名 $&');
  assert.deepEqual(templates, original);
  assert.ok(f.calls.filter(([path]) => path === '/templates').every(([, options]) => !options.method));
  f.api.actions.start();
  await until(() => f.field('clipper').value === '成员');
});

test('no matching event leaves template unselected, defaults live to newest, and validates missing fields', async t => {
  const f = fixture({account_mid: 7}, templates, false);
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  assert.equal(f.field('template').value, '');
  assert.equal(f.field('live').value, '0');
  assert.match(f.field('live').selectedOptions[0].textContent, /近期场次0/);
  assert.equal(f.field('live').options.length, 6);
  type(f.field('title'), '标题');
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('有效分区'));
  f.field('tid').value = '27';
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('标签'));
  f.field('tags').value = '标签';
  type(f.field('desc'), '{clipper}');
  f.field('clipper').value = '';
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('占位符'));
  assert.ok(!f.calls.some(([path, options]) => path === '/covers' || (path === '/submissions' && options.method)));
});

const collection = {
  id: 5,
  name: '歌舞合集',
  payload: {
    title: '【A-SOUL】{live_title} 歌舞合集丨『』',
    desc: '{live}',
    tid: 27,
    tags: ['歌舞'],
    includeAntiCollision: true,
    liveParticipants: ['bella'],
  },
};
const sent = (title, extra = {}) => ({
  id: 'old-submission',
  status: 'submitted',
  bvid: 'BV1KRxx6QEkN',
  account_mid: 7,
  created_at: 100100,
  title,
  details: {origin: {template_name: '歌舞合集'}},
  ...extra,
});

test('the new scheduled collection wins over yesterday’s published collection without a BV', async t => {
  const pending = sent('新定时合集『第一首』', {
    id: 'new-scheduled',
    bvid: null,
    status: 'scheduled',
    created_at: 300000,
    submit_at: 1900000000,
    details: {origin: {template_name: '歌舞合集', live: '1970.1.2  排期标题'}},
  });
  const f = fixture(
    {account_mid: 7},
    [collection],
    true,
    [sent('昨天合集『旧歌』', {created_at: 200000, details: pending.details}), pending],
    {
      appendResult: {id: pending.id, status: 'scheduled', submit_at: pending.submit_at, part: 2, parts: 3},
    },
  );
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  assert.equal(f.field('target').value, '0');
  assert.match(f.field('target').selectedOptions[0].textContent, /新定时合集.*待定时/);
  f.field('song').value = '小美满';
  f.field('confirm').click();
  f.gate.resolve();
  await until(() => f.api.view.value.done);
  const writes = f.calls.filter(([path]) => path.endsWith('/append'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], '/submissions/new-scheduled/append');
  assert.match(f.field('state').textContent, /已加入待定时稿第 2 P/);
  assert.ok(!f.calls.some(([path]) => path.includes('/archives/')));
});

test('refresh keeps the selected draft by record ID and a missing target requires a new choice', t => {
  const f = fixture();
  const host = f.w.document.createElement('div');
  const form = f.w.fixture.createTemplateForm(host);
  t.after(() => {
    form.dispose();
    f.api.dispose();
    f.w.close();
  });
  const event = {start: 100000, title: '排期标题', participants: [{id: 'bella'}]};
  const schedule = {matched: event, recent: [event]};
  const first = {
    id: 'first',
    bvid: null,
    status: 'scheduled',
    owned: true,
    mid: 7,
    title: '第一份『歌』',
    template: '歌舞合集',
  };
  const second = {...first, id: 'second', title: '第二份『歌』'};
  form.configure([collection], schedule, '成员', false, {existing: [first, second], song: '新歌'});
  const target = host.querySelector('[data-target]');
  target.value = '1';
  target.dispatchEvent(new f.w.Event('change'));
  assert.equal(form.fields().append.submissionId, 'second');
  form.configure([collection], schedule, '成员', true, {existing: [second, first]});
  assert.equal(target.value, '0');
  assert.equal(form.fields().append.submissionId, 'second');
  form.configure([collection], schedule, '成员', true, {existing: [first]});
  assert.equal(target.value, '');
  assert.throws(() => form.fields(), /明确选择投稿目标/);
});

test('after a restart, the collection made during the earlier recording is still offered', async t => {
  const earlier = [{key: 'earlier', title: '直播标题', room: 7, start: 99000, end: 99900}];
  const f = fixture({account_mid: 7}, [collection], true, [sent('合集『第一首』', {created_at: 99500})], {earlier});
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  assert.equal(f.field('target-label').hidden, false);
  assert.match(f.field('target').textContent, /第一首/);
});

test('a cancelled or processing newest collection never silently selects the old archive', async t => {
  for (const status of ['cancelled', 'submitting', 'failed']) {
    const f = fixture({account_mid: 7}, [collection], true, [
      sent('最新合集『新歌』', {id: 'new', bvid: null, status, created_at: 100200}),
      sent('旧合集『旧歌』'),
    ]);
    t.after(() => {
      f.api.dispose();
      f.w.close();
    });
    f.api.actions.start();
    await until(() => !f.field('confirm').disabled);
    assert.equal(f.field('target').value, '');
    f.field('song').value = '小美满';
    f.field('confirm').click();
    await until(() => f.field('error').textContent.includes('明确选择投稿目标'));
    f.field('target').value = '0';
    f.field('target').dispatchEvent(new f.w.Event('change'));
    f.field('confirm').click();
    await until(() => f.field('error').textContent.includes('已取消或暂不可追加'));
    assert.ok(!f.calls.some(([path]) => path.endsWith('/append')));
  }
});

test('the first song starts a collection: its name fills 『』, it titles the part, and the bumper follows', async t => {
  const f = fixture({account_mid: 7}, [collection], true, [sent('旧合集『X』', {created_at: 99000})]);
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  f.field('template').value = '5';
  f.field('template').dispatchEvent(new f.w.Event('change'));
  // An earlier live's collection is not offered.
  assert.equal(f.field('target-label').hidden, true);
  assert.equal(f.field('song-label').hidden, false);
  f.field('song').value = '青春纪念册';
  f.field('confirm').click();
  await until(() => f.field('confirm').textContent.includes('等待上传'));
  f.gate.resolve();
  await until(() => f.field('state').textContent === '投稿完成');
  const body = f.calls.find(([path, options]) => path === '/submissions' && options.method)[1].body;
  assert.equal(body.title, '【A-SOUL】排期标题 歌舞合集丨『青春纪念册』');
  assert.deepEqual(JSON.parse(JSON.stringify(body.parts)), [
    {upload_id: 'u', title: '青春纪念册'},
    {preset_id: 'anti-collision', title: '✩‧₊˚✧'},
  ]);
  assert.equal(body.origin.template_name, '歌舞合集');
});

const root = f => f.root;
const group = {id: 6, name: '团播', payload: {title: '', tid: 27, tags: ['团播'], liveParticipants: ['bella']}};

test('later songs of the live go into its collection without covers or archive fields', async t => {
  const f = fixture({account_mid: 7}, [group, collection], true, [sent('【A-SOUL】排期标题 歌舞合集丨『青春纪念册』')]);
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  // The collection's template wins over another template for the same members, whose title is empty.
  assert.equal(f.field('template').value, '5');
  assert.equal(f.field('target').value, '');
  assert.equal(f.field('archive').hidden, false);
  // Switching to an empty-titled template and back to appending must not leave a blocking required field.
  f.field('template').value = '6';
  f.field('template').dispatchEvent(new f.w.Event('change'));
  f.field('target').value = '0';
  f.field('target').dispatchEvent(new f.w.Event('change'));
  assert.equal(f.field('title').disabled, true);
  assert.equal(root(f).querySelector('form').checkValidity(), true);
  f.field('confirm').click();
  await until(() => f.field('error').textContent.includes('歌名'));
  f.field('song').value = '朋友的酒';
  f.field('confirm').click();
  await until(() => f.field('confirm').textContent.includes('等待上传'));
  f.gate.resolve();
  await until(() => f.field('state').textContent === '已追加为第 2 P');
  const [path, options] = f.calls.find(([path]) => path.endsWith('/append'));
  assert.equal(path, '/accounts/7/archives/BV1KRxx6QEkN/append');
  assert.equal(options.body.title, '朋友的酒');
  assert.equal(options.body.upload_id, 'u');
  assert.ok(!f.calls.some(([path, options]) => path === '/covers' || (path === '/submissions' && options.method)));
  assert.equal(f.field('target-label').hidden, false);
  // The whole submission is in the log: mode, steps, what was confirmed, the result.
  const logs = JSON.parse(JSON.stringify(f.logs));
  assert.deepEqual(logs[0], ['begin', 'clip_submit', 'danmaku']);
  const stages = logs.filter(([kind]) => kind === 'stage').map(([, value]) => value);
  for (const step of ['config', 'exporting', 'line', 'uploading', 'uploaded', 'confirmed', 'sent'])
    assert.ok(stages.includes(step), step);
  const confirm = logs.find(([kind, action]) => kind === 'event' && action === 'clip_confirm');
  assert.equal(confirm[2].target, 'append');
  assert.equal(confirm[2].targetBvid, 'BV1KRxx6QEkN');
  assert.ok(logs.some(([, action, , message]) => action === 'clip_confirm_rejected' && /歌名/.test(message)));
  assert.ok(logs.some(([kind, value]) => kind === 'note' && value.part === 2));
  assert.deepEqual(logs.at(-1), ['finish', 'completed']);
});

test('inline tags keep focus, ignore IME confirmation, deduplicate pasted tags and cap at twelve', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  const add = f.root.querySelector('[aria-label="添加标签"]');
  add.click();
  const input = f.field('tags');
  type(input, '中文');
  const key = (key, options = {}) =>
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...options}));
  key('Enter', {isComposing: true});
  assert.equal(f.field('tag-count').textContent, '1/12');
  key('Enter');
  assert.equal(f.root.activeElement, input);
  assert.equal(input.hidden, false);
  assert.equal(input.value, '');
  assert.equal(f.field('tag-count').textContent, '2/12');
  type(input, '中文，甲 乙,丙');
  key(',');
  assert.equal(f.field('tag-count').textContent, '5/12');
  type(input, '未保存');
  key('Escape');
  assert.equal(f.root.activeElement, add);
  assert.equal(f.field('tag-count').textContent, '5/12');
  add.click();
  type(input, Array.from({length: 12}, (_, i) => `标签${i}`).join(','));
  key('Enter');
  assert.equal(f.field('tag-count').textContent, '12/12');
  assert.equal(add.disabled, true);
  f.root.querySelector('[aria-label="删除标签 中文"]').click();
  assert.equal(f.field('tag-count').textContent, '11/12');
  assert.equal(add.disabled, false);
  assert.equal(
    f.calls.some(([path]) => path === '/covers'),
    false,
    'editing tags never submits the form',
  );
});

test('bumper removal and custom part titles survive hiding and submitting without touching template data', async t => {
  const f = fixture({account_mid: 7}, [{...collection, payload: {...collection.payload, title: '切片 {live_title}'}}]);
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  assert.equal(f.field('bumper-row').hidden, false);
  assert.equal(f.field('add-bumper').hidden, true);
  assert.equal(f.field('part-count').textContent, '共 2P');
  f.field('part-title').focus();
  type(f.field('part-title'), '分P {clipper}');
  f.field('title').focus();
  type(f.field('title'), '更改稿件标题');
  assert.equal(f.field('part-title').value, '分P 成员');
  f.field('remove-bumper').click();
  f.api.actions.close();
  f.api.actions.start();
  assert.equal(f.field('bumper-row').hidden, true);
  assert.equal(f.field('part-count').textContent, '共 1P');
  assert.equal(
    f.calls.some(([path]) => path.includes('presets')),
    false,
    'bumper never uploads while configuring',
  );
  f.field('confirm').click();
  f.gate.resolve();
  await until(() => f.field('result'));
  const body = f.calls.find(([path, options]) => path === '/submissions' && options.method)[1].body;
  assert.deepEqual(JSON.parse(JSON.stringify(body.parts)), [{title: '分P 成员', upload_id: 'u'}]);
  assert.equal(collection.payload.includeAntiCollision, true);
});

test('manually adding a bumper sends its edited title as a deferred preset, and an empty title blocks confirmation', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  f.field('add-bumper').click();
  assert.equal(f.field('add-bumper').hidden, true);
  type(f.field('bumper-title'), '');
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('P2 标题'));
  assert.equal(
    f.calls.some(([path]) => path === '/covers'),
    false,
  );
  type(f.field('bumper-title'), '尾部防撞');
  f.field('confirm').click();
  f.gate.resolve();
  await until(() => f.field('result'));
  const body = f.calls.find(([path, options]) => path === '/submissions' && options.method)[1].body;
  assert.equal(body.parts.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(body.parts[1])), {preset_id: 'anti-collision', title: '尾部防撞'});
});

test('Beijing quick scheduling is visible outside advanced settings and finishes with continue and studio management', async t => {
  const now = Date.parse('2026-11-15T00:00:00Z'); // 08:00 in Beijing, regardless of host time zone.
  const result = {id: 's', status: 'scheduled', submit_at: now / 1000 + 600};
  const f = fixture({account_mid: 7}, templates, true, [], {result});
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.w.Date.now = () => now;
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  assert.equal(f.field('schedule-picker').closest('details'), null);
  f.root.querySelector('[data-preset="07:17"]').click();
  assert.equal(f.field('scheduleAt').value, '2026-11-16T07:17');
  assert.match(f.root.querySelector('.schedule-trigger').textContent, /明天 07:17/);
  f.field('schedule-clear').click();
  assert.equal(f.field('scheduleAt').value, '');
  f.root.querySelector('[data-preset="10 分钟"]').click();
  assert.equal(f.field('scheduleAt').value, '2026-11-15T08:10:00');
  f.field('confirm').click();
  f.gate.resolve();
  await until(() => f.field('continue'));
  assert.equal(f.field('confirm'), null);
  assert.match(f.field('state').textContent, /已安排在/);
  assert.match(f.field('scheduled-result').textContent, /投稿记录中查看或取消定时/);
  const body = f.calls.find(([path, options]) => path === '/submissions' && options.method)[1].body;
  assert.equal(body.submit_at, result.submit_at);
  assert.equal(body.dtime, null);
  assert.equal(
    f.calls.some(([path]) => path === '/submissions/s'),
    false,
    'does not poll for a BV before the scheduled time',
  );
  f.field('continue').click();
  assert.equal(f.root.querySelector('form').hidden, true);
});

test('custom scheduling validates the future window, supports calendar keys, and Escape leaves the saved time unchanged', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.w.Date.now = () => Date.parse('2026-11-15T00:00:00Z');
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  f.root.querySelector('[data-preset="11:30"]').click();
  const trigger = f.root.querySelector('.schedule-trigger');
  trigger.click();
  const popup = f.root.querySelector('.schedule-popover');
  assert.equal(popup.hidden, false);
  assert.equal(f.root.querySelector('[data-day="2026-11-14"]').disabled, true);
  f.root.querySelector('[data-day="2026-11-16"]').click();
  f.root.activeElement.dispatchEvent(
    new f.w.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true}),
  );
  assert.equal(f.root.activeElement.dataset.day, '2026-11-17');
  popup.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  assert.equal(popup.hidden, true);
  assert.equal(f.field('scheduleAt').value, '2026-11-15T11:30');
  trigger.click();
  const hour = f.root.querySelector('[aria-label="小时"]');
  type(hour, '07');
  assert.equal(f.field('schedule-apply').disabled, true);
  type(hour, '12');
  f.root.querySelector('[aria-label="分钟"]').focus();
  type(f.root.activeElement, '17');
  f.root.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  assert.equal(popup.hidden, true);
  assert.equal(f.field('scheduleAt').value, '2026-11-15T12:17');
  assert.equal(
    f.calls.some(([path]) => path === '/covers'),
    false,
    'clock confirmation never submits the archive',
  );
  trigger.click();
  f.field('schedule-cancel').click();
  assert.equal(f.field('scheduleAt').value, '');
});

test('cover presets save only style, prevent duplicates, persist, rename and delete while keeping this cover text', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  const find = label => f.root.querySelector(`[aria-label="${label}"]`);
  assert.equal(find('保存文字预设').disabled, true, 'built-in style is already a preset');
  f.api.cover.setText({value: '本次封面', color: '#123456', stroke: '#654321', strokeWidth: 0.2, size: 0.12});
  await until(() => !find('保存文字预设').disabled);
  find('保存文字预设').click();
  await until(() => find('预设名称'));
  type(find('预设名称'), '常用样式');
  find('预设名称').dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  await until(() => find('常用样式'));
  const stored = f.preferences.get('coverTextPresets.v1');
  assert.equal(stored.length, 1);
  assert.equal('value' in stored[0].style, false);
  assert.equal(stored[0].style.strokeWidth, 0.2);
  assert.equal(find('保存文字预设').disabled, true);
  find('贝拉应援色').click();
  assert.equal(f.api.cover.state.value.text.value, '本次封面');
  assert.equal(f.api.cover.state.value.text.color, '#DB7D74');
  find('常用样式').click();
  assert.equal(f.api.cover.state.value.text.color, '#123456');
  find('管理文字预设').click();
  await until(() => find('预设名称'));
  type(find('预设名称'), '新名字');
  find('预设名称').dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  await until(() => find('新名字'));
  find('管理文字预设').click();
  await until(() => find('删除文字预设'));
  find('删除文字预设').click();
  await until(() => !find('新名字'));
  assert.equal(f.preferences.get('coverTextPresets.v1').length, 0);
  assert.equal(f.api.cover.state.value.text.value, '本次封面');
  assert.equal(
    f.calls.some(([path]) => path === '/covers'),
    false,
  );
});

test('cover preset storage failure keeps the editor and unsaved style available', async t => {
  const f = fixture({account_mid: 7}, templates, true, [], {storageFails: true});
  t.after(() => {
    f.api.dispose();
    f.w.close();
  });
  f.api.actions.start();
  await until(() => !f.field('confirm').disabled);
  f.api.cover.setText({color: '#112233'});
  const find = label => f.root.querySelector(`[aria-label="${label}"]`);
  await until(() => !find('保存文字预设').disabled);
  find('保存文字预设').click();
  await until(() => find('预设名称'));
  type(find('预设名称'), '未保存');
  find('预设名称').dispatchEvent(new f.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  await until(() => f.root.querySelector('.cover-notice')?.textContent.includes('无法保存预设'));
  assert.ok(find('预设名称'));
  assert.equal(f.api.cover.presets.value.length, 1);
  assert.equal(f.api.cover.state.value.text.color, '#112233');
});
