import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputVideoTrack, Output, VideoSample, VideoSampleSink } from 'mediabunny';
import { readVideoEncodingSettings, encodeVideoRange } from '../../../src/media/encoding.js';
import { config as fixtureConfig, frame as fixtureFrame } from '../support/synthetic-frame.mjs';

const decoderConfig = { ...fixtureConfig, description: new Uint8Array(Buffer.from(fixtureConfig.description, 'base64')) };
const frameBytes = new Uint8Array(Buffer.from(fixtureFrame, 'base64'));

function globalMock(t, key, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
}

function track({ width = 16, height = 16, fps = 30, bitrate = 240000, codec = decoderConfig.codec } = {}) {
  const calls = [];
  const video = new InputVideoTrack({}, {
    getCodedWidth: () => width, getCodedHeight: () => height,
    getSquarePixelWidth: () => width, getSquarePixelHeight: () => height,
    getDecoderConfig: () => ({ ...decoderConfig, codec, codedWidth: width, codedHeight: height }),
  });
  video.computePacketStats = async count => { calls.push(count); return { averagePacketRate: fps, averageBitrate: bitrate }; };
  return { video, calls };
}

function webCodecs(t, { supported = () => true, onEncode = () => {}, hold = false } = {}) {
  const probes = [], configured = [], encoders = [], frames = [];
  class Frame {
    constructor(data, options) { Object.assign(this, options); this.closed = false; frames.push(this); }
    close() { this.closed = true; }
  }
  class Chunk {
    constructor(frame, key) { this.timestamp = frame.timestamp; this.duration = frame.duration; this.type = key ? 'key' : 'delta'; this.byteLength = frameBytes.length; }
    copyTo(bytes) { bytes.set(frameBytes); }
  }
  class Encoder extends EventTarget {
    static async isConfigSupported(config) { probes.push({ ...config }); return { supported: supported(config), config }; }
    constructor(callbacks) { super(); this.callbacks = callbacks; this.state = 'unconfigured'; this.queue = []; this.encodeQueueSize = 0; this.emitted = 0; this.maxQueue = 0; encoders.push(this); }
    configure(config) { configured.push({ ...config }); this.state = 'configured'; }
    encode(frame, options) {
      assert.equal(frame.closed, false);
      this.queue.push(new Chunk(frame, options?.keyFrame));
      this.encodeQueueSize++;
      this.maxQueue = Math.max(this.maxQueue, this.encodeQueueSize);
      onEncode(this);
      if (!hold && this.queue.length >= 3) queueMicrotask(() => this.drain());
    }
    drain() {
      if (this.state === 'closed') return;
      for (const chunk of this.queue.splice(0)) {
        this.callbacks.output(chunk, this.emitted++ ? undefined : { decoderConfig });
        this.encodeQueueSize--;
      }
      this.dispatchEvent(new Event('dequeue'));
    }
    async flush() { this.drain(); }
    close() { this.state = 'closed'; this.queue.length = 0; this.encodeQueueSize = 0; }
  }
  globalMock(t, 'VideoFrame', Frame);
  globalMock(t, 'EncodedVideoChunk', Chunk);
  globalMock(t, 'EncodedAudioChunk', class {});
  globalMock(t, 'VideoEncoder', Encoder);
  return { probes, configured, encoders, frames };
}

