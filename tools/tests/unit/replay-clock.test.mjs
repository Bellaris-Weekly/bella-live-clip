import test from 'node:test';
import assert from 'node:assert/strict';
import {partOrigin, replayToUtc, utcToReplay} from '../../../src/media/replay-clock.js';
import {markSelection} from '../../../src/preview/replay.js';

const parts = [
  {start_time: 1000, end_time: 1100, firstDecodeTime: 2700, clockComplete: true, index: 0},
  {start_time: 1120, end_time: 1240, firstDecodeTime: 0.75, clockComplete: true, index: 1},
].map(part => ({...part, origin: partOrigin(part, part.firstDecodeTime)}));

test('fixed whole-part clocks round trip without EXTINF accumulation, including a reset', () => {
  for (const part of parts)
    for (const position of [0, 0.1, 20, 75.25]) {
      const at = replayToUtc({part, position});
      assert.ok(Math.abs(at - (part.start_time + 0.49 + position) * 1000) < 0.000001);
      const back = utcToReplay(at, parts);
      assert.equal(back.part, part);
      assert.ok(Math.abs(back.position - position) < 0.000001);
      assert.equal(back.snapped, false);
    }
  assert.throws(() => partOrigin({start_time: 1050, clockComplete: false}, 2750), /整场/);
});

test('gaps and outside times snap to nearest footage; waits for the out-point and constrains crossing cuts', () => {
  assert.equal(utcToReplay(1109000, parts).part.index, 0);
  assert.equal(utcToReplay(1119000, parts).part.index, 1);
  assert.equal(utcToReplay(1119000, parts).position, 0);
  assert.equal(utcToReplay(1119000, parts).snapped, true);
  assert.equal(utcToReplay(999000, parts).position, 0);
  assert.equal(markSelection(1230000, 30, 15, parts), null);
  const selection = markSelection(1160000, 30, 15, parts);
  assert.equal(selection.part.index, 1);
  assert.ok(Math.abs(selection.start - 9.51) < 1e-9);
  assert.ok(Math.abs(selection.end - 54.51) < 1e-9);
  const crossing = markSelection(1130000, 50, 15, parts);
  assert.equal(crossing.start, 0);
  assert.equal(crossing.snapped, true);
});

test('a selection wholly inside a long outage still selects footage at its nearest boundary', () => {
  const later = {...parts[1], start_time: 1500, end_time: 1600};
  later.origin = partOrigin(later, later.firstDecodeTime);
  const gapParts = [parts[0], later];
  const before = markSelection(1200000, 30, 15, gapParts),
    after = markSelection(1450000, 30, 15, gapParts);
  assert.equal(before.part.index, 0);
  assert.equal(before.snapped, true);
  assert.ok(before.end > before.start);
  assert.equal(after.part.index, 1);
  assert.equal(after.start, 0);
  assert.ok(after.end > after.start);
  assert.throws(() => markSelection(1050000, 0, 0, parts), /余量/);
});
