import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {commentPreroll} from '../../../src/danmaku/super-chat.js';
import {chromium} from 'playwright-core';

test('sprite compositor preserves direct-text appearance at fractional positions, animation boundaries and empty frames', async () => {
  const {outputFiles} = await build({
    entryPoints: ['tools/tests/e2e/compositor-page.js'],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'frozen-comments',
        setup(build) {
          build.onLoad({filter: /src\/danmaku\/archive\.js$/}, () => ({
            contents:
              'export async function loadComments(){return window.compositorEvents} export async function boundedFetch(){throw new Error("unexpected avatar fetch")}',
            loader: 'js',
          }));
          build.onLoad({filter: /src\/danmaku\/emotes\.js$/}, () => ({
            contents: `
        export async function loadEmotes(events, room, fontSize){return window.compositorAssets(fontSize)}
        export async function loadEmoteCatalog(){return new Map([['[花]',{}]])}
        export const referencedEmotes=events=>new Set(events.flatMap(event=>textTokens(event.text).filter(text=>text.startsWith('['))));
        export const textTokens = text => String(text).split(/(\\[[^[\\]]+\\])/u).filter(Boolean);
        export function emoteFrame(asset, elapsed){const phase=Math.max(0,elapsed)%asset.ends.at(-1); return asset.frames[asset.ends.findIndex(end=>end>phase)]??asset.frames.at(-1)}
      `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><body></body>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({content: outputFiles[0].text});
    for (const [width, height] of [
      [640, 360],
      [1920, 1080],
      [361, 641],
    ]) {
      const result = await page.evaluate(size => window.checkCompositor(size), {width, height});
      assert.equal(result.compared, 17);
      assert.ok(result.meanDiff < 0.5, JSON.stringify(result));
      assert.ok(result.changedFraction < 0.04, JSON.stringify(result));
    }
    const revisions = await page.evaluate(() => window.checkOverlayRevision());
    assert.equal(revisions.results[0].revision, revisions.results[1].revision);
    assert.ok(revisions.results[2].revision > revisions.results[1].revision);
    assert.deepEqual(
      revisions.results.map(item => item.pixel),
      [
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ],
    );
    assert.deepEqual(revisions.cleared, [0, 0, 0, 0]);
    assert.ok(revisions.finalRevision > revisions.results[2].revision);
    const isolated = await page.evaluate(() => window.inspectSpriteSampling());
    for (const item of isolated) {
      if (item.scene !== 'moving' && item.scene !== 'overlap') assert.equal(item.maxDiff, 0, JSON.stringify(item));
      // At 75% alpha, overlapping antialiased edges can differ by three 8-bit
      // levels between direct text drawing and cached bitmap compositing.
      if (item.scene === 'overlap') assert.ok(item.maxDiff <= 3, JSON.stringify(item));
      assert.ok(item.meanDiff < 0.5, JSON.stringify(item));
      assert.ok(item.changedFraction < 0.04, JSON.stringify(item));
    }
    const failure = await page.evaluate(() => window.checkFailedEmoteSprites());
    assert.deepEqual(failure.textParts, ['before', '[花]', 'after', '😀']);
    assert.equal(failure.initial.metrics.counters.spriteRasters, 3);
    assert.equal(failure.fallback.closed, 3, 'remeasured item releases every old text sprite');
    assert.equal(failure.fallback.metrics.counters.spriteRasters, 7);
    assert.equal(failure.reuse.metrics.counters.spriteRasters, 7);
    assert.deepEqual(failure.cleared, {closed: 7, bytes: 0});
    assert.equal(failure.rebuilt.metrics.counters.spriteRasters, 11);
    assert.equal(failure.expired.closed, 11);
    assert.equal(failure.expired.metrics.gauges.spriteBytes.current, 0);
    for (const phase of ['initial', 'fallback', 'reuse', 'rebuilt', 'expired'])
      assert.equal(failure[phase].maxDiff, 0, phase);
    const windowed = await page.evaluate(() => window.checkCompositor({width: 1920, height: 1080, streaming: true}));
    assert.equal(windowed.compared, 13);
    assert.ok(windowed.meanDiff < 0.5, JSON.stringify(windowed));
    assert.ok(windowed.changedFraction < 0.04, JSON.stringify(windowed));
    const fixed = await page.evaluate(() => window.checkCompositor({width: 640, height: 360, fixed: true}));
    assert.ok(fixed.currentCalls < fixed.referenceCalls / 2, JSON.stringify(fixed));
    const liveWindows = await page.evaluate(() => window.checkLiveWindowPrefetch());
    assert.deepEqual(liveWindows.before, [
      {start: -commentPreroll(64, 64), end: 10, prefetch: false},
      {start: 10, end: 20, prefetch: true},
    ]);
    assert.deepEqual(liveWindows.after, [...liveWindows.before, {start: 10, end: 20, prefetch: false}]);
    const overlap = await page.evaluate(() => window.checkEncodingOverlap());
    assert.ok(overlap.events.indexOf('render1') < overlap.events.indexOf('resolved0'));
    assert.ok(overlap.events.indexOf('resolved0') < overlap.events.indexOf('add1'));
    assert.equal(overlap.peak, 1);
    assert.equal(overlap.returned, true);
    assert.deepEqual(overlap.closes, [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(overlap.pixels, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
    assert.equal(overlap.decoded.length, 3);
    overlap.decoded.forEach((pixel, i) =>
      pixel.forEach((value, channel) =>
        assert.ok(Math.abs(value - overlap.pixels[i][channel]) <= 3, JSON.stringify(overlap.decoded)),
      ),
    );
    assert.deepEqual(overlap.timestamps, [0, 1 / 30, 2 / 30]);
    overlap.durations.forEach(duration => assert.ok(Math.abs(duration - 1 / 30) < 1e-12));
    assert.equal(overlap.firstKey, 'key');
    const directory = await mkdtemp(path.join(tmpdir(), 'bella-compositor-yuv-'));
    try {
      const file = path.join(directory, 'input.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30:duration=0.1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        file,
      ]);
      const encoded = [...(await readFile(file))];
      const result = await page.evaluate(
        encoded => window.checkCompositor({width: 640, height: 360, encoded}),
        encoded,
      );
      assert.equal(result.compared, 17);
      assert.ok(result.meanDiff < 0.5, JSON.stringify(result));
      assert.ok(result.changedFraction < 0.04, JSON.stringify(result));
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  } finally {
    await browser.close();
    server.close();
  }
});
