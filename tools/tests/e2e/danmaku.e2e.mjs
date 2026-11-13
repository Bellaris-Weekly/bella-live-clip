import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

const run = promisify(execFile);

test(
  'canvas danmaku export retains native size/audio, pre-rolls and releases temporary media',
  {timeout: 300000},
  async () => {
    const real = Boolean(process.env.DANMAKU_REAL_DIR);
    const directory = real ? process.env.DANMAKU_REAL_DIR : await mkdtemp(path.join(tmpdir(), 'bella-danmaku-'));
    const artifacts = process.env.DANMAKU_ARTIFACT_DIR ?? directory;
    await mkdir(artifacts, {recursive: true});
    let browser, server;
    try {
      let meta;
      if (real) meta = JSON.parse(await readFile(path.join(directory, 'replay.json'), 'utf8'));
      else {
        await run('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=0x123456:size=640x360:rate=30:duration=8',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=8',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-g',
          '60',
          '-bf',
          '2',
          '-c:a',
          'aac',
          '-f',
          'hls',
          '-hls_time',
          '2',
          '-hls_list_size',
          '0',
          '-hls_segment_type',
          'fmp4',
          '-hls_segment_filename',
          path.join(directory, 'seg%d.m4s'),
          path.join(directory, 'v.m3u8'),
        ]);
        await run('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=128x128:rate=5:duration=0.6',
          path.join(directory, 'flower.gif'),
        ]);
        meta = {
          record: {room: 1, key: 'test', start: 98, end: 106},
          part: {start_time: 98, end_time: 106, clockComplete: true},
          offset: 0,
          map: 'init.mp4',
          first: 'seg0.m4s',
          segments: Array.from({length: 4}, (_, i) => ({file: `seg${i}.m4s`, duration: 2})),
        };
      }
      const {outputFiles} = await build({
        entryPoints: ['tools/tests/e2e/danmaku-page.js'],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'chrome110',
        logLevel: 'error',
      });
      server = createServer(async (request, response) => {
        try {
          const pathname = new URL(request.url, 'http://localhost').pathname;
          if (request.method === 'POST' && pathname.startsWith('/artifact/')) {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            await writeFile(path.join(artifacts, path.basename(pathname)), Buffer.concat(chunks));
            return response.end('ok');
          }
          if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html');
            return response.end('<!doctype html><body></body>');
          }
          if (pathname === '/page.js') {
            response.setHeader('Content-Type', 'text/javascript');
            return response.end(outputFiles[0].text);
          }
          response.end(await readFile(path.join(directory, path.basename(pathname))));
        } catch {
          response.writeHead(404).end();
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
      const page = await browser.newPage();
      if (!real) {
        const fixture = await readFile('tools/tests/fixtures/danmaku.parquet');
        const animated = await readFile(path.join(directory, 'flower.gif'));
        await page.route('https://data.bellaris.fans/**', route => {
          const url = route.request().url();
          if (url.endsWith('flower.gif'))
            return route.fulfill({
              body: animated,
              contentType: 'image/gif',
              headers: {'Access-Control-Allow-Origin': '*'},
            });
          const body = url.includes('live-archive')
            ? url.endsWith('index.json')
              ? JSON.stringify({
                  schemaVersion: 1,
                  live: [{live_key: 'test', part: 1, path: 'live-archive/v1/1/live/test.parquet'}],
                })
              : fixture
            : url.endsWith('index.json')
              ? JSON.stringify({catalog: 'catalog.json'})
              : JSON.stringify({
                  emotes: [{name: '[花]', kind: 'emoji', file: 'flower.gif', width: 128, height: 128, animated: true}],
                });
          return route.fulfill({body, headers: {'Access-Control-Allow-Origin': '*'}});
        });
      }
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.addScriptTag({url: '/page.js'});
      const result = await page.evaluate(args => window.exportDanmaku(args), {meta, real});
      assert.equal(result.sawBurn, true);
      assert.equal(result.width, real ? 1920 : 640);
      assert.equal(result.height, real ? 1080 : 360);
      assert.equal(result.audioCodec, 'aac');
      assert.ok(result.audioPackets > 50);
      assert.equal(result.audioPayloadsPreserved, true);
      if (!real) {
        assert.ok(result.overlayPixels > 20);
        assert.ok(result.animationFrames > 1);
      }
      assert.ok(Math.abs(result.duration - (real ? 20 : 3)) < 0.1);
      assert.equal(result.temporaryRemaining, 0);
      if (!real) {
        const canceled = await page.evaluate(args => window.exportDanmaku(args), {meta, cancel: true});
        assert.equal(canceled.canceled, true);
        assert.equal(canceled.temporaryRemaining, 0);
      }
      result.realtime = result.duration / result.encodeSeconds;
      result.endToEndRealtime = result.duration / result.totalSeconds;
      if (real) await writeFile(path.join(artifacts, 'metrics.json'), JSON.stringify(result, null, 2));
    } finally {
      await browser?.close();
      server?.close();
      if (!real) await rm(directory, {recursive: true, force: true});
    }
  },
);
