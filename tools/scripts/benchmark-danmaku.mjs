// Controlled final-stage benchmark; excludes network, OPFS and browser UI.
// Run from the repository root. No performance threshold is used in CI.
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

const directory = await mkdtemp(path.join(tmpdir(), 'bella-danmaku-benchmark-'));
let browser, server;
try {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30:duration=3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '60',
    '-bf',
    '2',
    '-pix_fmt',
    'yuv420p',
    path.join(directory, 'input.mp4'),
  ]);
  const {outputFiles} = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import {Input, BlobSource, MP4} from 'mediabunny';
      import {convertInput} from './src/media/export.js';
      import {createExportMetrics} from './src/media/export-metrics.js';
      import {createDanmakuCompositor as current} from './src/danmaku/compositor.js';
      import {createDanmakuCompositor as reference} from './tools/tests/fixtures/danmaku-compositor-reference.js';
      window.measure = async ({implementation, scene}) => {
        const input = new Input({source:new BlobSource(await (await fetch('/input.mp4')).blob()),formats:[MP4]});
        window.events = scene === 'empty' ? [] : Array.from({length:170},(_,i)=>({
          text:'这是一条用于测量绘制性能的弹幕 '+(i%20), time:-10+i*.08, order:i,
          mode:scene==='fixed'?5:(i%8===0?5:1), color:0xffffff,
        }));
        const compositor=await (implementation==='reference'?reference:current)({room:1}, {
          origin:0,start:0,end:3,sourceTime:t=>t,width:1920,height:1080,adjustment:0,
        });
        const started=performance.now();
        const metrics=createExportMetrics();
        try {
          await convertInput(input,{start:0,end:3,compositor,metrics});
          const seconds=(performance.now()-started)/1000;
          return {implementation,scene,seconds,fps:90/seconds,metrics:metrics.snapshot()};
        } finally {compositor.close();input.dispose();}
      };
    `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'synthetic-comments',
        setup(build) {
          build.onLoad({filter: /src\/danmaku\/archive\.js$/}, () => ({
            contents: `
        export async function loadComments(){return window.events}
        export function boundedFetch(){throw new Error('Unexpected emote request')}
        export function publicUrl(){} export function readJson(){}
        export function createCommentReader(){throw new Error('Unexpected streaming reader')}
        export function prepareComments(){throw new Error('Unexpected archive preparation')}
      `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const media = await readFile(path.join(directory, 'input.mp4'));
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/input.mp4' ? 'video/mp4' : 'text/html');
    response.end(request.url === '/input.mp4' ? media : '<!doctype html><body></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({content: outputFiles[0].text});
  for (const implementation of ['reference', 'current'])
    await page.evaluate(args => window.measure(args), {scene: 'empty', implementation});
  const results = [];
  for (const scene of ['empty', 'fixed', 'scrolling']) {
    // Alternate order after warmup, and report medians of three trials.
    for (const implementation of ['reference', 'current', 'current', 'reference', 'reference', 'current']) {
      const result = await page.evaluate(args => window.measure(args), {scene, implementation});
      results.push(result);
      console.log(JSON.stringify(result));
    }
    const median = implementation =>
      results
        .filter(item => item.scene === scene && item.implementation === implementation)
        .map(item => item.seconds)
        .sort((a, b) => a - b)[1];
    const referenceSeconds = median('reference'),
      currentSeconds = median('current');
    console.log(JSON.stringify({scene, referenceSeconds, currentSeconds, speedup: referenceSeconds / currentSeconds}));
  }
} finally {
  await browser?.close();
  server?.close();
  await rm(directory, {recursive: true, force: true});
}
