import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket,
 EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output,
} from 'mediabunny';
import {readSubmissionPreviewWindow} from '../../../src/media/submission-player.js';
import {config,frame} from '../support/synthetic-frame.mjs';

const videoConfig={...config,description:Buffer.from(config.description,'base64')};
const videoData=Buffer.from(frame,'base64');
const audioConfig={codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,description:new Uint8Array([0x11,0x90])};
const audioData=new Uint8Array([0x21,0x10,0x04,0x60,0x8c,0x1c]);
async function fixture(audio=false,offset=0){
 const output=new Output({target:new BufferTarget(),format:new Mp4OutputFormat()});
 const source=audio?new EncodedAudioPacketSource('aac'):new EncodedVideoPacketSource('avc');
 if(audio)output.addAudioTrack(source);else output.addVideoTrack(source);
 await output.start();
 const duration=audio?1024/48000:.5;
 for(let i=0;i*duration<20;i++)await source.add(new EncodedPacket(audio?audioData:videoData,'key',offset+i*duration,duration),{decoderConfig:audio?audioConfig:videoConfig});
 source.close();await output.finalize();
 return new Input({source:new BufferSource(output.target.buffer),formats:[MP4]});
}

for(const time of [.27,11.31])test(`preview window at ${time} preserves independent audio/video timestamps`,async()=>{
 const video=await fixture(),audio=await fixture(true);
 try{
  const tracks=[await video.getPrimaryVideoTrack(),await audio.getPrimaryAudioTrack()];
  const window=await readSubmissionPreviewWindow(tracks,time,{span:2});
  assert.ok(window.start<=time);assert.ok(window.end>time+2);assert.ok(window.end-window.start<3);
  assert.equal(window.chunks.length,2);assert.equal(window.finished,false);
  for(const {track,data} of window.chunks){
   const input=new Input({source:new BufferSource(data),formats:[MP4]});
   try{
    const result=(await input.getTracks())[0],sink=new EncodedPacketSink(result),packets=[];
    for await(const packet of sink.packets())packets.push(packet);
    assert.ok(packets.length);
    const first=packets[0];
    assert.ok(first.timestamp<=window.start+.00001);
    assert.ok(window.start-first.timestamp<.022);
    assert.ok(packets.at(-1).timestamp<window.end);
    for(const packet of packets)assert.deepEqual(packet.data,track.isVideoTrack()?new Uint8Array(videoData):audioData);
   }finally{input.dispose();}
  }
 }finally{video.dispose();audio.dispose();}
});

test('last preview window remains finite and reports end of input',async()=>{
 const input=await fixture();
 try{
  const window=await readSubmissionPreviewWindow([await input.getPrimaryVideoTrack()],19.8);
  assert.equal(window.start,19.5);assert.equal(window.end,20);assert.equal(window.finished,true);
 }finally{input.dispose();}
});

test('canceled preview reads do not start packet access',async()=>{
 const controller=new AbortController(),reason=new DOMException('Stop','AbortError');controller.abort(reason);
 await assert.rejects(readSubmissionPreviewWindow([],1,{signal:controller.signal}),error=>error===reason);
});

for(const offset of [.1,.23])test(`preview preserves audio before the first video frame at ${offset}`,async()=>{
 const video=await fixture(false,offset),audio=await fixture(true);
 try{
  const window=await readSubmissionPreviewWindow([await video.getPrimaryVideoTrack(),await audio.getPrimaryAudioTrack()],0,{span:2});
  assert.equal(window.start,0);
  for(const {track,data} of window.chunks){
   const input=new Input({source:new BufferSource(data),formats:[MP4]});
   try{
    const result=(await input.getTracks())[0],first=await new EncodedPacketSink(result).getFirstPacket();
    assert.ok(Math.abs(first.timestamp-(track.isVideoTrack()?offset:0))<.00001);
    assert.deepEqual(first.data,track.isVideoTrack()?new Uint8Array(videoData):audioData);
   }finally{input.dispose();}
  }
 }finally{video.dispose();audio.dispose();}
});
