import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Output, BufferTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket, Input, BufferSource, MP4, EncodedPacketSink } from 'mediabunny';
import { config } from '../support/synthetic-frame.mjs';
import { exportSubmission } from '../../../src/media/submission-export.js';
import { RequestError } from '../../../src/services/retry-request.js';
import { openSubmissionMedia } from '../../../src/media/remote-mp4.js';

async function fixture(kind, packetSize = 6, { videoOffset = 0, videoFrames = 300 } = {}) {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
  const video = kind !== 'audio' && new EncodedVideoPacketSource('avc');
  const audio = kind !== 'video' && new EncodedAudioPacketSource('aac');
  if (video) output.addVideoTrack(video);
  if (audio) output.addAudioTrack(audio);
  await output.start();
  if (video) {
    for (let i = 0; i < videoFrames; i++) await video.add(new EncodedPacket(Uint8Array.from({length:packetSize},(_,index)=>[0,0,0,2,i%60 ? 0x41 : 0x65,0x88][index]??0),
      i%60 ? 'delta' : 'key', videoOffset+i/30, 1/30), { decoderConfig: { ...config, description: new Uint8Array(Buffer.from(config.description, 'base64')) } });
    video.close();
  }
  if (audio) {
    for (let i = 0; i < 469; i++) await audio.add(new EncodedPacket(new Uint8Array([0x21,0x10,0x04,0x60,0x8c,0x1c]), 'key', i*1024/48000, 1024/48000),
      { decoderConfig: { codec: 'mp4a.40.2', sampleRate:48000, numberOfChannels:2, description:new Uint8Array([0x11,0x90]) } });
    audio.close();
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer);
}
const submission = combined => ({ duration: 10, referer:'https://www.bilibili.com/video/BVtest?p=2',
  media:{ video:{url:'https://media.example/video'}, audio:combined?null:{url:'https://media.example/audio'}, combined } });
function transport(files, calls = []) {
  return async (url, options) => {
    calls.push(options);
    options.signal.throwIfAborted();
    const bytes = files[url.endsWith('audio') ? 'audio' : 'video'];
    const { offset, length } = options.range;
    return { data: bytes.slice(offset,offset+length), headers:`Content-Range: bytes ${offset}-${offset+length-1}/${bytes.length}\r\n` };
  };
}
for (const combined of [false,true]) for (const [start,end,expected] of [[.3,3.7,4],[7.3,9.9,4],[2,6,4]]) {
  test(`投稿原画 ${combined?'合并':'分轨'} ${start}–${end} 保留完整 GOP 与声音`, async () => {
    const calls = [], events=[];
    const blob = await exportSubmission(transport({video:await fixture(combined?'combined':'video'),audio:await fixture('audio')},calls),submission(combined),{start,end},{onProgress:e=>events.push(e)});
    const input = new Input({source:new BufferSource(await blob.arrayBuffer()),formats:[MP4]});
    try {
      assert.ok(Math.abs(await input.computeDuration()-expected)<.03);
      const video = await input.getPrimaryVideoTrack(), audio=await input.getPrimaryAudioTrack();
      assert.ok(audio);
      const first = await new EncodedPacketSink(video).getFirstPacket();
      assert.equal(first.type,'key'); assert.equal(first.timestamp,0);
      assert.ok(await new EncodedPacketSink(audio).getFirstPacket());
      assert.ok(calls.every(call=>call.referer===submission(combined).referer && call.range.length<=1024*1024));
      assert.equal(events.at(-1).progress,1);
      assert.ok(events.every((event,i)=>!i||event.progress>=events[i-1].progress));
    } finally {input.dispose();}
  });
}

test('分轨精确导出共用轨道级剪辑，音频预热保持负时间戳',async()=>{
  const blob=await exportSubmission(transport({video:await fixture('video'),audio:await fixture('audio')}),submission(false),{start:2,end:6},{precise:true});
  const input=new Input({source:new BufferSource(await blob.arrayBuffer()),formats:[MP4]});
  try {assert.equal(await input.computeDuration(),4);assert.ok((await new EncodedPacketSink(await input.getPrimaryAudioTrack()).getFirstPacket()).timestamp<0);}finally{input.dispose();}
});

test('音频读取失败不能静默输出无声视频',async()=>{
  const error=new Error('音频不可用'),read=transport({video:await fixture('video')});
  await assert.rejects(exportSubmission((url,options)=>url.endsWith('audio')?Promise.reject(error):read(url,options),submission(false),{start:1,end:3}),e=>e===error);
});

