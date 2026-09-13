import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncodedPacket } from 'mediabunny';
import { createAvcNormalizer, UnsupportedAvcError } from '../../../src/media/avc-packets.js';

const bytes = value => Uint8Array.from(value);
const sps = bytes([103, 100, 0, 31, 172, 217, 64, 80, 5, 187, 1, 16, 0, 0, 3, 0, 16, 0, 0, 3, 3, 192, 241, 131, 25, 96]);
const pps = bytes([104, 234, 224, 140, 178, 44]);
const idr = bytes([0x65, 0x88, 0x80, 0x21]);
const delta = bytes([0x41, 0x9a, 0x24, 0x60]);
const sei = bytes([0x06, 0x06, 0x01, 0xc0, 0x80]);

function configuration({ lengthSize = 4, sequence = [sps], pictures = [pps], extensions = [] } = {}) {
  const data = [1, sequence[0][1], sequence[0][2], sequence[0][3], 0xfc | (lengthSize - 1), 0xe0 | sequence.length];
  const add = group => group.forEach(unit => data.push(unit.length >> 8, unit.length & 255, ...unit));
  add(sequence); data.push(pictures.length); add(pictures);
  if ([100, 110, 122, 144].includes(sequence[0][1])) {
    data.push(0xfd, 0xf8, 0xf8, extensions.length); add(extensions);
  }
  return bytes(data);
}

function avcc(units, lengthSize = 4) {
  const data = [];
  for (const unit of units) {
    for (let index = lengthSize - 1; index >= 0; index--) data.push(Math.floor(unit.length / 256 ** index) & 255);
    data.push(...unit);
  }
  return bytes(data);
}

function annexB(units) {
  return bytes([0, ...units.flatMap((unit, index) => [...(index % 2 ? [0, 0, 1] : [0, 0, 0, 1]), ...unit]), 0, 0]);
}

function packet(data, type = 'key') {
  return new EncodedPacket(data, type, 12.375, 1 / 60, 49);
}

test('AVC 的 1、2、4 字节长度都规范成 4 字节，并保留视频数据与时间信息', () => {
  for (const lengthSize of [1, 2, 4]) {
    const description = configuration({ lengthSize });
    const config = { codec: 'avc3.64001f', codedWidth: 1280, codedHeight: 720, description,
      colorSpace: { primaries: 'bt709' }, displayAspectWidth: 16, displayAspectHeight: 9 };
    const normalizer = createAvcNormalizer(config);
    const source = packet(avcc([sei, idr], lengthSize));
    const result = normalizer.normalize(source);
    assert.equal(normalizer.isIdr(source), true);
    assert.deepEqual(result.data, avcc([sei, idr]));
    assert.equal(result.timestamp, source.timestamp);
    assert.equal(result.duration, source.duration);
    assert.equal(result.sequenceNumber, source.sequenceNumber);
    assert.equal(normalizer.decoderConfig.codec, 'avc1.64001f');
    assert.deepEqual(normalizer.decoderConfig.description, configuration());
    assert.equal(normalizer.decoderConfig.displayAspectWidth, 16);
    assert.equal(normalizer.decoderConfig.colorSpace, config.colorSpace);
    assert.equal(description[4] & 3, lengthSize - 1, '不能改写输入的解码配置');
    if (lengthSize === 4) assert.equal(result, source, '无须转换的包不复制视频数据');
  }
});

test('AVC 参数集移入描述，已知多个 SPS/PPS 和扩展参数均可重复出现', () => {
  const secondSps = bytes([103, 100, 0, 42, 172, 217, 64, 120, 2, 39, 229, 192, 90, 128, 128, 128, 160, 0, 0, 3, 0, 32, 0, 0, 15, 17, 227, 6, 50, 192]);
  const secondPps = bytes([104, 239, 188, 176]);
  const extension = bytes([0x6d, 0x80]);
  const description = configuration({ sequence: [sps, secondSps], pictures: [pps, secondPps], extensions: [extension] });
  const normalizer = createAvcNormalizer({ codec: 'avc1.64001f', description });
  for (const parameters of [[sps, pps], [secondSps, secondPps, extension]]) {
    const result = normalizer.normalize(packet(avcc([...parameters, sei, idr])));
    assert.deepEqual(result.data, avcc([sei, idr]));
    assert.deepEqual(normalizer.decoderConfig.description, description);
  }
});

