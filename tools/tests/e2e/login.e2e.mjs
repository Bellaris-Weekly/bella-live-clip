import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

let browser, script, font;
const artifacts = process.env.BILI_CLIP_ARTIFACTS || '.local/test-artifacts/login';
before(async () => {
  await mkdir(artifacts, {recursive: true});
  if (process.env.BILI_CLIP_TEST_FONT) font = (await readFile(process.env.BILI_CLIP_TEST_FONT)).toString('base64');
  const result = await build({
    stdin: {
      contents: `
        import {createApp} from './src/app/application.js';
        const saved = {left: 80, top: 40, width: 800, height: 720};
        const values = new Map([['windowV2', saved]]), writes = [], listeners = [];
        let identity = null;
        const studio = {
          identity: () => identity,
          subscribe: fn => listeners.push(fn),
          serverNow: () => Date.now(),
          syncClock: async () => {},
          logout() {identity = null; listeners.forEach(fn => fn());},
        };
        const app = createApp({
          studio,
          api: {request: async () => {throw new Error('fixture offline');}, current: async () => null, history: async () => []},
          storageKeys: () => [...values.keys()],
          get: (key, fallback) => values.get(key) ?? fallback,
          set: (key, value) => {values.set(key, value); writes.push(key);},
          pageUrl: () => 'https://live.bilibili.com/12',
        });
        window.rig = {
          app, saved, writes,
          login() {identity = {name: '成员'}; listeners.forEach(fn => fn());},
          logout: () => studio.logout(),
        };
        void app.open();
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    minify: true,
    write: false,
    format: 'iife',
    define: {__PREVIEW__: 'true'},
    loader: {'.html': 'text', '.css': 'text', '.txt': 'text'},
    logLevel: 'error',
  });
  script = result.outputFiles[0].text;
  browser = process.env.BILI_CLIP_CDP_URL
    ? await chromium.connectOverCDP(process.env.BILI_CLIP_CDP_URL)
    : await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
});
after(async () => browser?.close());

async function fixture(t, {width = 1280, height = 900, dark = false} = {}) {
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 2, reducedMotion: 'reduce'});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent(
    `<!doctype html><html lang="zh" data-theme="${dark ? 'dark' : 'light'}"><meta charset="utf-8"><style>body{margin:0;background:${dark ? '#141918' : '#edf2ef'}}</style><body></body></html>`,
  );
  if (font)
    await page.evaluate(async data => {
      const face = new FontFace('PingFang SC', `url(data:font/woff2;base64,${data})`);
      document.fonts.add(await face.load());
    }, font);
  await page.addScriptTag({content: script});
  await page.locator('#studioLogin').waitFor({state: 'visible'});
  return page;
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const root = window.rig.app.root;
    const $ = id => root.getElementById(id);
    const bounds = element => {
      const {x, y, width, height} = element.getBoundingClientRect();
      return {x, y, width, height};
    };
    const link = $('studioLogin').querySelector('a');
    return {
      panel: bounds($('panel')),
      text: bounds($('studioLogin').querySelector('p')),
      link: bounds(link),
      href: link.href,
      target: link.target,
      visibleResize: [...root.querySelectorAll('.resize')].filter(el => el.getClientRects().length).length,
      visibleVersion: Boolean($('version').getClientRects().length),
      visibleShortcut: Boolean($('shortcut').getClientRects().length),
      noOverflow: $('studioLogin').scrollWidth <= $('studioLogin').clientWidth,
    };
  });
  const {panel, text, link} = layout;
  const viewport = page.viewportSize();
  assert.ok(panel.width <= 400 && panel.height < 240, JSON.stringify(panel));
  assert.ok(panel.x >= 9 && panel.y >= 9);
  assert.ok(panel.x + panel.width <= viewport.width - 9);
  assert.ok(panel.y + panel.height <= viewport.height - 9);
  assert.ok(Math.abs(panel.x + panel.width / 2 - viewport.width / 2) <= 1);
  assert.ok(Math.abs(panel.y + panel.height / 2 - viewport.height / 2) <= 1);
  assert.ok(link.y - (text.y + text.height) >= 19, 'login button must not overlap the explanation');
  assert.ok(link.height >= 42 && link.y + link.height < panel.y + panel.height);
  assert.equal(layout.href, 'https://studio.bk0717.com/plugin/link');
  assert.equal(layout.target, '_blank');
  assert.equal(layout.visibleResize, 0);
  assert.equal(layout.visibleVersion, false);
  assert.equal(layout.visibleShortcut, false);
  assert.equal(layout.noOverflow, true);
  return panel;
}

for (const [name, options] of [
  ['desktop', {}],
  ['dark', {dark: true}],
  ['narrow', {width: 360, height: 640}],
  ['short', {width: 640, height: 240}],
]) {
  test(`login layout fits ${name} without overlapping text or empty editor space`, async t => {
    const page = await fixture(t, options);
    await checkLayout(page);
    await page.screenshot({path: `${artifacts}/${name}.png`});
    await page.locator('#panel').screenshot({path: `${artifacts}/${name}-panel.png`});
  });
}

test('login preserves editor geometry through dragging, authentication, logout and reopening', async t => {
  const page = await fixture(t);
  const before = await checkLayout(page);
  const header = await page.locator('#header').boundingBox();
  await page.mouse.move(header.x + 50, header.y + 25);
  await page.mouse.down();
  await page.mouse.move(header.x + 150, header.y + 85, {steps: 5});
  await page.mouse.up();
  assert.deepEqual(await page.locator('#panel').boundingBox(), before);
  assert.deepEqual(await page.evaluate(() => window.rig.writes), []);
  await page.locator('#close').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#studioLogin a').evaluate(el => el === el.getRootNode().activeElement), true);
  assert.equal(await page.locator('#studioLogin a').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.screenshot({path: `${artifacts}/keyboard-focus.png`});
  await page.evaluate(() => window.rig.login());
  await page.locator('#studioLogin').waitFor({state: 'hidden'});
  const editor = await page.locator('#panel').boundingBox();
  assert.deepEqual(editor, {x: 80, y: 40, width: 800, height: 720});
  assert.equal(await page.locator('.resize:visible').count(), 8);
  await page.evaluate(() => window.rig.logout());
  assert.deepEqual(await checkLayout(page), before);
  await page.locator('#close').click();
  assert.equal(await page.locator('#panel').isVisible(), false);
  await page.locator('#launcher').click();
  assert.deepEqual(await checkLayout(page), before);
  await page.setViewportSize({width: 360, height: 640});
  await checkLayout(page);
  assert.equal(await page.evaluate(() => window.rig.writes.includes('windowV2')), false);
});
