import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preciseVideoOptions } from '../../../src/media/encoding.js';

test('精确编码使用码率模式，按帧率和源码率分配画质预算，并检测硬件支持', async () => {
  const configs = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'VideoEncoder');
  let supported = true;
  Object.defineProperty(globalThis, 'VideoEncoder', { configurable: true, value: class {
    static async isConfigSupported(config) { configs.push(config); return { supported }; }
  } });
  try {
    for (const [width, height, fps, sourceBitrate, hardware] of [
      [1920, 1080, 60, 8000000, true],
      [1280, 720, 30, 20000000, true],
      [1280, 720, 24, 2000000, false],
    ]) {
      supported = hardware;
      const options = await preciseVideoOptions({
        getSquarePixelWidth: async () => width, getSquarePixelHeight: async () => height,
        computePacketStats: async () => ({ averagePacketRate: fps, averageBitrate: sourceBitrate }),
      });
      const config = configs.at(-1);
      assert.equal(config.bitrateMode, 'variable', '不能优先尝试会触发软件编码的量化模式');
      assert.ok(config.bitrate >= sourceBitrate * 2, '高码率素材也必须留出二次压缩余量');
      assert.ok(config.bitrate >= width * height * fps * 0.12, '高帧率素材需要相应增加预算');
      assert.equal(config.hardwareAcceleration, 'prefer-hardware');
      assert.equal(options.hardwareAcceleration, hardware ? 'prefer-hardware' : 'no-preference');
      assert.equal(options.codec, 'avc');
      assert.equal(options.frameRate, undefined, '不强制改变原始帧时间戳');
      assert.equal(options.width, undefined, '不缩小原始画面');
    }
    assert.equal(configs.length, 3, '每组配置只探测码率模式');
  } finally {
    if (original) Object.defineProperty(globalThis, 'VideoEncoder', original);
    else Reflect.deleteProperty(globalThis, 'VideoEncoder');
  }
});