test('关键帧只取决于 NAL 5，不能信任容器标记或 Recovery Point SEI', () => {
  const normalizer = createAvcNormalizer({ description: configuration() });
  const recoveryPoint = packet(avcc([sei, delta]), 'key');
  assert.equal(normalizer.isIdr(recoveryPoint), false);
  const repaired = normalizer.normalize(recoveryPoint);
  assert.equal(repaired.type, 'delta');
  assert.equal(repaired.data, recoveryPoint.data);
  const incorrectlyLabeled = packet(avcc([idr]), 'delta');
  assert.equal(normalizer.isIdr(incorrectlyLabeled), true);
  assert.equal(normalizer.normalize(incorrectlyLabeled).type, 'key');
});

test('Annex B 混合起始标记生成 High Profile avcC，并保留普通 NAL 的原始内容', () => {
  const first = packet(annexB([sps, pps, sei, idr]));
  const normalizer = createAvcNormalizer({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 }, first);
  assert.deepEqual(normalizer.decoderConfig.description, configuration());
  assert.deepEqual(normalizer.normalize(first).data, avcc([sei, idr]));
  assert.equal(normalizer.isIdr(first), true);
  const following = packet(annexB([delta]), 'delta');
  assert.equal(normalizer.isIdr(following), false);
  assert.deepEqual(normalizer.normalize(following).data, avcc([delta]));
});

test('另一种 Baseline Annex B 参数使用自身 profile/level，重复参数只保存一次', () => {
  const baselineSps = bytes([0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xb7, 0xfe, 0x05, 0x05, 0x05, 0x02]);
  const baselinePps = bytes([0x68, 0xce, 0x3c, 0x80]);
  const first = packet(annexB([baselineSps, baselinePps, baselineSps, idr]));
  const normalizer = createAvcNormalizer({ description: new Uint8Array() }, first);
  assert.equal(normalizer.decoderConfig.codec, 'avc1.42c01e');
  assert.deepEqual(normalizer.decoderConfig.description, configuration({ sequence: [baselineSps], pictures: [baselinePps] }));
  assert.deepEqual(normalizer.normalize(first).data, avcc([idr]));
});

test('读取 ArrayBufferView 的实际范围，不把前后无关字节带入解码描述', () => {
  const description = configuration();
  const padded = bytes([255, 255, ...description, 255]);
  const normalizer = createAvcNormalizer({ description: new DataView(padded.buffer, 2, description.length) });
  assert.deepEqual(normalizer.decoderConfig.description, description);
});

test('AVCC 和 Annex B 的未知 SPS、PPS、扩展变化都给出专用不支持结果', () => {
  const changedSps = sps.slice(); changedSps[3] = 42;
  const changedPps = pps.slice(); changedPps[2] ^= 1;
  const changedExtension = bytes([0x6d, 0x88]);
  for (const mode of ['avcc', 'annexB']) {
    const normalizer = mode === 'avcc'
      ? createAvcNormalizer({ description: configuration() })
      : createAvcNormalizer({}, packet(annexB([sps, pps, idr])));
    const wrap = mode === 'avcc' ? avcc : annexB;
    for (const changed of [changedSps, changedPps, changedExtension]) {
      const source = packet(wrap([changed, idr]));
      assert.throws(() => normalizer.normalize(source), UnsupportedAvcError);
      assert.throws(() => normalizer.isIdr(source), UnsupportedAvcError);
    }
    assert.deepEqual(normalizer.normalize(packet(wrap([sps, pps, idr]))).data, avcc([idr]), '失败的包不能污染原有配置');
  }
});

test('缺少参数时报告无法复用，损坏的数据保持解析错误而不是触发重编码兜底', () => {
  assert.throws(() => createAvcNormalizer({}, packet(annexB([idr]))), UnsupportedAvcError);
  assert.throws(() => createAvcNormalizer({}), UnsupportedAvcError);
  const avc = createAvcNormalizer({ description: configuration() });
  const annex = createAvcNormalizer({}, packet(annexB([sps, pps, idr])));
  const parseError = error => error instanceof Error && !(error instanceof UnsupportedAvcError);
  for (const data of [bytes([0, 0]), bytes([0, 0, 0, 10, 0x65]), bytes([0, 0, 0, 0]), bytes([])]) {
    assert.throws(() => avc.normalize(packet(data)), parseError);
  }
  for (const data of [bytes([0x65, 0x88]), bytes([0xff, 0, 0, 1, 0x65]), bytes([0, 0, 1])]) {
    assert.throws(() => annex.normalize(packet(data)), parseError);
  }
  assert.throws(() => createAvcNormalizer({ description: configuration().subarray(0, 9) }), parseError);
});
