import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Output, BufferTarget, Mp4OutputFormat, MpegTsOutputFormat, EncodedVideoPacketSource,
  EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, Input, BlobSource, MP4,
} from 'mediabunny';
import { exportSelection, convertInput } from '../../../src/media/export.js';
import { createSegmentLoader } from '../../../src/media/segment-loader.js';
import {saveRecording} from '../../../src/media/recording.js';
import {avccUnits} from '../../../src/media/avc-packets.js';
import {RequestError} from '../../../src/services/retry-request.js';
import { config, frame } from '../support/synthetic-frame.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const videoConfig = { ...config, description: new Uint8Array(Buffer.from(config.description, 'base64')) };
const videoFrame = new Uint8Array(Buffer.from(frame, 'base64'));
// One stereo AAC-LC silent packet generated with FFmpeg; no downloaded media.
const audioConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) };
const audioFrame = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);

async function fixture(offset = 0, kind = 'plain') {
  const output = new Output({ format: kind === 'ts' ? new MpegTsOutputFormat() : new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
  const video = new EncodedVideoPacketSource('avc'), audio = new EncodedAudioPacketSource('aac');
  output.addVideoTrack(video); output.addAudioTrack(audio);
  await output.start();
  await Promise.all([
    (async () => {
      for (let i = 0; i < 60; i++) await video.add(new EncodedPacket(videoFrame, 'key', offset + i / 30, 1 / 30), { decoderConfig: videoConfig });
      video.close();
    })(),
    (async () => {
      for (let i = 0; i < 93; i++) await audio.add(new EncodedPacket(audioFrame, 'key', offset + i * 1024 / 48000, 1024 / 48000), { decoderConfig: audioConfig });
      audio.close();
    })(),
  ]);
  await output.finalize();
  return new Uint8Array(output.target.buffer);
}
function split(data) {
  let cursor = 0;
  while (cursor < data.length) {
    const size = new DataView(data.buffer, data.byteOffset + cursor).getUint32(0);
    if (new TextDecoder().decode(data.subarray(cursor + 4, cursor + 8)) === 'moof') return [data.slice(0, cursor), data.slice(cursor)];
    cursor += size;
  }
  throw new Error('Missing moof');
}
async function sampleApi(kind, absolute = false) {
  const files = new Map(), segments = [];
  for (let i = 0; i < 6; i++) {
    const data = await fixture(10 + (absolute ? 2 * i : 0), kind);
    segments.push({ url: `part${i}`, duration: 2 });
    if (kind === 'map') {
      const [map, media] = split(data);
      files.set('map', map); files.set(`part${i}`, media);
    } else files.set(`part${i}`, data);
  }
  const starts = [], finishes = [];
  let active = 0, peak = 0;
  return {
    starts, finishes, segments, get peak() { return peak; }, get active() { return active; },
    groups: [{ start: 100, streamEnd: 112, segments, map: kind === 'map' ? { url: 'map' } : null }],
    async request(url, { signal }) {
      starts.push(url); active++; peak = Math.max(peak, active);
      try {
        signal.throwIfAborted();
        await this.beforeRead?.(url, signal);
        signal.throwIfAborted();
        const data = files.get(url);
        finishes.push(url);
        return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
      } finally { active--; }
    },
  };
}
async function inspect(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const tracks = await input.getTracks(), counts = {};
    for (const track of tracks) {
      let count = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) { assert.ok(packet.data.length); count++; }
      counts[track.type] = count;
    }
    return { counts, duration: await input.computeDuration() };
  } finally { input.dispose(); }
}

