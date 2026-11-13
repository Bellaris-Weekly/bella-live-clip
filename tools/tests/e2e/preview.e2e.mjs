import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

const SETTLE_TIMEOUT = 3900;
let directory, server, browser, origin, boundaries, script;

// Bilibili's fragments are about a second long with a keyframe only every few
// fragments, so most begin mid-GOP. That layout is what hung the preview.
async function createFixture() {
  directory = await mkdtemp(path.join(tmpdir(), 'bella-e2e-'));
  await promisify(execFile)('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=34',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=34',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-bf',
    '2',
    '-g',
    '125',
    '-keyint_min',
    '125',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'split_by_time',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(directory, 'seg%03d.m4s'),
    path.join(directory, 'v.m3u8'),
  ]);
  const playlist = await readFile(path.join(directory, 'v.m3u8'), 'utf8');
  let time = 0;
  boundaries = [...playlist.matchAll(/^#EXTINF:([\d.]+),/gm)].map(match => {
    const start = time;
    time += Number(match[1]);
    return Number(start.toFixed(3));
  });
}

async function respond(request, response) {
  const route = new URL(request.url, 'http://localhost').pathname;
  if (route === '/') {
    response.setHeader('Content-Type', 'text/html');
    return response.end('<!doctype html><body></body>');
  }
  if (route === '/page.js') {
    response.setHeader('Content-Type', 'text/javascript');
    return response.end(script);
  }
  if (route === '/still.svg') {
    response.setHeader('Content-Type', 'image/svg+xml');
    return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"/>');
  }
  try {
    const body = await readFile(path.join(directory, path.basename(route)));
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) return response.end(body);
    response.writeHead(206);
    response.end(body.subarray(Number(range[1]), Number(range[2]) + 1));
  } catch {
    response.writeHead(404).end();
  }
}

before(async () => {
  await createFixture();
  const {outputFiles} = await build({
    entryPoints: ['tools/tests/e2e/preview-page.js'],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome110',
    logLevel: 'error',
  });
  script = outputFiles[0].text;
  server = createServer(respond);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
});

after(async () => {
  await browser?.close();
  server?.close();
  if (directory) await rm(directory, {recursive: true, force: true});
});

async function inPage(action, argument) {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.addScriptTag({url: '/page.js'});
    return await page.evaluate(
      ([name, value]) => window[name](value),
      [action, {timeout: SETTLE_TIMEOUT, ...argument}],
    );
  } finally {
    await page.close();
  }
}

for (const action of ['seekTo', 'openAt']) {
  test(`${action} shows a picture at every fragment boundary and whole second`, async () => {
    const targets = [...new Set([...boundaries.slice(1, 25), ...Array.from({length: 24}, (_, i) => i + 1)])];
    const stuck = [];
    for (const target of targets) {
      const result = await inPage(action, {target});
      if (result.framedAt === null) stuck.push(target);
    }
    assert.deepEqual(stuck, []);
  });
}

test('a drag shows stills, leaves the video alone and lands on the final position', async () => {
  const result = await inPage('drag', {});
  assert.equal(result.seeks, 0, 'no seek while the pointer keeps moving');
  assert.equal(result.stillShown, true);
  assert.notEqual(result.framedAt, null);
  assert.equal(result.stillAfter, false, 'the decoded frame replaces the still');
  assert.ok(Math.abs(result.time - 28.3) < 0.2, `landed at ${result.time}`);
});

