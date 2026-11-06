import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
const fullHD = Boolean(process.env.STREAMING_TEST_1080P);
let directory, server, browser, origin, code, fixture, image;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bella-streaming-'));
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${fullHD ? '1920x1080' : '640x360'}:rate=30:duration=48`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=48',
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
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:size=128x128:duration=0.1',
    '-frames:v',
    '1',
    path.join(directory, 'flower.png'),
  ]);
  fixture = await readFile('tools/tests/fixtures/danmaku.parquet');
  image = await readFile(path.join(directory, 'flower.png'));
  code = (await build({entryPoints: ['tools/tests/e2e/streaming-page.js'], bundle: true, write: false, format: 'iife'}))
    .outputFiles[0].text;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        return response.end('<!doctype html><body></body>');
      }
      response.end(await readFile(path.join(directory, path.basename(request.url))));
    } catch {
      response.writeHead(404).end();
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
async function open() {
  const page = await browser.newPage();
  await page.route('https://data.bellaris.fans/**', route => {
    const url = route.request().url();
    const body = url.endsWith('flower.png')
      ? image
      : url.includes('live-archive')
        ? url.endsWith('index.json')
          ? JSON.stringify({
              schemaVersion: 1,
              live: [{live_key: 'test', part: 1, path: 'live-archive/v1/1/live/test.parquet'}],
            })
          : fixture
        : url.endsWith('index.json')
          ? JSON.stringify({catalog: 'catalog.json'})
          : JSON.stringify({emotes: [{name: '花', kind: 'emoji', file: 'flower.png', width: 128, height: 128}]});
    return route.fulfill({
      body,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': url.endsWith('.png') ? 'image/png' : 'application/octet-stream',
      },
    });
  });
  await page.goto(origin);
  await page.addScriptTag({content: code});
  return page;
}
test(
  'encoding begins while a later media segment is blocked, then completes a continuous clip',
  {timeout: fullHD ? 120000 : 60000},
  async () => {
    const page = await open();
    try {
      await page.evaluate(() => window.startStreaming({blockMedia: true}));
      await page.waitForFunction(
        () => window.streamingState.error || (window.streamingState.blockedMedia && window.streamingState.frames > 0),
        {timeout: 15000},
      );
      let state = await page.evaluate(() => window.streamingState);
      assert.equal(state.error, undefined, JSON.stringify(state));
      assert.ok(state.frames > 0);
      assert.equal(state.done, undefined);
      await page.evaluate(() => window.releaseStreamingMedia());
      await page.waitForFunction(() => window.streamingState.done, null, {timeout: fullHD ? 90000 : 30000});
      state = await page.evaluate(() => window.streamingState);
      assert.equal(state.error, undefined, JSON.stringify(state));
      assert.ok(Math.abs(state.result.duration - 42.1) < 0.1);
      assert.ok(state.result.videoTimes.length > 1200);
      assert.equal(state.result.decoded, true);
      assert.deepEqual(state.temporary, []);
      assert.ok(state.metrics.firstPacketMs > 0 && state.metrics.firstPacketMs < state.metrics.elapsedMs);
      for (const name of [
        'mediaRequest',
        'archiveSetup',
        'archiveRead',
        'sampleWait',
        'danmakuPrepare',
        'render',
        'encodeSubmit',
        'encoderFlush',
        'muxAdd',
        'fileWrite',
        'fileClose',
        'outputFinalize',
      ]) {
        assert.ok(state.metrics.stages[name].count > 0, name);
        assert.ok(state.metrics.stages[name].totalMs >= 0, name);
      }
      assert.equal(state.metrics.stages.mediaRequest.count, state.networkRequests);
      assert.equal(state.metrics.counters.mediaRequestBytes, state.mediaBytes);
      assert.equal(state.metrics.gauges.activeRequests.current, 0);
      assert.equal(state.metrics.stages.render.count, state.result.videoTimes.length);
      assert.equal(state.metrics.encoder.width, fullHD ? 1920 : 640);
      assert.deepEqual(state.metrics.gauges.downloadConcurrency, {current: 3, peak: 3});
    } finally {
      await page.close();
    }
  },
);
test(
  'canceling a blocked media window stops the pipeline and removes temporary snapshots',
  {timeout: 30000},
  async () => {
    const page = await open();
    try {
      await page.evaluate(() => window.startStreaming({blockMedia: true}));
      await page.waitForFunction(() => window.streamingState.blockedMedia && window.streamingState.frames > 0);
      await page.evaluate(() => window.cancelStreaming());
      await page.waitForFunction(() => window.streamingState.done);
      const state = await page.evaluate(() => window.streamingState);
      assert.equal(state.error.name, 'AbortError');
      assert.deepEqual(state.temporary, []);
    } finally {
      await page.close();
    }
  },
);
test(
  'blocked output stops media prefetch instead of downloading the remaining selection',
  {timeout: 60000},
  async () => {
    const page = await open();
    try {
      await page.evaluate(() => window.startStreaming({blockWrite: true}));
      await page.waitForFunction(() => window.streamingState.error || window.streamingState.blockedWrite);
      await page.waitForTimeout(400);
      const before = await page.evaluate(() => window.streamingState);
      assert.equal(before.error, undefined, JSON.stringify(before));
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => window.streamingState);
      assert.equal(after.requests.length, before.requests.length);
      assert.ok(new Set(after.requests).size < 22, JSON.stringify(after.requests));
      await page.evaluate(() => window.releaseStreamingWrite());
      await page.waitForFunction(() => window.streamingState.done, null, {timeout: 30000});
      const result = await page.evaluate(() => window.streamingState);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.deepEqual(result.temporary, []);
    } finally {
      await page.close();
    }
  },
);

test(
  'streaming and disk intermediates preserve identical native frame times and AAC packets',
  {timeout: 120000},
  async () => {
    const page = await open();
    try {
      for (const selection of [
        {start: 0.2, end: 42.3},
        {start: 6.04, end: 21.93},
      ]) {
        const outputs = [];
        for (const reference of [true, false]) {
          await page.evaluate(options => window.startStreaming(options), {reference, selection});
          await page.waitForFunction(() => window.streamingState.done, null, {timeout: 45000});
          const state = await page.evaluate(() => window.streamingState);
          assert.equal(state.error, undefined, JSON.stringify(state.error));
          outputs.push(state.result);
          assert.deepEqual(state.temporary, []);
        }
        assert.deepEqual(outputs[1].audioPackets, outputs[0].audioPackets);
        assert.deepEqual(outputs[1].videoTimes, outputs[0].videoTimes);
        assert.equal(outputs[1].duration, outputs[0].duration);
      }
    } finally {
      await page.close();
    }
  },
);

test(
  'future emote bytes prefetch without blocking earlier frames and demand waits for the same request',
  {timeout: 30000},
  async () => {
    const page = await open();
    try {
      await page.evaluate(() => window.startLazyResourceTest());
      await page.waitForFunction(() => window.lazyState.blocked);
      const before = await page.evaluate(() => window.lazyState);
      assert.equal(before.rendered, 4);
      assert.equal(before.beforeImages, 1);
      assert.equal(before.images, 1);
      assert.equal(before.done, undefined);
      await page.evaluate(() => window.releaseLazyResource());
      await page.waitForFunction(() => window.lazyState.done);
      const after = await page.evaluate(() => window.lazyState);
      assert.equal(after.error, undefined);
      assert.equal(after.rendered, 5);
    } finally {
      await page.close();
    }
  },
);

test('canceling a blocked output aborts all stages and cleans snapshots', {timeout: 30000}, async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.startStreaming({blockWrite: true}));
    await page.waitForFunction(() => window.streamingState.blockedWrite);
    await page.evaluate(() => window.cancelStreaming());
    await page.waitForFunction(() => window.streamingState.done);
    const result = await page.evaluate(() => window.streamingState);
    assert.equal(result.error.name, 'AbortError');
    assert.deepEqual(result.temporary, []);
  } finally {
    await page.close();
  }
});

test(
  'tail boundary requests cannot block startup and never prefetch past the confirmed keyframe',
  {timeout: fullHD ? 180000 : 60000},
  async () => {
    const page = await open();
    try {
      await page.evaluate(() => window.startStreaming({blockMedia: true, blockIndex: 21}));
      await page.waitForFunction(() => window.streamingState.blockedMedia || window.streamingState.error, null, {
        timeout: fullHD ? 90000 : 30000,
      });
      const blocked = await page.evaluate(() => window.streamingState);
      assert.equal(blocked.error, undefined, JSON.stringify(blocked.error));
      assert.ok(blocked.framesAtBlock > 0, 'encoding must precede the first tail request');
      await page.evaluate(() => window.releaseStreamingMedia());
      await page.waitForFunction(() => window.streamingState.done, null, {timeout: fullHD ? 90000 : 30000});
      const done = await page.evaluate(() => window.streamingState);
      assert.equal(done.error, undefined, JSON.stringify(done.error));
      assert.ok(done.requests.includes(22), 'decode dependencies include the next keyframe');
      assert.ok(!done.requests.includes(23), 'do not speculatively fetch past the confirmed boundary');
      assert.deepEqual(done.temporary, []);
    } finally {
      await page.close();
    }
  },
);

test('unused prefetch failures are isolated; required windows retry with the confirmed end and still report real errors', async () => {
  const page = await open();
  try {
    const result = await page.evaluate(() => window.checkWindowPolicies());
    assert.deepEqual(result.reads, [
      [-15, 10],
      [10, 20],
    ]);
    assert.deepEqual(result.retried, [
      [-15, 10],
      [10, 20],
      [10, 12],
    ]);
    assert.equal(result.requiredError, 'required window failed');
  } finally {
    await page.close();
  }
});

test(
  'idle emotes are reused across windows and evicted under byte pressure in LRU order',
  {timeout: 30000},
  async () => {
    const page = await open();
    try {
      assert.deepEqual(await page.evaluate(() => window.checkEmoteCache(false)), {0: 1});
      const pressure = await page.evaluate(() => window.checkEmoteCache(true));
      assert.equal(pressure[0], 2, 'the oldest idle asset must be evicted to respect the bitmap budget');
      assert.equal(pressure[20], 1, 'a recently used asset must remain cached');
    } finally {
      await page.close();
    }
  },
);

test('catalog prefetch overlaps earlier frames, retries on demand, and cancels cleanly', async () => {
  const page = await open();
  try {
    assert.deepEqual(await page.evaluate(() => window.checkCatalogPrefetch(false)), {
      before: {indexes: 1, images: 0},
      indexes: 2,
      images: 1,
      canceled: false,
    });
    assert.deepEqual(await page.evaluate(() => window.checkCatalogPrefetch(true)), {
      before: {indexes: 1, images: 0},
      indexes: 1,
      images: 0,
      canceled: true,
    });
  } finally {
    await page.close();
  }
});

test('emote catalog starts alongside the initial archive window', {timeout: 30000}, async () => {
  const page = await open();
  try {
    assert.deepEqual(await page.evaluate(() => window.checkInitialCatalogOverlap()), {
      catalogStarted: true,
      readStarted: true,
      count: 1,
    });
  } finally {
    await page.close();
  }
});

for (const kind of ['http', 'decode', 'catalog'])
  test(`${kind} emote failures render the original token pixel-identically to styled plain text`, async () => {
    const page = await open();
    try {
      const result = await page.evaluate(kind => window.checkEmoteFallbackPixels(kind), kind);
      assert.equal(result.equal, true);
      assert.equal(result.failures, 1);
      assert.equal(result.requests, 2);
    } finally {
      await page.close();
    }
  });

test(
  'permanent image failure still completes a danmaku export with audio and a fallback counter',
  {timeout: 60000},
  async () => {
    const page = await open();
    try {
      await page.route('https://data.bellaris.fans/emotes/flower.png', route =>
        route.fulfill({status: 404, body: '', headers: {'Access-Control-Allow-Origin': '*'}}),
      );
      await page.evaluate(() => window.startStreaming());
      await page.waitForFunction(() => window.streamingState.done, null, {timeout: 45000});
      const state = await page.evaluate(() => window.streamingState);
      assert.equal(state.error, undefined, JSON.stringify(state));
      assert.ok(state.result.videoTimes.length > 1200);
      assert.ok(state.result.audioPackets.length > 0);
      assert.equal(state.metrics.counters.emoteFailures, 1);
      assert.deepEqual(state.temporary, []);
    } finally {
      await page.close();
    }
  },
);