for(const [kind,absolute]of [['plain',false],['map',true],['ts',true]]){
  test(`整场直接复制音视频包，清单偏差不改变实际帧数和时长（${kind}）`,async()=>{
    const api=await sampleApi(kind,absolute),writes=[];let opened=0,closed=0;
    const file={async createWritable(){opened++;return {
      async write(chunk){writes.push({...chunk,data:chunk.data.slice()});},async close(){closed++;},
      async abort(){assert.fail('export should not abort');},
    };}};
    api.groups[0].segments.forEach(segment=>segment.duration=1.8);
    await saveRecording(api,api.groups,file);
    const bytes=new Uint8Array(Math.max(...writes.map(chunk=>chunk.position+chunk.data.length)));
    for(const chunk of writes)bytes.set(chunk.data,chunk.position);
    const result=await inspect(new Blob([bytes]));
    assert.deepEqual(result.counts,{video:360,audio:558});assert.ok(Math.abs(result.duration-12)<.05);
    assert.equal(opened,1);assert.equal(closed,1);
    assert.equal(api.starts.length,new Set(api.starts).size,'completed segments and shared init map must not be fetched again');
    const input=new Input({source:new BlobSource(new Blob([bytes])),formats:[MP4]});
    try{
      for(const track of await input.getTracks())for await(const packet of new EncodedPacketSink(track).packets()){
        if(track.type==='video'){
          const pictures=data=>avccUnits(data,4).filter(unit=>(unit[0]&31)>=1&&(unit[0]&31)<=5);
          assert.deepEqual(pictures(packet.data),pictures(videoFrame),'encoded picture payload must remain byte-identical');
        }else assert.deepEqual(packet.data,audioFrame,'encoded audio must remain byte-identical');
      }
    }finally{input.dispose();}
  });
}

for (const [kind, absolute] of [['plain', false], ['map', true], ['ts', false]]) {
  test(`选区在后续分片下载时已开始处理，保留音视频和时间轴（${kind}）`, async () => {
    const api = await sampleApi(kind, absolute), slow = deferred(), events = [];
    let overlapped = false;
    api.beforeRead = async url => { if (url === 'part1') await slow.promise; };
    const outputs = await exportSelection(api, { start: 90 }, api.groups, { start: 10, end: 22 }, {
      onProgress(event) {
        events.push(event);
        if (event.processing > 0 && !overlapped) {
          overlapped = true;
          assert.ok(api.starts.includes('part1'), '下一片应已经开始下载');
          assert.ok(!api.finishes.includes('part1'), '处理开始时下一片仍在下载');
          assert.ok(!api.finishes.includes('part4'), '不能在处理前读完整个选区');
          slow.resolve();
        }
      },
    });
    assert.ok(overlapped);
    assert.ok(api.peak <= 2, '前向下载并发必须有界');
    assert.equal(api.starts.length, new Set(api.starts).size, `两轨同时读片和尾部探测不能重复下载：${api.starts.slice(0, 30)}`);
    assert.deepEqual(outputs.map(output => [output.start, output.end]), [[10, 22]]);
    const media = await inspect(outputs[0].blob);
    assert.ok(Math.abs(media.duration - 12) < .05);
    assert.deepEqual(media.counts, { video: 360, audio: 558 });
    assert.equal(events.at(-1).progress, 1);
    assert.equal(events.at(-1).phase, 'complete');
    assert.equal(events.at(-1).downloaded, kind === 'map' ? 7 : 6);
    assert.ok(events.slice(0, -1).every(event => event.progress < 1), '只有已完成封装才能到 100%');
    assert.ok(events.every((event, index) => !index || event.progress >= events[index - 1].progress), '并行进度不能倒退');
  });
}

test('快预读不会挤掉慢的当前分片，保留窗口有界且按 URL 和字节范围复用', async () => {
  const seen = [], current = deferred();
  const segments = Array.from({ length: 8 }, (_, i) => ({ url: 'same', range: { offset: i * 10, length: 10 }, duration: 2 }));
  const loader = createSegmentLoader({ async request(url, { range }) {
    seen.push(range.offset);
    if (range.offset === 0 && seen.length === 1) await current.promise;
    return { data: new ArrayBuffer(10) };
  } }, segments);
  try {
    const first = loader.read(segments[0]);
    await loader.read(segments[1]);
    current.resolve();
    await first;
    for (let i = 0; i < 4; i++) await loader.read({ ...segments[0], range: { ...segments[0].range } });
    assert.equal(seen.filter(offset => offset === 0).length, 1, '已预读分片不能驱逐当前片');
    for (let i = 1; i < 7; i++) await loader.read(segments[i]);
    await loader.read(segments[1]);
    assert.equal(seen.filter(offset => offset === 10).length, 2, '旧片在前向处理后应已释放');
    assert.ok(seen.includes(70), '持续处理时预读下一片');
  } finally { await loader.close(); }
});

