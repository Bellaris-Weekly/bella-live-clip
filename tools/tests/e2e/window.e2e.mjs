import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

let browser, script;
before(async () => {
  const result = await build({
    stdin: {
      contents: `
        import {signal} from '@preact/signals';
        import {mountApp} from './src/ui/app.jsx';
        import {MiniMarks} from './src/ui/marks.jsx';
        import {createPanelWindow} from './src/app/panel-window.js';
        import {createStore} from './src/app/store.js';
        import {MEMBERS} from './src/domain/records.js';
        import css from './src/ui/theme.css';
        const host = document.body.appendChild(document.createElement('div'));
        const root = host.attachShadow({mode: 'open'});
        root.innerHTML = '<style>' + css + '</style>';
        const values = new Map(), writes = [];
        const store = createStore({member: MEMBERS[0], exportMode: 'copy'});
        store.identity.value = {name: '成员'};
        const marks = {
          state: {
            mini: signal(true), live: signal({member: '贝拉'}), capture: signal(null),
            items: signal([]), shortcut: signal('Alt+Shift+M'), editing: signal(null),
            error: signal(null), history: signal(null), margins: signal({before: 30, after: 15}),
          },
          actions: {
            hideMini: () => marks.state.mini.value = false,
            capture: () => window.captures++,
          },
        };
        const actions = {launch: () => {if (!panels.launcherDragged()) store.open.value = !store.open.value;}};
        mountApp(root, {store, actions, preview: true, members: MEMBERS, studioUrl: 'https://studio.example'});
        const panels = createPanelWindow({root, get: (k, fallback) => values.get(k) ?? fallback,
          set: (k, value) => {values.set(k, value); writes.push(k);}});
        window.captures = 0;
        const none = () => null;
        globalThis.windowRig = {store, marks, values, writes};
        store.extras.value = {marks, ui: {MiniMarks, MarkPins: none, MarksPanel: none},
          bindMiniWindow: panels.bindMiniWindow, expand: () => store.open.value = true};
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    loader: {'.css': 'text'},
    jsx: 'automatic',
    jsxImportSource: 'preact',
  });
  script = result.outputFiles[0].text;
  browser = process.env.BILI_CLIP_CDP_URL
    ? await chromium.connectOverCDP(process.env.BILI_CLIP_CDP_URL)
    : await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
});
after(async () => browser?.close());

async function fixture(t) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce'});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({content: script});
  await page.waitForFunction(() => Boolean(window.windowRig));
  await page.locator('#miniMarks').waitFor();
  return page;
}

async function drag(page, locator, dx, dy) {
  await locator.hover();
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, {steps: 5});
  await page.mouse.up();
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

const rect = (x, y, width, height) => ({x, y, width, height});

test('mini window shares dragging and resizing, restores its own bounds, and keeps controls clickable', async t => {
  const page = await fixture(t);
  const mini = page.locator('#miniMarks');
  assert.deepEqual(await mini.boundingBox(), rect(938, 496, 320, 300));
  await drag(page, mini.locator('.live-title'), -200, -100);
  assert.deepEqual(await mini.boundingBox(), rect(738, 396, 320, 300));
  await drag(page, mini.locator('[data-edge="se"]'), 120, 80);
  const saved = rect(738, 396, 440, 380);
  assert.deepEqual(await mini.boundingBox(), saved);
  await mini.locator('.mini-capture button').click();
  assert.equal(await page.evaluate(() => window.captures), 1);
  await mini.getByRole('button', {name: '收起小窗'}).click();
  await page.evaluate(() => (window.windowRig.marks.state.mini.value = true));
  assert.deepEqual(await mini.boundingBox(), saved);
  await mini.getByRole('button', {name: '展开剪辑'}).click();
  assert.equal(await mini.count(), 0);
  const panel = page.locator('#panel');
  await panel.locator('#header h1').hover();
  const original = await panel.boundingBox();
  await drag(page, panel.locator('[data-edge="nw"]'), 200, 150);
  const resized = await panel.boundingBox();
  assert.equal(resized.width, original.width - 200);
  assert.equal(resized.height, original.height - 150);
  await drag(page, page.locator('#header h1'), -50, -30);
  assert.deepEqual(await panel.boundingBox(), {...resized, x: resized.x - 50, y: resized.y - 30});
  assert.equal(await page.evaluate(() => window.windowRig.values.has('windowV3')), true);
  await page.evaluate(() => (window.windowRig.store.open.value = false));
  assert.deepEqual(await mini.boundingBox(), saved);
  await drag(page, mini.locator('.live-title'), -100, -100);
  const writes = await page.evaluate(() => window.windowRig.writes);
  assert.equal(writes.filter(key => key === 'miniMarksWindow').length, 3);
});

test('all eight mini window edges resize, respect minimum bounds and fit a smaller viewport', async t => {
  const page = await fixture(t);
  const mini = page.locator('#miniMarks');
  for (const edge of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    await page.evaluate(() => {
      window.windowRig.marks.state.mini.value = false;
      window.windowRig.values.set('miniMarksWindow', {left: 300, top: 200, width: 400, height: 350});
      window.windowRig.marks.state.mini.value = true;
    });
    const dx = edge.includes('w') ? -20 : edge.includes('e') ? 20 : 0;
    const dy = edge.includes('n') ? -20 : edge.includes('s') ? 20 : 0;
    await drag(page, mini.locator(`[data-edge="${edge}"]`), dx, dy);
    assert.deepEqual(
      await mini.boundingBox(),
      rect(300 + (dx < 0 ? dx : 0), 200 + (dy < 0 ? dy : 0), 400 + Math.abs(dx), 350 + Math.abs(dy)),
      edge,
    );
  }
  await drag(page, mini.locator('[data-edge="se"]'), -1000, -1000);
  const minimum = await mini.boundingBox();
  assert.equal(minimum.width, 280);
  assert.equal(minimum.height, 200);
  await page.evaluate(() => {
    window.windowRig.marks.state.items.value = Array.from({length: 4}, (_, i) => ({
      id: String(i),
      at: Date.now(),
      time: i,
      note: '测试备注',
      mine: true,
    }));
  });
  const head = await mini.locator('.mini-head').boundingBox();
  const scrolled = await mini.locator('.mini-body').evaluate(el => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop > 0;
  });
  assert.equal(scrolled, true);
  assert.deepEqual(await mini.locator('.mini-head').boundingBox(), head);
  await page.setViewportSize({width: 260, height: 180});
  assert.deepEqual(await mini.boundingBox(), rect(10, 10, 240, 160));
  await page.locator('#miniMarks .mini-capture button').click();
  assert.equal(await page.evaluate(() => window.captures), 1);
});