for (const paused of [false, true]) {
  for (const settledPreview of [false, true]) {
    test(`trim preview restores ${paused ? 'paused' : 'playing'} video after ${settledPreview ? 'settled' : 'pending'} preview`, async () => {
      const result = await inPage('restoreAfterTrim', {paused, settledPreview});
      assert.deepEqual(result.errors, []);
      assert.notEqual(result.initialFrame, null, 'the starting playback frame is decoded');
      if (settledPreview) {
        assert.notEqual(result.previewFrame, null, 'the trim point frame is decoded');
        assert.ok(Math.abs(result.previewTime - 25.3) < 0.2, `preview at ${result.previewTime}`);
      } else assert.ok(Math.abs(result.previewTime - result.saved) < 0.05, 'pending previews do not seek');
      assert.ok(Math.abs(result.restoredTime - result.saved) < 0.15, `restored to ${result.restoredTime}`);
      assert.notEqual(result.restoredFrame, null, 'the restored frame is decoded');
      assert.equal(result.stillShown, false, 'the restored video replaces the trim preview');
      assert.equal(result.paused, paused);
      const elapsed = result.finalTime - result.saved;
      if (paused) assert.ok(Math.abs(elapsed) < 0.15, `paused position moved by ${elapsed}`);
      else assert.ok(elapsed > 0.15 && elapsed < 2, `playback advanced by ${elapsed}`);
    });
  }
}

test('fullscreen playback in a shadow root seeks outside the selection and constrains again on exit', async () => {
  const result = await inPage('fullscreenPlayback', {});
  assert.deepEqual(result.errors, []);
  assert.notEqual(result.initialFrame, null);
  assert.equal(result.retargeted, true, 'the document retargets fullscreen to the shadow host');
  for (const position of result.positions) {
    assert.notEqual(position.framedAt, null, `decoded frame after seeking to ${position.target}`);
    assert.equal(
      position.paused,
      false,
      `fullscreen playback continues beyond either trim boundary: ${JSON.stringify(result)}`,
    );
    assert.ok(
      position.time >= position.target && position.time < position.target + 2,
      `seek to ${position.target} remained at ${position.time}`,
    );
  }
  assert.notEqual(result.exitFrame, null);
  assert.equal(result.exitPaused, true, 'exiting fullscreen enforces the selection end');
  assert.ok(Math.abs(result.exitTime - 15) < 0.2, `exit stopped at ${result.exitTime}`);
});

test('a fragment opening on a keyframe yields a real picture from its first media box', async () => {
  const result = await inPage('fragmentStill', {segment: '/seg000.m4s'});
  assert.equal(result.error, undefined);
  assert.equal(result.width, 320);
  assert.ok(result.brightness > 10, `brightness ${result.brightness}`);
});

test('a fragment opening mid-GOP is refused so the caller can fall back', async () => {
  const result = await inPage('fragmentStill', {segment: '/seg001.m4s'});
  assert.match(result.error, /关键帧/);
});

async function danmakuPage({missing = false, delay = 0, parts = 1} = {}) {
  const page = await browser.newPage();
  const requests = [];
  const state = {missing};
  const fixture = await readFile('tools/tests/fixtures/danmaku.parquet');
  await page.route('https://data.bellaris.fans/**', async route => {
    const url = route.request().url();
    requests.push(url);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (state.missing && url.includes('live-archive')) return route.fulfill({status: 404});
    const body = url.includes('live-archive')
      ? url.endsWith('index.json')
        ? JSON.stringify({
            schemaVersion: 1,
            sessions: Array.from({length: parts}, (_, part) => ({
              live_key: 'k',
              part,
              path: `live-archive/v1/1/k${part}.parquet`,
              bytes: fixture.length,
            })),
          })
        : fixture
      : url.endsWith('index.json')
        ? JSON.stringify({catalog: 'catalog.json'})
        : JSON.stringify({emotes: []});
    await route.fulfill({body, headers: {'Access-Control-Allow-Origin': '*'}});
  });
  await page.goto(`${origin}/`);
  await page.addScriptTag({url: '/page.js'});
  await page.evaluate(() => window.setupDanmakuPreview());
  return {page, requests, state};
}

