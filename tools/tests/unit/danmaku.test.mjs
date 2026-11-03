import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {partOrigin, commentTime, firstVideoDecodeTime, sourceClock} from '../../../src/danmaku/clock.js';
import {readDanmaku, loadComments, archiveParts, boundedFetch, publicUrl} from '../../../src/danmaku/archive.js';
import {selectEmotes, emoteFrame} from '../../../src/danmaku/emotes.js';
import {DanmakuLayout} from '../../../src/danmaku/layout.js';

const fixture = new Uint8Array(await readFile(new URL('../fixtures/danmaku.parquet', import.meta.url))).buffer;

test('each replay part gets its own origin, whether PTS resets or continues', () => {
  const first = partOrigin({start_time: 1000, clockComplete: true}, 0);
  const reset = partOrigin({start_time: 1200, clockComplete: true}, 0);
  const continued = partOrigin({start_time: 1200, clockComplete: true}, 187);
  assert.equal(first, 1000.49);
  assert.equal(reset, 1200.49);
  assert.equal(continued, 1013.49);
  assert.equal(continued - first, 13);
  assert.throws(() => partOrigin({start_time: 1200, clockComplete: false}, 187), /整场开头/);
  assert.throws(() => partOrigin({start_time: 1200}, 187), /整场开头/);
});

test('comments use received milliseconds; sent fallback adds one second; positive adjustment delays', () => {
  assert.equal(commentTime({t: 110000, sent: 100000}, 100), 8);
  assert.equal(commentTime({sent: 109000}, 100), 8);
  assert.equal(commentTime({t: 110000}, 100, -0.5), 7.5);
  assert.equal(commentTime({t: 110000}, 100, 0.5), 8.5);
});

test('tfdt picks the video track, including version 1 timestamps', () => {
  const box = (name, content) => {
    const out = new Uint8Array(8 + content.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(name), 4);
    out.set(content, 8);
    return out;
  };
  const traf = (id, ticks) => {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(4, id);
    const time = new Uint8Array(12);
    time[0] = 1;
    new DataView(time.buffer).setBigUint64(4, BigInt(ticks));
    return box('traf', new Uint8Array([...box('tfhd', header), ...box('tfdt', time)]));
  };
  const bytes = box('moof', new Uint8Array([...traf(2, 42), ...traf(1, 9876543210)]));
  assert.equal(firstVideoDecodeTime(bytes, 1, 1000), 9876543.21);
  assert.throws(() => firstVideoDecodeTime(bytes, 3, 1000), /tfdt/);
});

test('temporary-file offsets restore native media time rather than manifest duration', () => {
  const clock = sourceClock([
    {start: 0, end: 6, sourceOffset: -700},
    {start: 6, end: 12, sourceOffset: -700},
  ]);
  assert.equal(clock(10), 710);
  assert.throws(() => clock(15), /映射/);
});

test('small collector-compatible Zstd/DELTA_BINARY_PACKED fixture reads only danmaku', async () => {
  const rows = await readDanmaku(fixture);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, '测试[花]');
  assert.equal(Number(rows[0].t), 100000);
  assert.equal(rows[1].t, null);
  assert.equal((await readDanmaku(fixture, {from: 101, to: 103}))[0].text, '置顶');
});

test('missing index/room/session is an archive error, while a real empty interval is allowed', async () => {
  assert.throws(() => archiveParts({schemaVersion: 1, sessions: []}, 'x'), /没有弹幕归档/);
  await assert.rejects(
    boundedFetch('https://example.test/', {fetcher: async () => new Response('', {status: 404})}),
    /没有弹幕归档/,
  );
  assert.equal((await readDanmaku(fixture, {from: 200})).length, 0);
});

test('live snapshot is fetched atomically, never with ranges or credentials', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({url, options});
    return new Response(
      url.endsWith('index.json')
        ? JSON.stringify({schemaVersion: 1, live: [{live_key: 'x', part: 1, path: 'live-archive/v1/1/live/x.parquet'}]})
        : fixture,
    );
  };
  const rows = await loadComments({room: 1, key: 'x'}, {origin: 0, start: 90, end: 110, fetcher});
  assert.equal(rows.length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.options.credentials === 'omit' && !request.options.headers));
});

const event = (time, order, mode = 1) => ({time, order, mode, text: '重复', color: 0xffffff});
const layout = (events, start = 0) =>
  new DanmakuLayout(events, {width: 1920, height: 1080, start, measure: () => ({width: 200, height: 54})});

test('layout is deterministic across different frame sampling schedules and retains repetitions', () => {
  const events = Array.from({length: 40}, (_, i) => event(i / 5, i));
  const a = layout(events),
    b = layout(events);
  for (let t = 0; t < 10; t += 0.04) a.advance(t);
  a.advance(10);
  b.advance(10);
  assert.deepEqual(a.active, b.active);
  assert.equal(a.dropped, b.dropped);
  assert.ok(a.active.length > 1);
});

