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
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=34', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=34',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-bf', '2', '-g', '125', '-keyint_min', '125',
    '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '1',
    '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'split_by_time',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(directory, 'seg%03d.m4s'),
    path.join(directory, 'v.m3u8')]);
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
    response.end(await readFile(path.join(directory, path.basename(route))));
  } catch {
    response.writeHead(404).end();
  }
}

before(async () => {
  await createFixture();
  const {outputFiles} = await build({entryPoints: ['tools/tests/e2e/preview-page.js'], bundle: true, write: false,
    format: 'iife', target: 'chrome110', logLevel: 'error'});
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
    return await page.evaluate(([name, value]) => window[name](value), [action, {timeout: SETTLE_TIMEOUT, ...argument}]);
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
  assert.ok(Math.abs(result.time - 28.3) < .2, `landed at ${result.time}`);
});