test('real-time danmaku overlays playback, resets after scrubbing and releases on mode changes', async () => {
  const {page, requests} = await danmakuPage();
  try {
    assert.equal(requests.length, 0, 'ordinary preview does not request comments');
    await page.evaluate(() => {
      window.danmakuRig.preview.setEnabled(true);
      return window.danmakuRig.video.play();
    });
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    const first = await page.evaluate(() => window.overlayPixels());
    await page.waitForFunction(left => window.overlayPixels().left < left - 5, first.left);
    await page.evaluate(() => window.danmakuRig.video.pause());
    const paused = await page.evaluate(() => window.overlayPixels());
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => window.overlayPixels()), paused, 'comments freeze with video');
    const archiveReads = requests.filter(url => url.includes('live-archive')).length;
    await page.evaluate(() => {
      const r = window.danmakuRig;
      r.preview.setScrubbing(true);
      r.player.beginScrub();
      r.player.scrub(20);
    });
    assert.equal(await page.evaluate(() => window.danmakuRig.canvas.hidden), true);
    await page.waitForTimeout(200);
    assert.equal(requests.filter(url => url.includes('live-archive')).length, archiveReads);
    await page.evaluate(() => {
      const r = window.danmakuRig;
      r.player.endScrub();
      r.preview.setScrubbing(false);
    });
    await page.waitForFunction(() => !window.danmakuRig.video.seeking && window.danmakuRig.loading.hidden);
    await page.evaluate(() => window.danmakuRig.video.play());
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden);
    assert.equal(await page.evaluate(() => window.overlayPixels().count), 0, 'old comments do not survive seek');
    await page.evaluate(() => window.danmakuRig.player.seek(3));
    await page.waitForFunction(() => !window.danmakuRig.video.seeking && window.danmakuRig.loading.hidden);
    await page.evaluate(() => window.danmakuRig.video.play());
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    assert.equal(requests.filter(url => url.includes('live-archive')).length, archiveReads, 'seek reuses archive');
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(false));
    assert.equal(await page.evaluate(() => window.danmakuRig.canvas.hidden), true);
    const stopped = requests.length;
    await page.waitForTimeout(150);
    assert.equal(requests.length, stopped);
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(true));
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    const result = await page.evaluate(() => {
      const r = window.danmakuRig;
      const result = {errors: r.errors, paused: r.video.paused, width: r.canvas.width, height: r.canvas.height};
      r.preview.clear();
      result.hidden = r.canvas.hidden;
      r.preview.destroy();
      r.player.destroy();
      return result;
    });
    assert.deepEqual(result, {errors: [], paused: false, width: 320, height: 180, hidden: true});
  } finally {
    await page.close();
  }
});

test('missing danmaku reports once across seeks and recovers when the archive becomes available', async () => {
  const {page, state} = await danmakuPage({missing: true});
  try {
    await page.evaluate(() => {
      window.danmakuRig.preview.setEnabled(true);
      return window.danmakuRig.video.play();
    });
    await page.waitForFunction(() => window.danmakuRig.errors.length > 0);
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => ({
      errors: window.danmakuRig.errors,
      paused: window.danmakuRig.video.paused,
      time: window.danmakuRig.video.currentTime,
      hidden: window.danmakuRig.canvas.hidden,
    }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /没有弹幕归档/);
    assert.equal(result.paused, false);
    assert.ok(result.time > 3);
    assert.equal(result.hidden, true);
    for (const time of [20, 3]) {
      const retried = page.waitForResponse(
        response => response.url().includes('live-archive') && response.status() === 404,
      );
      await page.evaluate(time => window.danmakuRig.player.seek(time), time);
      await retried;
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.danmakuRig.errors.length), 1);
    }
    state.missing = false;
    await page.evaluate(() => window.danmakuRig.player.seek(4));
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    assert.equal(await page.evaluate(() => window.danmakuRig.errors.length), 1);
  } finally {
    await page.close();
  }
});

