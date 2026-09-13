import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Output, BufferTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket, Input, BufferSource, MP4, EncodedPacketSink } from 'mediabunny';
import { planVideoCut, sameAvcConfiguration, trimPrecise } from '../../../src/media/smart-trim.js';
import { createAvcNormalizer } from '../../../src/media/avc-packets.js';
import { config } from '../support/synthetic-frame.mjs';

const decoderConfig = { ...config, description: new Uint8Array(Buffer.from(config.description, 'base64')) };
async function fixture(withAudio = false) {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source);
  const audio = withAudio && new EncodedAudioPacketSource('aac');
  if (audio) output.addAudioTrack(audio);
  await output.start();
  for (let i = 0; i < 300; i++) {
    const key = i % 60 === 0;
    await source.add(new EncodedPacket(new Uint8Array([0, 0, 0, 2, key ? 0x65 : 0x41, 0x88]), key ? 'key' : 'delta', i / 30, 1 / 30), { decoderConfig });
  }
  if (audio) {
    for (let i = 0; i < 469; i++) await audio.add(new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]),
      i % 2 ? 'delta' : 'key', i * 1024 / 48000, 1024 / 48000), { decoderConfig: {
        codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]),
      } });
    audio.close();
  }
  source.close(); await output.finalize();
  return new Input({ source: new BufferSource(output.target.buffer), formats: [MP4] });
}

for (const [start, end, headEnd, tailStart, middle] of [[.125, 7.875, 2, 6, true], [2.1, 3.9, 3.9, 3.9, false], [2, 6, 2, 6, true], [1.25, 10, 2, 10, true]]) {
  test(`裁剪规划按独立 GOP 边界而不是下载分片切割：${start}–${end}`, async () => {
    const input = await fixture();
    try {
      const track = await input.getPrimaryVideoTrack(), normalizer = createAvcNormalizer(await track.getDecoderConfig());
      const plan = await planVideoCut(track, { start, end, normalizer });
      assert.equal(plan.headEnd, headEnd); assert.equal(plan.tailStart, tailStart); assert.equal(Boolean(plan.first), middle);
    } finally { input.dispose(); }
  });
}

test('相同尺寸和 codec 不能代替完整参数集一致，所有描述字节都参与比较', () => {
  const base = { ...decoderConfig, description: decoderConfig.description.slice() };
  assert.equal(sameAvcConfiguration(decoderConfig, base), true);
  for (const index of [8, decoderConfig.description.length - 1]) {
    const altered = { ...base, description: base.description.slice() };
    altered.description[index] ^= 1;
    assert.equal(sameAvcConfiguration(decoderConfig, altered), false);
  }
  const padded = new Uint8Array(base.description.length + 8); padded.set(base.description, 4);
  assert.equal(sameAvcConfiguration(base, { ...base, description: new DataView(padded.buffer, 4, base.description.length) }), true);
  assert.equal(sameAvcConfiguration(base, { ...base, colorSpace: { fullRange: true } }), false);
  assert.equal(sameAvcConfiguration(base, { ...base, displayAspectWidth: 32, displayAspectHeight: 9 }), false);
});

test('音频预热从独立包开始，兼容关键包与依赖包交替的 AAC 轨道', async () => {
  const input = await fixture(true);
  try {
    const blob = await trimPrecise(input, { start: 2, end: 6 });
    const actual = new Input({ source: new BufferSource(await blob.arrayBuffer()), formats: [MP4] });
    try {
      const audio = await actual.getPrimaryAudioTrack(), first = await new EncodedPacketSink(audio).getFirstPacket();
      assert.equal(first.type, 'key');
      assert.ok(first.timestamp < 0, '预热包使用 MP4 编辑列表裁掉，不移动实际声音');
      assert.ok(Math.abs(await actual.computeDuration() - 4) < .001);
    } finally { actual.dispose(); }
  } finally { input.dispose(); }
});

test('精确关键帧边界无需浏览器编码器，保持全部原始包并保留输入所有权', async () => {
  const input = await fixture();
  try {
    const events = [], blob = await trimPrecise(input, { start: 2, end: 6, onProgress: (progress, detail) => events.push({ progress, ...detail }) });
    const actual = new Input({ source: new BufferSource(await blob.arrayBuffer()), formats: [MP4] });
    try {
      assert.equal(await actual.computeDuration(), 4);
      const track = await actual.getPrimaryVideoTrack(), packets = [];
      for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
      assert.equal(packets.length, 120); assert.equal(packets[0].timestamp, 0);
      assert.equal(events.at(-1).copiedFrames, 120); assert.equal(events.at(-1).encodedFrames, 0);
      assert.ok(events.every((event, i) => !i || event.progress >= events[i - 1].progress));
      assert.equal(await input.computeDuration(), 10);
    } finally { actual.dispose(); }
  } finally { input.dispose(); }
});

for (const codec of ['opus', 'mp3']) {
  test(`不把未支持的 ${codec} 音轨静默丢掉或输出时间偏移的重编码声音`, async () => {
    const input = { getTracks: async () => [
      { type: 'video', getCodec: async () => 'avc' }, { type: 'audio', getCodec: async () => codec },
    ] };
    await assert.rejects(trimPrecise(input, { start: 0, end: 1 }), /AAC/);
  });
}
