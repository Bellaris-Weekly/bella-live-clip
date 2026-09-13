import test from 'node:test';
import assert from 'node:assert/strict';
import { EncodedPacket } from 'mediabunny';
import { createAvcSplicer } from '../../../src/media/avc-parameter-sets.js';
import { avccUnits, createAvcConfiguration, joinAvcc, readAvcConfiguration, UnsupportedAvcError } from '../../../src/media/avc-packets.js';

const sourceSps = Buffer.from('6764002aacd940780227e5c05a808080a0000003002000000f11e30632c0', 'hex');
const sourcePps = Buffer.from('68efbcb0', 'hex');
const encoderSps = Buffer.from('2764002aac5680780227e59a80808081', 'hex');
const encoderPps = Buffer.from('28ee3cb0', 'hex');
const config = units => ({ codec: 'avc1.64002a', codedWidth: 1920, codedHeight: 1080, description: createAvcConfiguration(units).description });
const original = config([sourceSps, sourcePps]), boundary = config([encoderSps, encoderPps]);
const rbspBits = unit => [...unit.subarray(1)].filter((v, i, a) => !(i > 1 && v === 3 && a[i - 1] === 0 && a[i - 2] === 0)).map(v => v.toString(2).padStart(8, '0')).join('');
function read(bits, start = 0) { let zeros = 0; while (bits[start + zeros] === '0') zeros++; return { value: parseInt(bits.slice(start + zeros, start + zeros * 2 + 1), 2) - 1, end: start + zeros * 2 + 1 }; }
const id = unit => read(rbspBits(unit), (unit[0] & 31) === 7 ? 24 : 0).value;
const packet = unit => new EncodedPacket(joinAvcc([unit]), 'key', .125, 1 / 60);

for (const type of [1, 5]) test(`不同编码器参数共存，NAL ${type} 只改 PPS 编号并保留所有熵编码位与字节边界`, () => {
  const splice = createAvcSplicer(original, [boundary]);
  const sets = readAvcConfiguration(splice.decoderConfig.description).parameterSets;
  assert.ok(sets.some(unit => Buffer.from(unit).equals(sourceSps)));
  assert.ok(sets.some(unit => Buffer.from(unit).equals(sourcePps)));
  const pictureSets = sets.filter(unit => (unit[0] & 31) === 8);
  assert.deepEqual(pictureSets.map(id), [0, 15]);
  const sequenceSets = sets.filter(unit => (unit[0] & 31) === 7);
  assert.deepEqual(sequenceSets.map(id), [0, 1]);
  const ppsBits = rbspBits(pictureSets[1]);
  assert.equal(read(ppsBits, read(ppsBits).end).value, 1);
  // first_mb=0, slice_type=2, pps_id=0; rest is deliberately opaque, including
  // emulation prevention and trailing CABAC zero words.
  const nal = Uint8Array.from([0x60 | type, 0xb8, 0x97, 0, 0, 3, 1, 0x73, 0, 0]);
  const before = packet(nal), after = splice.normalize(before, 0);
  const rewritten = avccUnits(after.data, 4)[0];
  const oldBits = rbspBits(nal), newBits = rbspBits(rewritten);
  assert.equal(read(newBits, 4).value, 15);
  assert.equal(newBits.slice(13), oldBits.slice(5));
  assert.equal(newBits.length - oldBits.length, 8);
  assert.equal(after.timestamp, before.timestamp); assert.equal(after.duration, before.duration);
  assert.deepEqual(before.data, joinAvcc([nal]));
});

test('编号集合不是固定的 0→15：已占用 15 时自然分配 16，原始 PPS 不变', () => {
  const pps15 = Buffer.from('68086fbcb0', 'hex'); // ue(15), ue(0), opaque PPS suffix
  const with15 = config([sourceSps, sourcePps, pps15]);
  const splice = createAvcSplicer(with15, [boundary]);
  const sets = readAvcConfiguration(splice.decoderConfig.description).parameterSets.filter(unit => (unit[0] & 31) === 8);
  assert.deepEqual(sets.map(id), [0, 15, 16]);
  assert.deepEqual(sets[1], new Uint8Array(pps15));
  const nal = avccUnits(splice.normalize(packet(Uint8Array.from([0x65, 0xb8, 0x80])), 0).data, 4)[0];
  assert.equal(read(rbspBits(nal), 4).value, 16);
});

test('非零编码器 PPS 编号按自身长度分配，保持切片头后的全部位', () => {
  const original1 = config([sourceSps, Buffer.from('685bef2c', 'hex')]);
  const boundary1 = config([encoderSps, Buffer.from('685b8f2c', 'hex')]);
  const splice = createAvcSplicer(original1, [boundary1]);
  const unit = Uint8Array.from([0x65, 0xb5, 0x97, 0, 0, 3, 1, 0x80]);
  const changed = avccUnits(splice.normalize(packet(unit), 0).data, 4)[0];
  assert.equal(read(rbspBits(unit), 4).value, 1);
  assert.equal(read(rbspBits(changed), 4).value, 2);
  assert.equal(rbspBits(changed).slice(7), rbspBits(unit).slice(7));
  assert.equal(rbspBits(changed).length, rbspBits(unit).length);
});

test('相同首尾编码参数共享新编号；原片参数完全相同时不添加重复参数', () => {
  const splice = createAvcSplicer(original, [boundary, boundary]);
  assert.equal(readAvcConfiguration(splice.decoderConfig.description).parameterSets.length, 4);
  const p = packet(Uint8Array.from([0x65, 0xb8, 0x80]));
  assert.deepEqual(splice.normalize(p, 0).data, splice.normalize(p, 1).data);
  const same = createAvcSplicer(original, [original]);
  assert.equal(readAvcConfiguration(same.decoderConfig.description).parameterSets.length, 2);
  assert.deepEqual(same.normalize(p, 0).data, p.data);
});

test('首尾不同的编码参数都注册，PPS 引用各自 SPS，编号彼此独立', () => {
  const different = encoderSps.slice(); different[3] = 41;
  const splice = createAvcSplicer(original, [boundary, config([different, encoderPps])]);
  const sets = readAvcConfiguration(splice.decoderConfig.description).parameterSets;
  assert.deepEqual(sets.filter(unit => (unit[0] & 31) === 7).map(id), [0, 1, 2]);
  assert.deepEqual(sets.filter(unit => (unit[0] & 31) === 8).map(id), [0, 15, 16]);
});

test('只省略边界编码器可选 SEI，错误引用和损坏切片不会被包装成兜底成功', () => {
  const splice = createAvcSplicer(original, [boundary]);
  const p = new EncodedPacket(joinAvcc([Uint8Array.from([6, 0, 1, 0x80]), Uint8Array.from([0x65, 0xb8, 0x80])]), 'key', 0, .1);
  assert.equal(avccUnits(splice.normalize(p, 0).data, 4).length, 1);
  assert.throws(() => splice.normalize(packet(Uint8Array.from([0x65, 0xb4])), 0), error => !(error instanceof UnsupportedAvcError));
  assert.throws(() => splice.normalize(packet(Uint8Array.from([0x65, 0])), 0), error => !(error instanceof UnsupportedAvcError));
  assert.throws(() => createAvcSplicer(original, [{ ...boundary, codedWidth: 1280 }]), UnsupportedAvcError);
});