test('danmaku seeks reuse every archive partition until preview is disabled', async () => {
  const {page, requests} = await danmakuPage({parts: 3});
  const archives = () => requests.filter(url => url.includes('live-archive'));
  try {
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(true));
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    const initial = [...archives()];
    assert.equal(initial.length, 4, 'one index and all three partitions');
    for (const time of [20, 3]) {
      await page.evaluate(time => {
        const r = window.danmakuRig;
        r.preview.setScrubbing(true);
        r.player.seek(time);
        r.preview.setScrubbing(false);
      }, time);
      await page.waitForFunction(() => !window.danmakuRig.canvas.hidden);
      assert.equal(await page.evaluate(() => window.overlayPixels().count > 10), time === 3);
      assert.deepEqual(archives(), initial);
    }
    await page.evaluate(() => {
      window.danmakuRig.preview.setEnabled(false);
      window.danmakuRig.preview.setEnabled(true);
    });
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    assert.deepEqual(archives(), [...initial, ...initial], 'closing preview releases the source cache');
    assert.deepEqual(await page.evaluate(() => window.danmakuRig.errors), []);
  } finally {
    await page.close();
  }
});

test('disabling danmaku during archive loading discards late results', async () => {
  const {page, requests} = await danmakuPage({delay: 200});
  try {
    await page.evaluate(() => {
      window.danmakuRig.preview.setEnabled(true);
      return window.danmakuRig.video.play();
    });
    await page.waitForTimeout(100);
    assert.ok(requests.length > 0);
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(false));
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => ({
      errors: window.danmakuRig.errors,
      paused: window.danmakuRig.video.paused,
      hidden: window.danmakuRig.canvas.hidden,
    }));
    assert.deepEqual(result, {errors: [], paused: false, hidden: true});
  } finally {
    await page.close();
  }
});

test('danmaku catalog and image bytes survive seeks, while closing preview releases them', async () => {
  const {page} = await danmakuPage();
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    return Array.from(new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer()));
  });
  const requests = [];
  await page.route('https://data.bellaris.fans/emotes/**', async route => {
    const name = route.request().url().split('/').at(-1);
    requests.push(name);
    const body =
      name === 'index.json'
        ? JSON.stringify({catalog: 'catalog.json'})
        : name === 'catalog.json'
          ? JSON.stringify({emotes: [{name: '花', kind: 'emoji', file: 'flower.png', width: 128, height: 128}]})
          : Buffer.from(bytes);
    await route.fulfill({
      body,
      contentType: name.endsWith('.png') ? 'image/png' : 'application/json',
      headers: {'Access-Control-Allow-Origin': '*'},
    });
  });
  try {
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(true));
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    for (const time of [4.5, 5, 3]) {
      await page.evaluate(time => {
        const r = window.danmakuRig;
        r.preview.setScrubbing(true);
        r.player.seek(time);
        r.preview.setScrubbing(false);
      }, time);
      await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    }
    assert.deepEqual(requests, ['index.json', 'catalog.json', 'flower.png']);
    await page.evaluate(() => {
      window.danmakuRig.preview.setEnabled(false);
      window.danmakuRig.preview.setEnabled(true);
    });
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    assert.equal(requests.filter(name => name === 'flower.png').length, 2);
    assert.deepEqual(await page.evaluate(() => window.danmakuRig.errors), []);
  } finally {
    await page.close();
  }
});

