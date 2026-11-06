import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {readFile, readdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

test(
  'log viewer filters, paginates, displays safe details and downloads all matching records',
  {timeout: 30000},
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bella-log-worker-'));
    const {outputFiles} = await build({
      entryPoints: ['src/server/logs-worker.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    });
    const bundle = path.join(directory, 'worker.mjs');
    await writeFile(bundle, outputFiles[0].text);
    const worker = (await import(pathToFileURL(bundle))).default;
    const db = new DatabaseSync(':memory:');
    const migrations = new URL('../../../server/logs/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort())
      db.exec(await readFile(new URL(file, migrations), 'utf8'));
    const insert = db.prepare('INSERT INTO logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const message = '<img src=x onerror="window.injected=true"> 导出完成';
    for (let i = 0; i < 60; i++)
      insert.run(
        'bella-live-clip',
        `record-${String(i).padStart(3, '0')}`,
        new Date(Date.now() - 10000).toISOString(),
        'info',
        'export_completed',
        '2.13.1',
        message,
        JSON.stringify({
          mode: i % 2 ? 'danmaku' : 'copy',
          stage: 'complete',
          browser: 'Chromium test',
          operation: {
            id: `task-${i % 3}`,
            action: 'export',
            outcome: 'completed',
            elapsedMs: 24000,
            startedAt: new Date(Date.now() - 34000).toISOString(),
          },
          metrics: {
            elapsedMs: 22000,
            firstPacketMs: 800,
            stages: {videoDraw: {count: 600, totalMs: 8000, maxMs: 32}},
            active: {},
            counters: {videoFrames: 600},
            encoder: {
              codec: 'avc1.42e01e',
              width: 1920,
              height: 1080,
              frameRate: 30,
              hardwarePreference: 'prefer-hardware',
            },
          },
          timeline: [
            {
              elapsedMs: 10000,
              stage: 'processing',
              fraction: 0.5,
              bytes: 1234,
              videoFrames: 300,
              processedSeconds: 10,
              fps: 30,
            },
          ],
          throughput: {fps: 27.27, realtime: 0.91},
          progress: {processedSeconds: 20},
          runtime: {noAdvanceMs: 0, visibility: 'visible'},
        }),
      );
    const env = {
      LOGS_DB: {
        prepare(sql) {
          return {
            bind(...args) {
              return {
                async first() {
                  return db.prepare(sql).get(...args);
                },
                async all() {
                  return {success: true, results: db.prepare(sql).all(...args)};
                },
              };
            },
          };
        },
      },
    };
    const server = createServer(async (request, response) => {
      try {
        const result = await worker.fetch(new Request(`http://127.0.0.1${request.url}`, {method: request.method}), env);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) for await (const chunk of result.body) response.write(chunk);
        response.end();
      } catch {
        response.writeHead(500).end();
      }
    });
    let browser;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
      const page = await browser.newPage({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const paths = [];
      page.on('request', request => paths.push(new URL(request.url()).pathname));
      await page.goto(origin + '/admin');
      assert.equal(page.url(), origin + '/admin/');
      await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 50);
      await page.locator('#rows button').first().click();
      assert.equal(await page.locator('#detail p').first().innerText(), message);
      assert.equal(await page.locator('#detail img').count(), 0);
      assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
      db.prepare('UPDATE logs SET message = ?').run('导出完成');
      assert.match(await page.locator('#detail').innerText(), /视频帧绘制/);
      assert.match(await page.locator('#detail').innerText(), /任务时间线/);
      assert.match(await page.locator('#detail').innerText(), /50%/);
      const download = page.waitForEvent('download');
      await page.locator('#download').click();
      const downloaded = await download;
      const rows = (await readFile(await downloaded.path(), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.equal(rows.length, 60, 'download is not limited to the visible page');
      assert.ok(rows.every(row => row.context.metrics.stages.videoDraw.count === 600));
      await page.locator('#next').click();
      await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 10);
      await page.locator('select[name=mode]').selectOption('danmaku');
      await page.locator('#filters button[type=submit]').click();
      await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 30);
      await page.locator('#rows button').first().click();
      await page.screenshot({path: '/tmp/bella-logs-viewer.png', fullPage: true});
      await page.locator('#detail button').click();
      await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 20);
      await page.setViewportSize({width: 390, height: 844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('input[name=source]').fill("invalid'filter");
      await page.locator('#filters button[type=submit]').click();
      await page.waitForFunction(() => document.getElementById('notice').classList.contains('error'));
      assert.deepEqual(errors, []);
      assert.ok(paths.includes('/admin/viewer.js'));
      assert.ok(paths.includes('/admin/api/logs'));
      assert.ok(paths.includes('/admin/api/logs/download'));
      assert.ok(
        paths.every(path => path === '/admin' || path.startsWith('/admin/')),
        JSON.stringify(paths),
      );
      for (const path of ['/', '/viewer.js', '/api/logs', '/api/logs/download'])
        assert.equal((await page.request.get(origin + path)).status(), 404);
    } finally {
      await browser?.close();
      server.close();
      db.close();
      await rm(directory, {recursive: true, force: true});
    }
  },
);
