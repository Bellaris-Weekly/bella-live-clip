import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

let browser, script;
before(async () => {
  const result = await build({
    stdin: {
      contents: `
        import {createTimeline} from './src/ui/timeline.js';
        import template from './src/ui/template.html';
        import styles from './src/ui/styles.css';
        const source = document.createElement('template');
        source.innerHTML = template;
        const host = document.createElement('div');
        document.body.append(host);
        const root = host.attachShadow({mode: 'open'});
        const style = document.createElement('style');
        style.textContent = styles + '\\n:host{display:block;width:840px} .timeline-section{margin-top:40px}';
        root.append(style, source.content.querySelector('.timeline-section'));
        const $ = id => root.getElementById(id);
        const previews = [], ends = [];
        const timeline = createTimeline({
          track: $('timeline'), startHandle: $('startHandle'), endHandle: $('endHandle'),
          selectionElement: $('selection'), playhead: $('playhead'), ticks: $('ticks'),
          onPreview: time => previews.push(time),
          onScrubEnd: (time, options) => ends.push({time, ...options}),
        });
        timeline.reset(100, {start: 20, end: 60});
        window.rig = {timeline, previews, ends};
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    loader: {'.html': 'text', '.css': 'text'},
    logLevel: 'error',
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
});
after(async () => browser?.close());

async function fixture(t) {
  const page = await browser.newPage({reducedMotion: 'reduce'});
  t.after(() => page.close());
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({content: script});
  const box = await page.locator('#timeline').boundingBox();
  return {page, box};
}

for (const type of ['start', 'end']) {
  test(`real pointer click on ${type} handle commits its position without changing selection`, async t => {
    const {page} = await fixture(t);
    await page.locator(`#${type}Handle`).click();
    const state = await page.evaluate(() => ({
      end: window.rig.ends.at(-1),
      selection: window.rig.timeline.getSelection(),
      view: window.rig.timeline.getView(),
    }));
    assert.deepEqual(state, {
      end: {time: type === 'start' ? 20 : 60, canceled: false, commitPosition: true},
      selection: {start: 20, end: 60},
      view: {start: 0, end: 100},
    });
  });
}

test('real double click expands a zoomed selection; body drags preserve length and preview its start', async t => {
  const {page, box} = await fixture(t);
  await page.evaluate(() => window.rig.timeline.setSelection({start: 20, end: 60}, true));
  assert.notDeepEqual(await page.evaluate(() => window.rig.timeline.getView()), {start: 0, end: 100});
  await page.locator('#selection').dblclick();
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getView()), {start: 0, end: 100});
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getSelection()), {start: 20, end: 60});
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, {steps: 5});
  await page.waitForFunction(() => window.rig.timeline.getSelection().start > 39);
  const moving = await page.evaluate(() => ({
    selection: window.rig.timeline.getSelection(),
    preview: window.rig.previews.at(-1),
  }));
  assert.ok(Math.abs(moving.selection.start - 40) < 0.2);
  assert.equal(moving.selection.end - moving.selection.start, 40);
  assert.equal(moving.preview, moving.selection.start);
  await page.mouse.up();
  const end = await page.evaluate(() => window.rig.ends.at(-1));
  assert.equal(end.commitPosition, true);
  assert.equal(end.time, moving.selection.start);
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getView()), {start: 0, end: 100});

  const handle = await page.locator('#startHandle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y, {steps: 5});
  await page.mouse.up();
  const resized = await page.evaluate(() => window.rig.timeline.getSelection());
  assert.ok(Math.abs(resized.start - 30) < 0.2);
  assert.equal(resized.end, moving.selection.end);
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getView()), {start: 0, end: 100});
});

test('double clicking a handle or unselected area does not reset zoom', async t => {
  const {page, box} = await fixture(t);
  await page.evaluate(() => window.rig.timeline.setSelection({start: 20, end: 60}, true));
  const view = await page.evaluate(() => window.rig.timeline.getView());
  await page.locator('#startHandle').dblclick();
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getView()), view);
  await page.mouse.dblclick(box.x + 2, box.y + box.height / 2);
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getView()), view);
});

test('a twenty-second clip in a two-hour overview still has a draggable center and two reachable handles', async t => {
  const {page, box} = await fixture(t);
  await page.evaluate(() => {
    window.rig.timeline.reset(7200, {start: 600, end: 620});
    window.rig.timeline.setSelection({start: 600, end: 620}, true);
  });
  await page.locator('#selection').dblclick();
  assert.deepEqual(await page.evaluate(() => window.rig.timeline.getView()), {start: 0, end: 7200});
  const selection = await page.locator('#selection').boundingBox();
  const x = selection.x + selection.width / 2,
    y = selection.y + selection.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + box.width * 0.1, y, {steps: 5});
  await page.mouse.up();
  const moved = await page.evaluate(() => window.rig.timeline.getSelection());
  assert.ok(Math.abs(moved.start - 1320) < 10);
  assert.equal(moved.end - moved.start, 20);
  assert.equal(await page.evaluate(() => window.rig.previews.at(-1)), moved.start);
  for (const type of ['start', 'end']) {
    await page.locator(`#${type}Handle`).click({position: {x: 5, y: 5}});
    assert.equal(await page.evaluate(() => window.rig.ends.at(-1).time), moved[type]);
  }
});
