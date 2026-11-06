import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

let directory, browser, server, origin, code;
const reports = new Map();
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bella-export-e2e-'));
  const file = path.join(directory, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=21',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=21',
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
    file,
  ]);
  const fixture = await readFile(file);
  const {outputFiles} = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import {runExportChecks} from './tools/tests/browser/export.js';
      import {runSmartExportChecks} from './tools/tests/browser/smart-export.js';
      window.checkExport = runExportChecks;
      window.checkSmartExport = runSmartExportChecks;
    `,
    },
    bundle: true,
    write: false,
    format: 'iife',
  });
  code = outputFiles[0].text;
  server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) if (request.url.endsWith('.json')) chunks.push(chunk);
      if (chunks.length) reports.set(request.url, JSON.parse(Buffer.concat(chunks)));
      response.end('ok');
    } else if (request.url === '/fixture.mp4') {
      response.setHeader('Content-Type', 'video/mp4');
      response.end(fixture);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><body><p id="result"></p></body>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
});
after(async () => {
  await browser?.close();
  server?.close();
  if (directory) await rm(directory, {recursive: true, force: true});
});

for (const [name, fn, report] of [
  ['precise export retains frames/audio and recovers after cancellation', 'checkExport', 'precise-results.json'],
  ['smart export preserves copied packets and plays repeated cuts', 'checkSmartExport', 'smart-results.json'],
])
  test(name, {timeout: 120000}, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      await page.addScriptTag({content: code});
      await page.evaluate(fn => window[fn](), fn);
      const result = reports.get('/artifact/' + report);
      assert.ok(result?.passed, JSON.stringify(result) ?? (await page.locator('#result').innerText()));
      assert.ok(result.cases.length >= (fn === 'checkExport' ? 2 : 4));
    } finally {
      await page.close();
    }
  });