test('fullscreen includes danmaku and native media controls, with an explicit exit button', async () => {
  const {page} = await danmakuPage();
  try {
    await page.addStyleTag({content: await readFile('src/ui/theme.css', 'utf8')});
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(true));
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    await page.evaluate(() => window.danmakuRig.video.dispatchEvent(new MouseEvent('dblclick')));
    await page.waitForFunction(() => document.fullscreenElement === window.danmakuRig.wrap);
    const result = await page.evaluate(() => {
      const r = window.danmakuRig;
      return {
        included: document.fullscreenElement.contains(r.canvas),
        controls: r.video.controls,
        noVideoOnlyFullscreen: r.video.controlsList.contains('nofullscreen'),
        exit: getComputedStyle(r.exitButton).display,
        width: r.canvas.getBoundingClientRect().width,
      };
    });
    assert.equal(result.included, true);
    assert.equal(result.controls, true);
    assert.equal(result.noVideoOnlyFullscreen, true);
    assert.notEqual(result.exit, 'none');
    assert.ok(result.width > 320);
    await page.evaluate(() => window.danmakuRig.exitButton.click());
    await page.waitForFunction(() => !document.fullscreenElement && !window.danmakuRig.video.controls);
    assert.equal(await page.evaluate(() => window.danmakuRig.video.controls), false);
  } finally {
    await page.close();
  }
});

test('container fullscreen in a shadow root plays outside the selection and constrains again on exit', async () => {
  const result = await inPage('fullscreenPlayback', {container: true});
  assert.equal(result.retargeted, true);
  assert.deepEqual(result.errors, []);
  for (const position of result.positions) {
    assert.notEqual(position.framedAt, null);
    assert.equal(position.paused, false);
    assert.ok(Math.abs(position.time - position.target) < 1);
  }
  assert.equal(result.exitPaused, true);
  assert.ok(Math.abs(result.exitTime - 15) < 0.2);
});

test('slow live windows keep existing danmaku moving, including a pause during the pending read', async () => {
  const {page} = await danmakuPage();
  const before = await readFile('tools/tests/fixtures/live-before.parquet'),
    after = await readFile('tools/tests/fixtures/live-after.parquet');
  let reads = 0,
    demandStarted,
    release;
  const demand = new Promise(resolve => {
    demandStarted = resolve;
  });
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  await page.route('https://data.bellaris.fans/live-archive/**', async route => {
    let body;
    if (route.request().url().endsWith('index.json'))
      body = JSON.stringify({schemaVersion: 1, live: [{live_key: 'k', part: 1, path: 'live-archive/live.parquet'}]});
    else {
      if (++reads === 3) {
        demandStarted();
        await blocked;
      }
      body = reads < 3 ? before : after;
    }
    await route.fulfill({body, headers: {'Access-Control-Allow-Origin': '*'}});
  });
  try {
    await page.evaluate(() => window.danmakuRig.preview.setEnabled(true));
    await page.waitForFunction(() => !window.danmakuRig.canvas.hidden && window.overlayPixels().count > 10);
    await page.evaluate(() => {
      window.danmakuRig.video.playbackRate = 2;
      return window.danmakuRig.video.play();
    });
    await demand;
    await page.waitForTimeout(200);
    const first = await page.evaluate(() => ({
      hidden: window.danmakuRig.canvas.hidden,
      pixels: window.overlayPixels(),
    }));
    assert.equal(first.hidden, false);
    assert.ok(first.pixels.count > 10);
    await page.waitForFunction(left => window.overlayPixels().left < left, first.pixels.left);
    await page.evaluate(() => window.danmakuRig.video.pause());
    await page.waitForTimeout(100);
    const paused = await page.evaluate(() => window.overlayPixels());
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.overlayPixels()), paused);
    release();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.danmakuRig.canvas.hidden), false);
    assert.deepEqual(await page.evaluate(() => window.danmakuRig.errors), []);
  } finally {
    release();
    await page.close();
  }
});

test('preview context allocation failure reports an actionable error', async () => {
  const {page} = await danmakuPage();
  try {
    await page.evaluate(() => {
      window.danmakuRig.canvas.getContext = () => null;
      window.danmakuRig.preview.setEnabled(true);
    });
    await page.waitForFunction(() => window.danmakuRig.errors.length > 0);
    assert.match(await page.evaluate(() => window.danmakuRig.errors[0]), /无法创建弹幕预览画布/);
  } finally {
    await page.close();
  }
});
