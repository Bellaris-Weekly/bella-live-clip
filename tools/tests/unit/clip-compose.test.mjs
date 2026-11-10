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
            contents: `export async function exportSelection(api, record, groups, selection, options) {
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
          build.onLoad({filter: /src\/media\/thumbnails.js$/}, () => ({
            contents: `export async function readThumbnail(request, sample, signal, options) {
      window.frames.push({sample, options});
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080; return canvas;
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
    id: 1,
    kind: 'shared',
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
    kind: 'own',
    name: '自定义',
    payload: {title: '自选标题', desc: '自选 {clipper}', tid: 9, tags: ['自选模板']},
  },
];
function fixture(defaults = {account_mid: 7}, items = templates, matched = true) {
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
    frames: [],
    destinations: [],
    exportWait: gate.promise,
  });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ({drawImage() {}, strokeRect() {}, strokeText() {}, fillText() {}});
  w.HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob(['jpeg'], {type: 'image/jpeg'}));
  w.eval(code);
  w.fixture.show(root, null);
  const calls = [],
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
  const api = w.fixture.createComposer({
    root,
    client: {
      request: async (path, options = {}) => {
        calls.push([path, options]);
        if (path === '/clip-defaults') return defaults;
        if (path === '/templates') return items;
        if (path === '/me') return {name: '成员', lines: {bda2: 'upos-test.bilivideo.com'}};
        if (path === '/upload-options') return {cos_enabled: true, max_file_bytes: 100};
        if (path === '/uploads')
          return {id: 'u', url: 'https://upos-test.bilivideo.com/file', auth: 'auth', biz_id: 42, chunk_size: 4};
        if (path === '/covers') return {id: 'cover-id'};
        if (path === '/submissions') return {id: 's', bvid: 'BV1234567890', status: 'submitted'};
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
    mediaRequest: async () => {},
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
      isSubmission: () => false,
      whole: () => false,
      snapshot: () => ({
        record: {title: '直播标题', room: 7, start: 100000},
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
    files,
    removed,
    select: value => {
      selection = value;
    },
  };
}

test('composer exports to OPFS while form is open, captures midpoint at native size, persists while hidden, then submits and cleans', async t => {
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
  assert.equal(f.w.frames[0].sample.local, 5);
  assert.equal(f.w.frames[0].options.nativeSize, true);
  assert.match(f.field('mark').textContent, /备注/);
  assert.equal(f.field('template').value, 'shared:1');
  assert.equal(f.field('desc').value, '{live} 视频二创组——{clipper}');
  assert.match(f.field('desc-preview').textContent, /1970\.1\.2 {2}排期标题.*成员/);
  assert.equal(f.field('live').options.length, 7);
  f.field('title').value = '投稿标题';
  f.field('tags').value = '自选';
  f.api.actions.close();
  assert.equal(f.root.querySelector('form').hidden, true);
  f.api.actions.start();
  assert.equal(f.root.querySelector('form').hidden, false);
  assert.equal(f.field('title').value, '投稿标题');
  f.field('confirm').click();
  await until(() => f.field('confirm').textContent.includes('等待上传'));
  assert.equal(f.calls.filter(([path]) => path === '/submissions').length, 0);
  f.gate.resolve();
  await until(() => f.field('state').textContent === '投稿完成');
  const submitted = f.calls.find(([path]) => path === '/submissions')[1].body;
  assert.equal(submitted.mark_id, 'mark');
  assert.equal(submitted.cover_id, 'cover-id');
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

test('selecting another mark cancels old export, updates linkage and selection, and keeps editable text', async t => {
  const f = fixture();
  t.after(() => {
    f.api.dispose();
    f.dom.window.close();
  });
  f.api.markSelected({id: 'one', at: 100000000, note: '第一条'});
  f.api.actions.start();
  await until(() => f.w.exports.length === 1 && !f.field('confirm').disabled);
  f.field('title').value = '保留标题';
  f.select({start: 10, end: 15});
  f.api.markSelected({id: 'two', at: 100001000, note: '第二条'});
  await until(() => f.w.exports.length === 2 && !f.field('confirm').disabled);
  assert.equal(f.removed.length, 1);
  assert.equal(f.w.exports[1].selection.start, 10);
  assert.match(f.field('mark').textContent, /第二条/);
  assert.equal(f.field('title').value, '保留标题');
  f.field('mark').querySelector('button').click();
  assert.equal(f.field('mark'), null);
  f.field('cancel').click();
  await until(() => f.files.size === 0);
  assert.equal(f.calls.filter(([path]) => path === '/submissions').length, 0);
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
  f.field('template').value = 'own:1';
  f.field('template').dispatchEvent(new f.w.Event('change'));
  assert.equal(f.field('title').value, '自选标题');
  assert.equal(f.field('tid').value, '9');
  assert.equal(f.field('tags').value, '自选模板');
  assert.equal(f.field('desc-preview').textContent, '自选 自选署名 $&');
  f.field('template').value = 'shared:1';
  f.field('template').dispatchEvent(new f.w.Event('change'));
  f.field('live').value = 'custom';
  f.field('live').dispatchEvent(new f.w.Event('change'));
  assert.equal(f.field('live-custom-label').hidden, false);
  f.field('live-custom').value = '手动完整直播信息';
  f.field('live-custom').dispatchEvent(new f.w.Event('input', {bubbles: true}));
  assert.equal(f.field('desc-preview').textContent, '手动完整直播信息 视频二创组——自选署名 $&');
  f.field('confirm').click();
  await until(() => f.field('confirm').textContent.includes('等待上传'));
  f.gate.resolve();
  await until(() => f.field('state').textContent === '投稿完成');
  const body = f.calls.find(([path]) => path === '/submissions')[1].body;
  assert.equal(body.title, '手动完整直播信息 切片');
  assert.equal(body.desc, '手动完整直播信息 视频二创组——自选署名 $&');
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
  f.field('title').value = '标题';
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('有效分区'));
  f.field('tid').value = '27';
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('标签'));
  f.field('tags').value = '标签';
  f.field('desc').value = '{clipper}';
  f.field('clipper').value = '';
  f.field('confirm').click();
  await until(() => f.field('error')?.textContent.includes('占位符'));
  assert.ok(!f.calls.some(([path]) => path === '/covers' || path === '/submissions'));
});