test('范围头偏移与返回长度都必须匹配，覆盖两类损坏响应',async()=>{
  const bytes=await fixture('video');
  for(const change of [r=>({...r,headers:r.headers.replace('bytes 0-0','bytes 1-1')}),r=>({...r,data:new Uint8Array(2)})]) {
    const request=transport({video:bytes});
    const media=openSubmissionMedia(async(...args)=>change(await request(...args)),submission(true));
    try{await assert.rejects(media.getTracks(),/字节范围/);}finally{media.dispose();}
  }
});

test('取消活动范围读取，保留原取消原因',async()=>{
  const controller=new AbortController(),reason=new Error('用户取消');
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const result=exportSubmission((_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();}),submission(true),{start:0,end:3},{signal:controller.signal});
  await ready;controller.abort(reason);
  await assert.rejects(result,e=>e===reason);
});


test('大文件随机读取保持网络分块上限，不读取完整视频',async()=>{
  const bytes=await fixture('video',65536),calls=[];
  const media=openSubmissionMedia(transport({video:bytes},calls),submission(true));
  try{
    const [track]=await media.getTracks();
    const packet=await new EncodedPacketSink(track).getPacket(8.5);
    assert.ok(packet.timestamp>=8.4);
    assert.ok(calls.every(call=>call.range.length<=1024*1024));
    assert.ok(calls.reduce((sum,call)=>sum+call.range.length,0)<bytes.length/2);
  }finally{media.dispose();}
});

test('临时断线重试同一范围并恢复；重连等待也可取消',async()=>{
  const read=transport({video:await fixture('video')}),events=[],calls=[];
  let fail=true;
  const media=openSubmissionMedia(async(url,options)=>{
    calls.push(options.range);
    if(fail){fail=false;throw new RequestError('临时断线',{retryable:true});}
    return read(url,options);
  },submission(true),{onRetry:state=>events.push(state)});
  try{
    await media.getTracks();
    assert.deepEqual(calls[0],calls[1]);
    assert.equal(events[0].attempt,1);assert.equal(events.at(-1),null);
  }finally{media.dispose();}
  const controller=new AbortController(),reason=new Error('取消重连');
  const retrying=openSubmissionMedia(async()=>{throw new RequestError('持续断线',{retryable:true});},submission(true),{
    signal:controller.signal,onRetry:state=>{if(state)controller.abort(reason);},
  });
  try{await assert.rejects(retrying.getTracks(),error=>error===reason);}finally{retrying.dispose();}
});


for (const [combined, videoOffset] of [[false, .1], [true, .37]]) {
  test(`原画保留提前开始及延后结束的声音：${combined ? '合并' : '分轨'}，画面偏移 ${videoOffset}`, async () => {
    const files = { video: await fixture(combined ? 'combined' : 'video', 6, { videoOffset, videoFrames: 270 }), audio: await fixture('audio') };
    const blob = await exportSubmission(transport(files), submission(combined), { start: 0, end: 10 });
    const input = new Input({ source: new BufferSource(await blob.arrayBuffer()), formats: [MP4] });
    try {
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      const videos = [], audios = [];
      for await (const packet of new EncodedPacketSink(video).packets()) videos.push(packet);
      for await (const packet of new EncodedPacketSink(audio).packets()) audios.push(packet);
      assert.equal(videos.length, 270);
      assert.ok(Math.abs(videos[0].timestamp - videoOffset) < .0001, '画面保留原始延迟，不移动到零点');
      assert.equal(audios.length, 469, '提前开始和画面结束后的声音包都保留');
      assert.equal(audios[0].timestamp, 0);
      assert.ok(Math.abs(audios.at(-1).timestamp - 468 * 1024 / 48000) < .0001);
      assert.ok(Math.abs(audios.at(-1).timestamp + audios.at(-1).duration - 10) < .0001);
      assert.ok(Math.abs(await input.computeDuration() - 10) < .0001);
    } finally { input.dispose(); }
  });
}


test('preview ranges read only the low source; precise exports still read only the high source',async()=>{
 const video=await fixture('video'),audio=await fixture('audio');
 const record=submission(false);
 record.previewMedia={video:{url:'https://media.example/low-video'},audio:{url:'https://media.example/low-audio'},combined:false};
 const urls=[];
 const request=async(url,options)=>{urls.push(url);return transport({video,audio})(url,options);};
 const preview=openSubmissionMedia(request,record,{preview:true});
 try {assert.equal((await preview.getTracks()).length,2);} finally {preview.dispose();}
 assert.ok(urls.length>0&&urls.every(url=>url.includes('/low-')));
 urls.length=0;
 await exportSubmission(request,record,{start:2,end:6},{precise:true});
 assert.ok(urls.length>0&&urls.every(url=>!url.includes('/low-')));
});