for (const reason of ['abort', 'network', 'processing']) {
  test(`并行导出${reason}失败终止待下载请求，立即重试可成功`, async () => {
    const api = await sampleApi('plain'), controller = new AbortController(), began = deferred(), failure = new Error(reason);
    let pendingAborted = false, interrupted = false;
    api.beforeRead = async (url, signal) => {
      if (url === 'part1') {
        began.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { pendingAborted = true; reject(signal.reason); }, { once: true });
        });
      }
      if (reason === 'network' && url === 'part5') { await began.promise; throw failure; }
    };
    const events = [];
    await assert.rejects(exportSelection(api, { start: 90 }, api.groups, { start: 10, end: 22 }, {
      signal: controller.signal,
      onProgress(event) {
        events.push(event);
        if (event.processing > 0 && !interrupted && reason !== 'network') {
          interrupted = true;
          if (reason === 'abort') controller.abort(failure);
          else throw failure;
        }
      },
    }), error => error === failure);
    assert.ok(pendingAborted);
    assert.equal(api.active, 0);
    assert.ok(events.every(event => event.progress < 1));
    api.beforeRead = undefined;
    const retry = await exportSelection(api, { start: 90 }, api.groups, { start: 10, end: 22 });
    assert.equal((await inspect(retry[0].blob)).counts.video, 360);
  });
}

test('选区预读网络失败会等待重连，保持处理进度并完成同一次导出',async()=>{
  const api=await sampleApi('plain'),events=[];let attempts=0;
  api.beforeRead=async url=>{if(url==='part1'&&attempts++===0)throw new RequestError('connection lost',{retryable:true});};
  const outputs=await exportSelection(api,{start:90},api.groups,{start:10,end:22},{onProgress:event=>events.push(event)});
  assert.ok(events.some(event=>event.reconnecting>0));assert.equal(events.at(-1).reconnecting,0);
  assert.equal(events.at(-1).progress,1);assert.equal((await inspect(outputs[0].blob)).counts.video,360);
  assert.equal(api.starts.filter(url=>url==='part1').length,2);
  assert.equal(api.finishes.length,new Set(api.finishes).size);
});

test('convertInput 完成后由调用者继续使用和释放输入', async () => {
  const input = new Input({ source: new BlobSource(new Blob([await fixture()])), formats: [MP4] });
  try {
    const blob = await convertInput(input, { start: .5, end: 1.5 });
    assert.ok(blob.size);
    assert.ok(await input.getPrimaryVideoTrack());
    assert.equal(await input.computeDuration(), 2);
  } finally { input.dispose(); }
});

test('尾部清单时长高估时按真实数据夹紧，进度跨多个输出累计', async () => {
  const api = await sampleApi('plain');
  const first = { ...api.groups[0], segments: api.segments.map((segment, index) => ({ ...segment, duration: index === 5 ? 2.8 : 2 })), streamEnd: 113 };
  const second = { ...api.groups[0], start: 115, streamEnd: 127 };
  const events = [];
  const outputs = await exportSelection(api, { start: 90 }, [first, second], { start: 10, end: 37 }, { onProgress: event => events.push(event) });
  assert.deepEqual(outputs.map(output => [output.start, output.end]), [[10, 22], [25, 37]]);
  assert.ok(events.every((event, index) => !index || event.progress >= events[index - 1].progress));
  assert.equal(events.filter(event => event.progress === 1).length, 1);
  assert.equal(events.at(-1).downloaded, 6, '跨输出复用的资源只累计一次完成数');
  for (const output of outputs) assert.equal((await inspect(output.blob)).counts.video, 360);
});

test('尾部规划后从头处理会恢复前向预读，不受规划游标影响', async () => {
  const seen = [], segments = Array.from({ length: 10 }, (_, i) => ({ url: String(i), duration: 2 }));
  const loader = createSegmentLoader({ async request(url) { seen.push(url); return { data: new ArrayBuffer(1) }; } }, segments);
  try {
    await loader.read(segments[6]);
    loader.beginProcessing();
    await loader.read(segments[1]);
    assert.ok(seen.includes('2'), '规划读过后面的分片也必须预读实际处理位置的下一片');
  } finally { await loader.close(); }
});