function sampleStream(t, timings) {
  const samples = [], ranges = [];
  let reads = 0, returned = false;
  t.mock.method(VideoSampleSink.prototype, 'samples', (start, end) => {
    ranges.push([start, end]);
    return {
      async next() {
        if (reads === timings.length || returned) return { done: true };
        const [timestamp, duration] = timings[reads++];
        const sample = new VideoSample(new Uint8Array(16 * 16 * 4), { format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp, duration });
        samples.push(sample);
        return { value: sample, done: false };
      },
      async return() { returned = true; return { done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  });
  return { samples, ranges, get reads() { return reads; }, get returned() { return returned; } };
}

for (const [fps, bitrate] of [[30, 240001.3], [60, 8000000], [30000 / 1001, 2100000], [27.417, 20000000]]) {
  test(`源码率 ${bitrate} 与 ${fps} fps 提示进入实际编码器，同时保留裁剪帧时间`, async t => {
    const native = webCodecs(t);
    const { video, calls } = track({ fps, bitrate });
    const settings = await readVideoEncodingSettings(video);
    const source = sampleStream(t, [[.9, .2], [1.1, .0273], [1.1273, .0541], [1.1814, .02]]);
    const metadata = t.mock.method(Output.prototype, 'addVideoTrack');
    const packets = [];
    for await (const value of encodeVideoRange(video, { start: 1.00571, end: 1.19001, origin: 1.00571, settings })) packets.push(value);
    assert.deepEqual(calls, [120], '只读取有限前缀统计，不能扫描整段');
    assert.equal(settings.canSplice, true);
    for (const config of [...native.probes, ...native.configured]) {
      assert.equal(config.bitrate, Math.round(bitrate));
      assert.equal(config.bitrateMode, 'variable');
      assert.equal(config.framerate, fps);
      assert.equal(config.latencyMode, 'quality');
    }
    assert.equal(metadata.mock.calls[0].arguments[1], undefined, '输出轨不能设置会量化时间戳的 frameRate');
    assert.equal(packets.length, 4);
    const expected = [[1.00571, 1.1], [1.1, 1.1273], [1.1273, 1.1814], [1.1814, 1.19001]];
    packets.forEach(({ packet, decoderConfig: actualConfig }, i) => {
      assert.ok(Math.abs(packet.timestamp - (expected[i][0] - 1.00571)) < 1e-12);
      assert.ok(Math.abs(packet.duration - (expected[i][1] - expected[i][0])) < 1e-12);
      assert.equal(actualConfig, decoderConfig);
    });
    assert.equal(packets[0].packet.type, 'key');
    assert.ok(native.frames.every(frame => frame.closed));
    assert.ok(native.encoders.every(encoder => encoder.state === 'closed'));
    assert.ok(source.returned);
  });
}

test('硬件无法支持源码配置时选择同配置的软件编码，不把不兼容编码器标成可拼接', async t => {
  const native = webCodecs(t, { supported: config => config.hardwareAcceleration === 'no-preference' });
  const settings = await readVideoEncodingSettings(track({ codec: 'avc3.64002a' }).video);
  assert.equal(settings.encodingOptions.hardwareAcceleration, 'no-preference');
  assert.equal(settings.encodingOptions.fullCodecString, 'avc1.64002a');
  assert.equal(settings.canSplice, true);
  assert.deepEqual(native.probes.map(config => config.hardwareAcceleration), ['prefer-hardware', 'no-preference']);
});

test('特殊 AVC 与非 AVC 均使用自动 H264 回退，并沿用源码率及非整数 fps', async t => {
  const native = webCodecs(t, { supported: config => config.codec !== 'avc1.6e0033' });
  for (const codec of ['avc1.6e0033', 'vp09.00.10.08']) {
    const settings = await readVideoEncodingSettings(track({ codec, fps: 59.94, bitrate: 3100001 }).video);
    assert.equal(settings.canSplice, false);
    assert.equal(settings.encodingOptions.fullCodecString, undefined);
    assert.equal(settings.bitrate, 3100001);
    const config = {};
    settings.encodingOptions.onEncoderConfig(config);
    assert.equal(config.framerate, 59.94);
  }
  assert.ok(native.probes.length >= 3);
});

test('长选区边处理边出包，并通过编码器背压约束读入，不收集整个选区', async t => {
  const native = webCodecs(t);
  const source = sampleStream(t, Array.from({ length: 200 }, (_, i) => [i / 30, 1 / 30]));
  const output = encodeVideoRange(track().video, { start: 0, end: 200 / 30 });
  const first = await output.next();
  assert.equal(first.done, false);
  assert.ok(source.reads <= 4, '第一批输出发生时不得读取完整选区');
  await output.return();
  assert.ok(source.returned);
  assert.ok(native.encoders.every(encoder => encoder.maxQueue <= 4 && encoder.state === 'closed'));
  assert.ok(native.frames.every(frame => frame.closed));
});

test('取消卡在背压中的编码立即退出并释放资源，下一次导出仍可成功', async t => {
  const controller = new AbortController(), reason = new Error('用户取消');
  const native = webCodecs(t, { hold: true, onEncode(encoder) { if (encoder.encodeQueueSize === 4) queueMicrotask(() => controller.abort(reason)); } });
  const source = sampleStream(t, Array.from({ length: 20 }, (_, i) => [i / 30, 1 / 30]));
  const add = t.mock.method(controller.signal, 'addEventListener');
  const remove = t.mock.method(controller.signal, 'removeEventListener');
  await assert.rejects(async () => {
    for await (const ignored of encodeVideoRange(track().video, { start: 0, end: 1, signal: controller.signal })) assert.fail(ignored);
  }, error => error === reason);
  assert.ok(source.returned);
  assert.ok(native.frames.every(frame => frame.closed));
  assert.ok(native.encoders.every(encoder => encoder.state === 'closed'));
  assert.equal(add.mock.callCount(), remove.mock.callCount());
  t.mock.restoreAll();
  sampleStream(t, [[0, .02], [.02, .03]]);
  const retry = [];
  for await (const value of encodeVideoRange(track().video, { start: 0, end: .05 })) retry.push(value);
  assert.equal(retry.length, 2);
});

test('码率统计失败或预先取消不会启动编码', async t => {
  const native = webCodecs(t);
  await assert.rejects(readVideoEncodingSettings(track({ fps: 0, bitrate: 0 }).video), /没有可用的视频码率或帧率/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readVideoEncodingSettings(track().video, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(native.probes.length, 0);
});

test('编码失败保留原始错误，并关闭当帧、解码流和编码器', async t => {
  const failure = new Error('设备编码失败');
  const native = webCodecs(t, { onEncode() { throw failure; } });
  const source = sampleStream(t, [[0, .02], [.02, .03]]);
  await assert.rejects(async () => {
    for await (const ignored of encodeVideoRange(track().video, { start: 0, end: .05 })) assert.fail(ignored);
  }, error => error === failure);
  assert.ok(source.returned);
  assert.ok(native.frames.every(frame => frame.closed));
  assert.ok(native.encoders.every(encoder => encoder.state === 'closed'));
  for (const sample of source.samples) assert.throws(() => sample.toVideoFrame(), /closed/);
});

for(const firstTimestamp of [.1,1.7])test(`精确导出遇到首帧前空区间时回退整段编码，保留 ${firstTimestamp} 秒画面偏移`,async t=>{
 const {Input,BufferSource,MP4,BufferTarget,Mp4OutputFormat,EncodedVideoPacketSource,EncodedPacket}=await import('mediabunny');
 const {trimPrecise}=await import('../../../src/media/smart-trim.js');
 const native=webCodecs(t),source=new EncodedVideoPacketSource('avc');
 const original=new Output({format:new Mp4OutputFormat({fastStart:false}),target:new BufferTarget()});
 original.addVideoTrack(source);await original.start();
 for(let i=0;i<4;i++)await source.add(new EncodedPacket(frameBytes,'key',firstTimestamp+i*.1,.1),{decoderConfig});
 source.close();await original.finalize();
 const input=new Input({source:new BufferSource(original.target.buffer),formats:[MP4]}),ranges=[],samples=[],events=[];
 t.mock.method(InputVideoTrack.prototype,'canDecode',async()=>true);
 t.mock.method(VideoSampleSink.prototype,'samples',function(start,end){
  ranges.push([start,end]);
  return (async function*(){for(let i=0;i<4;i++){
   const timestamp=firstTimestamp+i*.1;
   if(timestamp>=end)break;
   const sample=new VideoSample(new Uint8Array(16*16*4),{format:'RGBA',codedWidth:16,codedHeight:16,timestamp,duration:.1});
   samples.push(sample);yield sample;
  }})();
 });
 try{
  const blob=await trimPrecise(input,{start:0,end:firstTimestamp+.35,onProgress:(progress,detail)=>events.push({progress,...detail})});
  assert.ok(blob.size>0);assert.equal(events.at(-1).strategy,'full');
  assert.ok(events.some(e=>e.message?.includes('整段编码')));
  assert.deepEqual(ranges,[[0,firstTimestamp],[0,firstTimestamp+.35]],'空边界之后从完整选区重新解码');
  assert.equal(native.frames.length,4);assert.equal(native.frames[0].timestamp,Math.trunc(firstTimestamp*1e6));
  assert.ok(native.frames.every(frame=>frame.closed));
  for(const sample of samples)assert.throws(()=>sample.toVideoFrame(),/closed/);
 }finally{input.dispose();}
});

test('精确模式整段回退仍没有解码画面时不能交付空视频',async t=>{
 const {trimPrecise}=await import('../../../src/media/smart-trim.js');
 webCodecs(t);
 const {video}=track();
 // A non-AVC input selects full encoding directly, then produces no samples.
 video.getCodec=async()=> 'vp9';video.canDecode=async()=>true;
 video.getLanguageCode=async()=> 'und';video.getName=async()=>null;video.getDisposition=async()=>({});video.getRotation=async()=>0;
 sampleStream(t,[]);
 await assert.rejects(trimPrecise({getTracks:async()=>[video]},{start:0,end:1}),/选区内没有可解码的画面/);
});
