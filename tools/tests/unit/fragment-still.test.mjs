import {test} from 'node:test';
import assert from 'node:assert/strict';
import {firstMediaEnd} from '../../../src/media/fragment-still.js';
import {locateSegment} from '../../../src/media/playlist.js';
import {drawFitted, fittedRect} from '../../../src/shared/fit.js';

function boxes(...entries) {
  const bytes = new Uint8Array(entries.reduce((sum, [, size]) => sum + Math.min(size, 16), 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [type, size] of entries) {
    view.setUint32(offset, size);
    for (let i = 0; i < 4; i++) bytes[offset + 4 + i] = type.charCodeAt(i);
    offset += Math.min(size, 16);
  }
  return bytes;
}

test('the first media box is found from headers, wherever it ends', () => {
  const header = new Uint8Array(1600), view = new DataView(header.buffer);
  const write = (offset, type, size) => { view.setUint32(offset, size); for (let i = 0; i < 4; i++) header[offset + 4 + i] = type.charCodeAt(i); };
  write(0, 'ftyp', 32); write(32, 'moov', 1115); write(1147, 'moof', 408); write(1555, 'mdat', 511623);
  assert.equal(firstMediaEnd(header), 1555 + 511623);
});

test('headers that do not reach a media box are reported rather than guessed', () => {
  assert.equal(firstMediaEnd(boxes(['moov', 100000])), null);
  assert.equal(firstMediaEnd(boxes(['ftyp', 4])), null);
  assert.equal(firstMediaEnd(new Uint8Array(4)), null);
});

test('a recording time maps to its fragment across groups and gaps', () => {
  const a = {url: 'a', duration: 4}, b = {url: 'b', duration: 4}, c = {url: 'c', duration: 4};
  const groups = [{start: 100, segments: [a, b], map: 'first'}, {start: 200, segments: [c], map: 'second'}];
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
  assert.deepEqual(calls, [[0, 0, 160, 90], [54.6875, 0, 50.625, 90]]);
});