test('same-mode FIFO expires after 1.5 seconds, bottom fixed uses at most two rows', () => {
  const l = layout(Array.from({length: 10}, (_, i) => event(0, i, 4)));
  l.advance(2);
  assert.deepEqual(
    l.active.map(item => item.order),
    [0, 1],
  );
  assert.equal(l.dropped, 8);
  l.advance(6);
  assert.equal(l.active.length, 0);
});

test('preroll includes comments already crossing the cut, with their elapsed animation phase', () => {
  const l = layout([event(5, 0), event(9, 1, 5)], -5);
  const active = l.advance(10);
  assert.equal(active.length, 2);
  assert.ok(l.x(active[0], 10) < 1920);
  assert.equal(active[0].started, 5);
});

test('only the three V4 promotional messages are filtered', () => {
  const l = layout([
    {...event(0, 0), text: '喜欢主播加关注，点点红包抽礼物'},
    {...event(0, 1), text: '红包'},
  ]);
  assert.equal(l.advance(0).length, 1);
  assert.equal(l.active[0].text, '红包');
});

test('emotes prefer current room, then official, then generic, with NFC names', () => {
  const entries = [
    {name: '[花]', kind: 'emoji', file: '花.webp'},
    {name: '[充电]', kind: 'upower', file: '充电.webp'},
    {name: '库', kind: 'library', file: '库.webp'},
    {name: '花', kind: 'official', file: 'official/花.webp'},
    {name: '花', kind: 'room', file: 'room/1/花.webp'},
    {name: '花', kind: 'room', file: 'room/2/花.webp'},
  ];
  assert.equal(selectEmotes({emotes: entries}, 1).get('[充电]').file, '充电.webp');
  assert.equal(selectEmotes({emotes: entries}, 1).get('[库]').file, '库.webp');
  assert.equal(selectEmotes({emotes: entries}, 1).get('[花]').file, 'room/1/花.webp');
  assert.equal(selectEmotes({emotes: entries}, 3).get('[花]').file, 'official/花.webp');
  assert.equal(emoteFrame({frames: ['a', 'b'], ends: [0.1, 0.3], loops: Infinity}, 0.45), 'b');
});

test('archive keys are rooted once; emote filenames resolve inside emotes', () => {
  assert.equal(
    publicUrl('live-archive/v1/1/a.parquet', 'live-archive/'),
    'https://data.bellaris.fans/live-archive/v1/1/a.parquet',
  );
  assert.equal(publicUrl('room/1/a.webp', 'emotes/'), 'https://data.bellaris.fans/emotes/room/1/a.webp');
  assert.throws(() => publicUrl('../a', 'emotes/'), /地址/);
});

test('only a full-session API request marks the part start as usable for the clock', async () => {
  const {BiliApi} = await import('../../../src/services/bilibili.js');
  const api = new BiliApi(async url => ({
    data: JSON.stringify({
      code: 0,
      data: {
        list: [
          {
            start_time: Number(new URL(url).searchParams.get('start_time')),
            end_time: 200,
            stream: 'https://example.test/v.m3u8',
          },
        ],
      },
    }),
  }));
  const record = {start: 100, uid: 1, key: 'test'};
  assert.equal((await api.clips(record, 0, 100))[0].clockComplete, true);
  const clipped = (await api.clips(record, 50, 100))[0];
  assert.equal(clipped.clockComplete, false);
  assert.throws(() => partOrigin(clipped, 50), /整场开头/);
});

test('sealed archives use ranges and never read gift/SC column payloads', async () => {
  const {parquetMetadataAsync} = await import('hyparquet');
  const metadata = await parquetMetadataAsync(fixture);
  const ranges = [];
  const fetcher = async (url, options) => {
    if (url.endsWith('index.json'))
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          sessions: [{live_key: 'x', part: 1, path: 'live-archive/v1/1/2026/x.parquet'}],
        }),
      );
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(match[1]),
      end = Number(match[2]) + 1;
    ranges.push([start, end]);
    return new Response(fixture.slice(start, end), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end - 1}/${fixture.byteLength}`,
        ETag: 'fixture',
      },
    });
  };
  const result = await loadComments({room: 1, key: 'x'}, {origin: 0, start: 90, end: 110, fetcher});
  assert.equal(result.length, 2);
  const excluded = metadata.row_groups.slice(1).flatMap(group =>
    group.columns.map(column => {
      const m = column.meta_data;
      const start = Number(m.dictionary_page_offset ?? m.data_page_offset);
      return [start, start + Number(m.total_compressed_size)];
    }),
  );
  // The footer can share a fetch with the final bytes; exclude the footer read.
  const payloadReads = ranges.filter(([, end]) => end < fixture.byteLength - metadata.metadata_length - 8);
  assert.ok(payloadReads.length > 1);
  assert.ok(payloadReads.every(([from, to]) => excluded.every(([start, end]) => to <= start || from >= end)));
});

test('an aborted archive load does not start a request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    boundedFetch('https://example.test/', {
      signal: controller.signal,
      fetcher: () => assert.fail('request after cancellation'),
    }),
    {name: 'AbortError'},
  );
});
