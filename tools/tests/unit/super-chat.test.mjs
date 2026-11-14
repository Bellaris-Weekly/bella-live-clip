import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readDanmaku, loadComments} from '../../../src/danmaku/archive.js';
import {DanmakuLayout, visibleComment} from '../../../src/danmaku/layout.js';
import {
  scText,
  scSpeed,
  SC_WAIT,
  MEMBER_WAIT,
  commentPreroll,
  anchorOf,
  capsuleFace,
  measureCapsule,
} from '../../../src/danmaku/super-chat.js';
import {textTokens} from '../../../src/danmaku/emotes.js';
import {avatarUrl, createAvatarCache} from '../../../src/danmaku/avatars.js';

const event = (kind, time, order, width = 200) => ({
  kind,
  time,
  order,
  width,
  text: 'hello',
  mode: 1,
  color: 0xffffff,
  ...(kind === 'sc' ? {price: 30} : {}),
});
const layout = (events, start = 0, height = 1080) =>
  new DanmakuLayout(events, {
    width: 1920,
    height,
    start,
    measure: item => ({width: item.width, height: 48}),
  });

test('SC truncation counts graphemes, flattens newlines, and keeps emoji intact', () => {
  const emoji = '👨‍👩‍👧‍👦';
  assert.equal(scText('字'.repeat(39) + emoji + 'more'), '字'.repeat(39) + emoji + '…');
  assert.equal(scText('e\u0301'.repeat(40)), 'e\u0301'.repeat(40));
  assert.equal(scText('  a\nb  '), 'a b');
});

test('short and long SCs use the same speed, scale with width, and roll off once', () => {
  const l = layout([event('sc', 0, 0, 100), event('sc', 0, 1, 1800)]);
  l.advance(1);
  assert.deepEqual(
    l.active.map(item => item.speed),
    [200, 200],
  );
  assert.equal(scSpeed(3840), 400);
  assert.equal(l.x(l.active[0], 1), l.x(l.active[1], 1));
  l.advance(12);
  assert.deepEqual(
    l.active.map(item => item.order),
    [1],
  );
  l.advance(25);
  assert.equal(l.active.length, 0);
});

test('mixed speeds never catch a leading comment in the same lane', () => {
  for (const [first, second] of [
    ['sc', undefined],
    [undefined, 'sc'],
  ]) {
    const l = layout([
      event(first, 0, 0, first === 'sc' ? 1800 : 100),
      event(second, 1, 1, second === 'sc' ? 100 : 1800),
    ]);
    for (let t = 0; t <= 22; t += 1 / 30) {
      const active = l.advance(t);
      if (active.length !== 2 || active[0].top !== active[1].top) continue;
      const [a, b] = [...active].sort((a, b) => a.started - b.started);
      assert.ok(l.x(b, t) - l.x(a, t) - a.width >= 50 - 1e-6);
    }
  }
});

test('SCs get queue priority, wait five seconds, and cannot block a smaller ordinary comment', () => {
  const l = layout([event(undefined, 0, 0), event('sc', 0, 1)], 0, 300);
  l.advance(0);
  assert.equal(l.active[0].kind, 'sc');
  const crowded = layout(
    Array.from({length: 12}, (_, i) => event('sc', 0, i, 1800)),
    0,
    300,
  );
  crowded.advance(2);
  assert.equal(crowded.dropped, 0);
  crowded.advance(SC_WAIT + 0.1);
  assert.ok(crowded.dropped > 0);
  const blocked = layout([event('sc', 0, 0), event(undefined, 0, 1)]);
  blocked.measure = item => ({width: item.width, height: item.kind === 'sc' ? 900 : 48});
  blocked.advance(0);
  assert.equal(blocked.active.length, 1);
  assert.equal(blocked.active[0].order, 1);
  assert.equal(visibleComment({...event('sc', 0, 0), text: '喜欢主播加关注，点点红包抽礼物'}), true);
});

