import test from 'node:test';
import assert from 'node:assert/strict';
import {pickLine} from '../../../src/preview/upload-route.js';
import {
  parseSchedule,
  beijingSchedule,
  videoTimePresets,
  calendarDays,
  shiftMonth,
} from '../../../src/preview/schedule.js';
import {BELLA_PRESET, PRESETS_KEY, readPresets, sameStyle} from '../../../src/preview/cover-presets.js';
import {createCover, drawCover} from '../../../src/preview/cover.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('upload selection favors actual throughput, probes serially, and sends only anonymous synthetic data', async () => {
  const requests = [];
  let active = 0,
    peak = 0;
  const chosen = await pickLine(
    {a: 'ping.bilivideo.com', b: 'upload.bilivideo.com'},
    {
      async request(request) {
        requests.push(request);
        const post = request.method === 'POST',
          fastPing = request.url.includes('ping');
        if (post) peak = Math.max(peak, ++active);
        await wait(post ? (fastPing ? 180 : 20) : fastPing ? 5 : 30);
        if (post) active--;
        return {status: 200};
      },
    },
  );
  assert.equal(chosen, 'b');
  assert.equal(peak, 1);
  const probes = requests.filter(request => request.method === 'POST');
  assert.equal(probes.length, 2);
  for (const probe of probes) {
    assert.equal(probe.body.size, 256 * 1024);
    assert.equal(new Uint8Array(await probe.body.arrayBuffer()).some(Boolean), false);
    assert.deepEqual(probe.headers, {'Content-Type': 'application/octet-stream'});
  }
  assert.ok(requests.every(request => request.signal.aborted));
});

test('selection bounds unresponsive transports and falls back to a reachable node when POST fails', async () => {
  const requests = [],
    start = performance.now();
  const chosen = await pickLine(
    {a: 'reject.bilivideo.com', b: 'hang.bilivideo.com', c: 'dead.bilivideo.com'},
    {
      request(request) {
        requests.push(request);
        if (request.method === 'GET' && !request.url.includes('dead')) return Promise.resolve({status: 200});
        if (request.url.includes('reject')) return Promise.resolve({status: 405});
        return new Promise(() => {}); // Includes an adapter that ignores cancellation.
      },
    },
  );
  assert.ok(['a', 'b'].includes(chosen));
  assert.ok(performance.now() - start < 6500);
  assert.ok(requests.every(request => request.signal.aborted));
});

test('selection filters nonofficial hosts, probes at most three uploads and skips single-node upload probes', async () => {
  const requests = [],
    transport = {
      request: async request => {
        requests.push(request);
        return {status: 200};
      },
    };
  await pickLine(
    {
      a: 'a.bilivideo.com',
      b: 'b.bilivideo.com',
      c: 'c.bilivideo.com',
      d: 'd.bilivideo.com',
      bad: 'x.bilivideo.com/evil',
      external: 'example.com',
    },
    transport,
  );
  assert.equal(requests.length, 7);
  assert.equal(requests.filter(request => request.method === 'POST').length, 3);
  assert.ok(requests.every(request => /^https:\/\/[abcd]\.bilivideo\.com\/OK$/.test(request.url)));
  requests.length = 0;
  assert.equal(await pickLine({a: 'a.bilivideo.com'}, transport), 'a');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(await pickLine({}, transport), null);
});

test('cancelling during a throughput probe returns promptly without selecting a stale route', async () => {
  const controller = new AbortController();
  let uploadSignal;
  let started;
  const start = new Promise(resolve => {
    started = resolve;
  });
  const choice = pickLine(
    {a: 'a.bilivideo.com', b: 'b.bilivideo.com'},
    {
      request(request) {
        if (request.method === 'GET') return Promise.resolve({status: 200});
        uploadSignal = request.signal;
        started();
        return new Promise(() => {});
      },
    },
    controller.signal,
  );
  await start;
  controller.abort();
  assert.equal(await choice, null);
  assert.equal(uploadSignal.aborted, true);
});

test('schedule helpers reject invalid dates and preserve Beijing semantics across midnight and year boundaries', () => {
  assert.equal(parseSchedule('2026-02-30T12:00'), null);
  assert.equal(parseSchedule('2026-11-15T24:00'), null);
  assert.equal(parseSchedule('2026-11-15T12:60'), null);
  const now = Date.parse('2026-12-31T15:55:20Z') / 1000;
  const presets = videoTimePresets(now);
  assert.equal(presets[0].value, '2027-01-01T00:05:20');
  assert.equal(presets.find(preset => preset.label === '07:17').value, '2027-01-01T07:17');
  assert.equal(beijingSchedule(parseSchedule(presets[0].value), true), presets[0].value);
  assert.equal(calendarDays('2026-11')[0], '2026-10-26');
  assert.equal(calendarDays('2026-11').length, 42);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('cover presets reload across composers, discard corrupt storage, and draw the selected stroke parameters', () => {
  const store = new Map(),
    get = (key, fallback) => store.get(key) ?? fallback,
    set = (key, value) => store.set(key, value);
  const cover = createCover({get, set});
  const custom = {
    id: 'custom',
    name: '自定义',
    style: {...BELLA_PRESET.style, color: '#123456', stroke: '#abcdef', strokeWidth: 0.1},
  };
  cover.savePresets([BELLA_PRESET, custom]);
  const reloaded = createCover({get, set});
  assert.equal(reloaded.presets.value.length, 2);
  assert.ok(sameStyle(reloaded.presets.value[1].style, {...custom.style, stroke: '#ABCDEF'}));
  reloaded.setText({...custom.style, value: '文字'});
  const strokes = [];
  const context = {
    fillRect() {},
    save() {},
    restore() {},
    fillText() {},
    measureText: text => ({width: text.length * 10}),
    strokeText() {
      strokes.push({color: this.strokeStyle, width: this.lineWidth});
    },
  };
  drawCover(context, reloaded.state.value, 'wide');
  assert.deepEqual(strokes, [{color: '#abcdef', width: 10.8}]);
  store.set(PRESETS_KEY, [custom, custom, {id: 'bad', name: 'bad', style: {}}]);
  assert.equal(readPresets(get).length, 2);
  assert.equal(
    readPresets(() => {
      throw new Error('blocked');
    }).length,
    1,
  );
  cover.reset();
  assert.equal(cover.state.value.text.value, '');
  assert.equal(cover.presets.value.length, 2, 'new clips keep saved styles but not old text');
});
