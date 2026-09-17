import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecordingTimeline} from '../../../src/media/recording-timeline.js';
const packet=(timestamp,type='key',duration=.04)=>({timestamp,type,duration});
const video=packets=>({key:'video:1',packets});
const audio=packets=>({key:'audio:1',packets});

test('native continuous timestamps ignore manifest duration drift and retain B-frame ordering',()=>{
  const timeline=new RecordingTimeline();
  const first=[packet(10),packet(10.12,'delta'),packet(10.04,'delta'),packet(10.08,'delta')];
  assert.equal(timeline.append([video(first)]),-10);
  const second=[packet(10.16),packet(10.28,'delta'),packet(10.20,'delta'),packet(10.24,'delta')];
  assert.equal(timeline.append([video(second)]),-10);
  assert.equal(timeline.end,.32);assert.deepEqual(first.map(p=>p.timestamp),[10,10.12,10.04,10.08]);
});

test('a segment split inside a GOP can begin with a lower PTS without creating a reset',()=>{
  const timeline=new RecordingTimeline();
  timeline.append([video([packet(0),packet(.12,'delta')])]);
  assert.equal(timeline.append([video([packet(.04,'delta'),packet(.08,'delta'),packet(.16)])]),0);
  assert.equal(timeline.end,.2);
});

test('resets shift every track by the same epoch and preserve the original audio/video offset',()=>{
  for(const nextStart of [0,4,100]){
    const timeline=new RecordingTimeline();
    timeline.append([video([packet(10),packet(10.04)]),audio([packet(10.02),packet(10.06)])]);
    const offset=timeline.append([video([packet(nextStart),packet(nextStart+.04)]),audio([packet(nextStart+.02),packet(nextStart+.06)])],nextStart===100);
    const boundary=nextStart===100?.1:.08;
    assert.ok(Math.abs(offset+nextStart-boundary)<1e-6);assert.ok(Math.abs(timeline.end-boundary-.1)<1e-6);
  }
});

test('genuine intra-segment GOP corruption is reported rather than sorting or dropping packets',()=>{
  const timeline=new RecordingTimeline();
  assert.throws(()=>timeline.append([video([packet(0),packet(.12,'delta'),packet(.04)])]),/分片内部/);
});
