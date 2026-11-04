import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

test('optimized compositor matches the 2.13.1 pixels at fractional positions, animation boundaries and empty frames', async () => {
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
            contents: 'export async function loadComments(){return window.compositorEvents}',
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
    }
    const windowed = await page.evaluate(() => window.checkCompositor({width: 1920, height: 1080, streaming: true}));
    assert.equal(windowed.compared, 13);
    const fixed = await page.evaluate(() => window.checkCompositor({width: 640, height: 360, fixed: true}));
    assert.ok(fixed.currentCalls < fixed.referenceCalls / 2, JSON.stringify(fixed));
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
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  } finally {
    await browser.close();
    server.close();
  }
});
