import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

let browser, server, origin;
before(async () => {
  const {outputFiles} = await build({
    entryPoints: ['tools/tests/e2e/compose-controls-page.js'],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome110',
    loader: {'.css': 'text'},
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'error',
  });
  server = createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(outputFiles[0].text);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><html lang="zh"><body style="margin:0;background:#eef0f5"><script src="/fixture.js"></script></body></html>',
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
});
after(async () => {
  await browser?.close();
  server?.close();
});
async function open(t, viewport = {width: 1280, height: 900}) {
  const page = await browser.newPage({viewport, timezoneId: 'America/Los_Angeles'});
  t.after(() => page.close());
  await page.goto(origin);
  await page.waitForFunction(() => window.controls);
  return page;
}

test('tag input preserves pointer deletion on blur, and Enter never submits the archive', async t => {
  const page = await open(t);
  await page.getByRole('button', {name: '添加标签', exact: true}).click();
  await page.getByRole('textbox', {name: '新标签'}).fill('新标签');
  // The blur commits the text; the original delete button must still receive its click.
  await page.getByRole('button', {name: '删除标签 贝拉', exact: true}).click();
  assert.equal(await page.getByRole('button', {name: '删除标签 贝拉', exact: true}).count(), 0);
  assert.equal(await page.getByRole('button', {name: '删除标签 新标签', exact: true}).count(), 1);
  await page.getByRole('button', {name: '添加标签', exact: true}).click();
  await page.getByRole('textbox', {name: '新标签'}).fill('继续添加');
  await page.getByRole('textbox', {name: '新标签'}).press('Enter');
  assert.equal(
    await page
      .getByRole('textbox', {name: '新标签'})
      .evaluate(element => element.getRootNode().activeElement === element),
    true,
  );
  assert.equal(await page.evaluate(() => window.controls.submissions), 0);
});

test('calendar works inside the clipped shadow panel, retains its time in a non-Beijing browser, and clears without submitting', async t => {
  const page = await open(t);
  await page.getByRole('button', {name: '20 分钟', exact: true}).click();
  await page.getByRole('button', {name: '定时投稿', exact: true}).click();
  const popup = page.getByRole('dialog', {name: '选择投稿时间'});
  await popup.waitFor({state: 'visible'});
  const box = await popup.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 900);
  const tomorrow = await page.evaluate(() => new Date(Date.now() + (24 + 8) * 3600_000).toISOString().slice(0, 10));
  await page.locator(`[data-day="${tomorrow}"]`).click();
  await page.getByRole('textbox', {name: '分钟', exact: true}).fill('17');
  await page.getByRole('textbox', {name: '分钟', exact: true}).press('Enter');
  await popup.waitFor({state: 'hidden'});
  assert.equal(await page.evaluate(() => window.controls.submissions), 0);
  await page.getByRole('button', {name: '定时投稿', exact: true}).click();
  await page.getByRole('button', {name: '取消定时', exact: true}).click();
  await popup.waitFor({state: 'hidden'});
  assert.equal(await page.locator('[data-scheduleAt]').inputValue(), '');
});

test('part edits and removed bumper reach submission; presets reload with only their style', async t => {
  const page = await open(t);
  await page.getByRole('textbox', {name: 'P1 标题', exact: true}).fill('独立分P标题');
  await page.getByRole('textbox', {name: 'P1 标题', exact: true}).press('Enter');
  assert.equal(await page.evaluate(() => window.controls.submissions), 0);
  await page.getByRole('button', {name: '移除防撞', exact: true}).click();
  await page.getByRole('button', {name: '确认投稿', exact: true}).click();
  const parts = await page.evaluate(() => window.controls.request.parts);
  assert.deepEqual(parts, [{title: '独立分P标题'}]);
  await page.locator('.cover-text-details > summary').click();
  await page.getByRole('spinbutton', {name: '文字字号'}).fill('144');
  await page.getByRole('spinbutton', {name: '文字字号'}).press('Enter');
  assert.equal(await page.evaluate(() => window.controls.submissions), 1);
  await page.getByRole('button', {name: '保存文字预设', exact: true}).click();
  await page.getByRole('textbox', {name: '预设名称', exact: true}).fill('大字');
  await page.getByRole('textbox', {name: '预设名称', exact: true}).press('Enter');
  await page.getByRole('button', {name: '大字', exact: true}).waitFor();
  await page.reload();
  await page.getByRole('button', {name: '大字', exact: true}).click();
  assert.equal(await page.evaluate(() => window.controls.cover.state.value.text.size), 144 / 1080);
  assert.equal(await page.getByRole('textbox', {name: '封面文字', exact: true}).inputValue(), '贝拉直播切片');
});

for (const width of [1280, 620])
  test(`compose controls fit ${width}px panels in both themes`, async t => {
    const page = await open(t, {width, height: 900});
    await page.getByRole('button', {name: '定时投稿', exact: true}).click();
    await page.getByRole('dialog', {name: '选择投稿时间'}).waitFor({state: 'visible'});
    const popup = await page.getByRole('dialog', {name: '选择投稿时间'}).boundingBox();
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width);
    const overflow = await page.locator('#panel').evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false);
    await mkdir('.local/compose-controls', {recursive: true});
    await page.screenshot({animations: 'disabled', path: `.local/compose-controls/${width}-light-calendar.png`});
    await page.getByRole('dialog', {name: '选择投稿时间'}).press('Escape');
    await page.evaluate(() => {
      window.controls.host.dataset.theme = 'dark';
      for (const element of document
        .querySelector('div')
        .shadowRoot.querySelectorAll('.compose-grid, .compose-body, .compose-cover'))
        element.scrollTop = 0;
    });
    await page.screenshot({animations: 'disabled', path: `.local/compose-controls/${width}-dark.png`});
  });

test('calendar fallback stays clickable outside panel clipping when the popover API is unavailable', async t => {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  t.after(() => page.close());
  await page.addInitScript(() => {
    HTMLElement.prototype.showPopover = undefined;
  });
  await page.goto(origin);
  await page.getByRole('button', {name: '定时投稿', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '选择投稿时间'});
  await dialog.waitFor({state: 'visible'});
  assert.equal(await dialog.evaluate(element => element.parentNode instanceof ShadowRoot), true);
  await page.getByRole('button', {name: '取消定时', exact: true}).click();
  await dialog.waitFor({state: 'hidden'});
  assert.equal(
    await page
      .locator('.schedule-popover')
      .evaluate(element => element.parentElement.hasAttribute('data-schedule-picker')),
    true,
  );
});
