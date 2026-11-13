import {createServer} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

test('SC sprites, preview/export opacity, avatars and streaming boundaries', async () => {
  const {outputFiles} = await build({
    entryPoints: ['tools/tests/e2e/super-chat-page.js'],
    bundle: true,
    write: false,
    format: 'iife',
  });
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><body></body>');
  });
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({content: outputFiles[0].text});
    const result = await page.evaluate(() => window.checkSuperChat());
    assert.ok(Math.abs(result.alpha - 255 * 0.85) <= 1, JSON.stringify(result));
    assert.ok(Math.abs(result.normalAlpha - 255 * 0.65) <= 1, JSON.stringify(result));
    assert.ok(result.avatarPixel[0] > 230 && result.avatarPixel[1] < 25 && result.avatarPixel[2] > 230);
    assert.equal(result.height, result.normalHeight);
    assert.equal(result.fetches, 1);
    assert.equal(result.counters.spriteRasters, 2, 'one raster per placed item across sixty frames');
    assert.equal(result.maxDifference, 0, 'preview and exported samples use identical opacity');
    const late = await page.evaluate(() => window.checkLateAvatar());
    assert.ok(late.before[1] > 25, 'placeholder before the avatar arrives');
    assert.ok(late.after[0] > 200 && late.after[1] < 25 && late.after[2] > 200, JSON.stringify(late));
    assert.equal(late.widthAfter, late.widthBefore);
    const windows = await page.evaluate(() => window.checkSuperChatWindows());
    assert.equal(windows.maxDifference, 0);
    assert.deepEqual(windows.firstWindow, {start: -windows.preroll, end: 10});
    console.log(JSON.stringify({sc: result, windows}));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
