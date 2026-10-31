import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openingLayout} from '../../../src/media/fragment-still.js';
import {locateSegment} from '../../../src/media/playlist.js';
import {drawFitted, fittedRect} from '../../../src/shared/fit.js';

// ftyp, moov and a moof with audio first and a large keyframe, as real replays have.
function fragment({moofBase = true, sampleSizes = true} = {}) {
  const bytes = new Uint8Array(2000),
    view = new DataView(bytes.buffer);
  const write = (offset, type, size) => {
    view.setUint32(offset, size);
    for (let i = 0; i < 4; i++) bytes[offset + 4 + i] = type.charCodeAt(i);
  };
  write(0, 'ftyp', 32);
  write(32, 'moov', 1115);
  const moof = 1147,
    traf = (offset, dataOffset, size) => {
      write(offset, 'traf', 60);
      write(offset + 8, 'tfhd', 16);
      view.setUint32(offset + 16, moofBase ? 0x20002 : 2);
      write(offset + 24, 'trun', 36);
      view.setUint32(offset + 32, sampleSizes ? 0xb05 : 0x905);
      view.setUint32(offset + 36, 12);
      view.setInt32(offset + 40, dataOffset);
      view.setUint32(offset + 48, sampleSizes ? size : 1);
      view.setUint32(offset + 48 + 4, size);
    };
  write(moof, 'moof', 136);
  traf(moof + 8, 416, 700);
  traf(moof + 68, 8000, 400000);
  write(moof + 136, 'mdat', 511623);
  return bytes;
}

test('the first keyframe ends well before the first media box', () => {
  assert.deepEqual(openingLayout(fragment()), {pictureEnd: 1147 + 8000 + 400000, mediaEnd: 1283 + 511623});
});

test('run tables that do not give positions fall back to the whole media box', () => {
  assert.deepEqual(openingLayout(fragment({moofBase: false})), {pictureEnd: 1283 + 511623, mediaEnd: 1283 + 511623});
});

test('headers that do not reach a media box are reported rather than guessed', () => {
  const only = new Uint8Array(16);
  new DataView(only.buffer).setUint32(0, 100000);
  only.set([109, 111, 111, 118], 4);
  assert.equal(openingLayout(only), null);
  assert.equal(openingLayout(new Uint8Array(4)), null);
});

test('a recording time maps to its fragment across groups and gaps', () => {
  const a = {url: 'a', duration: 4},
    b = {url: 'b', duration: 4},
    c = {url: 'c', duration: 4};
  const groups = [
    {start: 100, segments: [a, b], map: 'first'},
    {start: 200, segments: [c], map: 'second'},
  ];
  assert.deepEqual(locateSegment(groups, 100), {segment: a, map: 'first'});
  assert.deepEqual(locateSegment(groups, 107.9), {segment: b, map: 'first'});
  assert.deepEqual(locateSegment(groups, 201), {segment: c, map: 'second'});
  for (const time of [99, 150, 300]) assert.equal(locateSegment(groups, time), null);
});

test('frames keep their shape inside a landscape thumbnail', () => {
  assert.deepEqual(fittedRect(1920, 1080, 160, 90), {x: 0, y: 0, width: 160, height: 90});
  assert.deepEqual(fittedRect(1080, 1920, 160, 90), {x: 54.6875, y: 0, width: 50.625, height: 90});
  assert.deepEqual(fittedRect(0, 0, 160, 90), {x: 0, y: 0, width: 160, height: 90});
  const calls = [];
  drawFitted({fillRect: (...args) => calls.push(args)}, (...rect) => calls.push(rect), 1080, 1920, 160, 90);
  assert.deepEqual(calls, [
    [0, 0, 160, 90],
    [54.6875, 0, 50.625, 90],
  ]);
});