test('long SC survives a cut beyond ordinary preroll and matches uninterrupted layout', () => {
  const events = [event('sc', 0, 1, 1900)];
  const continuous = layout(events);
  continuous.advance(18);
  const seek = layout(events, 18 - commentPreroll(1920, 1080));
  seek.advance(18);
  assert.equal(seek.active.length, 1);
  assert.deepEqual(seek.active, continuous.active);
  const narrow = commentPreroll(1080, 1920);
  assert.ok(narrow > commentPreroll(1920, 1080), 'portrait geometry needs a larger bounded lookback');
});

test('collector SC fields and receipt order reach the browser without merging equal text', async () => {
  const file = new Uint8Array(await readFile(new URL('../fixtures/super-chat.parquet', import.meta.url))).buffer;
  const rows = await readDanmaku(file);
  assert.equal(rows.length, 4);
  const paid = rows.filter(row => row.kind === 'sc');
  assert.equal(paid[0].price, 30);
  assert.equal(paid[0].mode, 1);
  assert.equal(paid[0].face, 'https://i0.hdslb.com/bfs/face/test.jpg');
  assert.equal(paid[1].face, null);
  const fetcher = async url =>
    new Response(
      url.endsWith('index.json')
        ? JSON.stringify({
            schemaVersion: 1,
            live: [{live_key: 'sc', part: 1, path: 'live-archive/v1/1/live/sc.parquet'}],
          })
        : file,
    );
  const events = await loadComments({room: 1, key: 'sc'}, {origin: 0, start: 90, end: 130, fetcher});
  assert.deepEqual(
    events.map(event => event.event_id),
    ['test:1', 'test:2', 'test:3', 'test:4'],
  );
  assert.equal(events[0].text, events[2].text);
  assert.ok(rows.filter(row => row.kind !== 'sc').every(row => row.uid === null || typeof row.uid === 'string'));
});

const BELLA = '672353429';

test('member comments are capsules: matched by UID, first in the queue, always scrolling', () => {
  assert.equal(anchorOf({uid: BELLA, text: 'hi'}).name, '贝拉');
  assert.equal(anchorOf({uid: 672353429, text: 'hi'}).name, '贝拉');
  assert.equal(anchorOf({uid: '1', text: 'hi'}), undefined);
  assert.equal(anchorOf({kind: 'sc', uid: BELLA}), undefined, 'a member SC stays an SC');
  assert.ok(avatarUrl(capsuleFace({uid: BELLA})));
  const member = {...event(undefined, 0, 2), uid: BELLA, mode: 4};
  const l = layout([event(undefined, 0, 0), event('sc', 0, 1), member]);
  l.advance(0);
  // Placement order decides lanes: member first (top lane), then SC, then ordinary.
  assert.deepEqual(
    l.active.map(item => [item.order, item.top]),
    [
      [2, 12],
      [1, 61],
      [0, 110],
    ],
  );
  assert.equal(l.active[0].mode, 1);
  assert.equal(l.active[0].speed, scSpeed(1920));
  assert.equal(visibleComment({...member, text: '喜欢主播加关注，点点红包抽礼物'}), true);
  assert.equal(visibleComment({...member, text: '   \u200c\u200d'}), false);
});

test('member bands are always two lines tall and lay out text and emotes', () => {
  const ink = {font: '', measureText: text => ({width: text.length * 32})};
  const tall = {width: 72, height: 72},
    small = {width: 36, height: 36};
  const assets = new Map([
    ['[tall]', tall],
    ['[dog]', small],
  ]);
  const measure = text => measureCapsule({uid: BELLA, text}, ink, 40, 'sans-serif', {assets, tokens: textTokens});
  const plain = measure('晚安[dog]');
  const [band, emote] = plain.parts;
  // 72px two-line emote + 2 * 3px inset; the 88px avatar overhangs; 8px glow.
  assert.equal(band.band, 78);
  assert.equal(band.avatarSize, 88);
  assert.equal(plain.height, 104);
  assert.equal(measure('拜拜[tall]').height, 104, 'a two-line emote fits without growing');
  assert.equal(measure('晚安').height, 104);
  assert.deepEqual(
    band.text.map(run => [run.text, run.x]),
    [['晚安', 109]],
  );
  assert.equal(emote.asset, small);
  assert.equal(emote.x, 109 + 64);
  assert.ok(plain.width >= emote.x + 36);
  assert.equal(band.color, '#db7d74');
  assert.equal(measure('[missing]').parts[0].text[0].text, '[missing]', 'unknown emotes stay text');
  const sc = measureCapsule({kind: 'sc', price: 30, text: '[tall]', uid: BELLA}, ink, 40, 'sans-serif', {
    assets,
    tokens: textTokens,
  });
  assert.equal(sc.parts.length, 1, 'SC text never loads emotes');
  assert.equal(sc.height, 48);
});

test('SCs of at least ¥30 queue by amount; cheaper SCs queue like ordinary comments', () => {
  const sc = (time, order, price) => ({...event('sc', time, order), price});
  const l = layout([event(undefined, 0, 0), sc(0, 1, 2), sc(0, 2, 30), sc(0, 3, 1000), sc(0, 4, 100)], 0, 1400);
  l.advance(0);
  assert.deepEqual(
    l.active.map(item => item.order),
    [3, 4, 2, 0, 1],
  );
  // A blocked wide member band does not hold back SCs.
  const member = {...event(undefined, 0, 0), uid: BELLA};
  const blocked = layout([member, sc(0, 1, 30)]);
  blocked.measure = item => ({width: item.width, height: item.uid === BELLA ? 900 : 48});
  blocked.advance(0);
  assert.deepEqual(
    blocked.active.map(item => item.order),
    [1],
  );
  blocked.advance(SC_WAIT + 1);
  assert.equal(blocked.dropped, 0, 'members wait longer than SCs');
  blocked.advance(MEMBER_WAIT + 0.1);
  assert.equal(blocked.dropped, 1);
});

test('avatar URLs allow only public Bilibili face thumbnails', () => {
  assert.equal(
    avatarUrl('http://i1.hdslb.com/bfs/face/test.jpg'),
    'https://i1.hdslb.com/bfs/face/test.jpg@192w_192h_1c.webp',
  );
  for (const kind of ['garb', 'baselabs']) assert.ok(avatarUrl(`https://i2.hdslb.com/bfs/${kind}/avatar.png`));
  for (const value of [
    '',
    'https://evil.test/bfs/face/a',
    'https://i0.hdslb.com.evil.test/bfs/face/a',
    'https://user:pass@i0.hdslb.com/bfs/face/a',
    'file:///bfs/face/a',
  ])
    assert.equal(avatarUrl(value), null);
});

test('avatar work is bounded, optional, cooled down on failure and released on close', async () => {
  const events = Array.from({length: 10}, (_, i) => ({kind: 'sc', face: `https://i0.hdslb.com/bfs/face/${i}.jpg`}));
  let active = 0,
    peak = 0,
    requests = 0;
  const cache = createAvatarCache({
    maxEntries: 5,
    fetcher: async (url, options) => {
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.credentials, 'omit');
      requests++;
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return new Response('', {status: 404});
    },
  });
  cache.prefetch(events);
  assert.equal(requests, 3, 'starts bounded background work without awaiting network');
  await cache.settled();
  assert.equal(peak, 3);
  assert.equal(requests, 5);
  cache.prefetch(events.slice(0, 5));
  await cache.settled();
  assert.equal(requests, 5, 'failed faces do not retry every frame');
  assert.equal(cache.get(events[0].face), null);
  cache.close();
  cache.prefetch(events);
  assert.equal(requests, 5);
});
