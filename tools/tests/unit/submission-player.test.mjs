import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSubmissionPlayer} from '../../../src/media/submission-player.js';

class PageVideo extends EventTarget {
 constructor(time=12){super();Object.assign(this,{currentTime:time,paused:false,ended:false,seeking:false,readyState:4,videoWidth:1920,videoHeight:1080,playbackRate:1,muted:false,volume:.6,plays:0,pauses:0,frames:new Map(),nextFrame:0});}
 play(){this.plays++;this.paused=false;this.dispatchEvent(new Event('play'));return Promise.resolve();}
 pause(){this.pauses++;this.paused=true;this.dispatchEvent(new Event('pause'));}
 requestVideoFrameCallback(fn){const id=++this.nextFrame;this.frames.set(id,fn);return id;}
 cancelVideoFrameCallback(id){this.frames.delete(id);}
 frame(){const pending=[...this.frames.values()];this.frames.clear();for(const fn of pending)fn();}
}
function fixture(read=async()=>({image:{preview:true},x:0,y:0,width:320,height:180})){
 let current=new PageVideo(),valid=true;
 const canvas=new EventTarget(),draws=[],times=[],errors=[],loading={};
 Object.assign(canvas,{width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args),clearRect(){}})});
 const player=createSubmissionPlayer({canvas,loading,getVideo:()=>current,isCurrent:()=>valid,onTime:t=>times.push(t),onState(){},status:e=>errors.push(e),getRange:()=>({start:20,end:23}),createPreview:()=>({read,dispose(){}})});
 return {player,canvas,loading,draws,times,errors,get video(){return current;},replace(v){current=v;},invalidate(){valid=false;},load:()=>player.load({duration:5200},new AbortController().signal)};
}

test('opening mirrors the current decoded frame without seeking, pausing or changing audio',async()=>{
 const f=fixture();await f.load();
 assert.equal(f.video.currentTime,12);assert.equal(f.video.pauses,0);assert.equal(f.video.plays,0);
 assert.equal(f.video.muted,false);assert.equal(f.video.volume,.6);
 assert.equal(f.canvas.width,640);assert.equal(f.canvas.height,360);
 assert.equal(f.draws[0][0],f.video);assert.equal(f.loading.hidden,true);
 f.video.currentTime=47;f.video.frame();assert.equal(f.times.at(-1),47);
 assert.equal(f.video.paused,false,'normal playback is not constrained to the selection');f.player.destroy();
});

test('scrubbing preserves page playback until release and commits only the final target',async()=>{
 for(const paused of [false,true]){
  const f=fixture();f.video.paused=paused;await f.load();
  f.player.begin();assert.equal(f.video.paused,paused);f.player.seek(51);assert.equal(f.video.currentTime,12);f.player.end();
  assert.equal(f.video.currentTime,51);assert.equal(f.video.paused,paused);
  f.player.check();assert.equal(f.video.currentTime,51);f.player.destroy();
 }
});

test('only explicit selection playback stops at the endpoint and normal play can continue beyond it',async()=>{
 const f=fixture();await f.load();f.player.playSelection();
 assert.equal(f.video.currentTime,20);assert.equal(f.video.paused,false);
 f.video.currentTime=23.2;f.video.dispatchEvent(new Event('timeupdate'));
 assert.equal(f.video.currentTime,23);assert.equal(f.video.paused,true);
 f.player.toggle();f.video.currentTime=40;f.player.check();assert.equal(f.video.paused,false);f.player.destroy();
});

test('external seek outside a selection restores ordinary playback; rate changes use the page clock',async()=>{
 const f=fixture();await f.load();f.player.playSelection();
 f.video.playbackRate=2;f.video.dispatchEvent(new Event('ratechange'));
 f.video.currentTime=80;f.video.seeking=true;f.video.dispatchEvent(new Event('seeking'));
 f.video.seeking=false;f.video.dispatchEvent(new Event('seeked'));
 assert.equal(f.video.paused,false);assert.equal(f.player.position(),80);f.player.destroy();
});

test('closing detaches frames and reopening catches up without interrupting page playback',async()=>{
 const f=fixture();await f.load();f.player.suspend();
 assert.equal(f.video.frames.size,0);assert.equal(f.video.pauses,0);
 const count=f.draws.length;f.video.currentTime=82;f.video.dispatchEvent(new Event('timeupdate'));
 assert.equal(f.draws.length,count);f.player.resume();assert.equal(f.times.at(-1),82);
 f.player.destroy();assert.equal(f.video.frames.size,0);assert.equal(f.video.pauses,0);
});

test('replacement video elements and route changes release the former player',async()=>{
 const f=fixture();await f.load();const previous=f.video;
 const next=new PageVideo(91);f.replace(next);f.player.refresh();
 assert.equal(previous.frames.size,0);assert.equal(previous.pauses,0);assert.equal(f.player.position(),91);
 const count=f.times.length;previous.dispatchEvent(new Event('timeupdate'));assert.equal(f.times.length,count);
 f.invalidate();f.player.refresh();assert.equal(next.frames.size,0);assert.equal(next.pauses,0);
 assert.equal(f.loading.hidden,false);assert.match(f.loading.textContent,/切换视频/);f.player.destroy();
});

test('canceling a scrub restores intent and canceling selection playback does not pause watching',async()=>{
 const f=fixture();await f.load();f.player.begin();f.player.suspend();assert.equal(f.video.paused,false);
 f.player.resume();f.player.playSelection();f.player.cancel();f.video.currentTime=200;f.player.check();
 assert.equal(f.video.paused,false);f.player.destroy();
});

test('a paused seek redraws once; absent or buffering video waits without fetching another source',async()=>{
 const f=fixture();f.replace(null);await f.load();assert.equal(f.loading.hidden,false);
 const next=new PageVideo();next.paused=true;next.readyState=0;f.replace(next);f.player.refresh();assert.equal(f.draws.length,0);
 next.readyState=4;next.currentTime=100;next.dispatchEvent(new Event('seeked'));
 assert.equal(f.draws.length,1);assert.equal(f.times.at(-1),100);assert.equal(next.frames.size,0);f.player.destroy();
});

test('drag shows a storyboard still while page events cannot overwrite it, then resumes mirroring',async()=>{
 const f=fixture();await f.load();f.player.begin();f.player.seek(80);
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(f.draws.at(-1)[0].preview,true);assert.equal(f.player.position(),80);
 const count=f.draws.length;f.video.currentTime=14;f.video.dispatchEvent(new Event('timeupdate'));f.player.refresh();
 assert.equal(f.draws.length,count);assert.equal(f.times.at(-1),80);assert.equal(f.video.paused,false);
 f.player.end();assert.equal(f.video.currentTime,80);assert.equal(f.draws.at(-1)[0],f.video);f.player.destroy();
});

test('continuous pointer movement paints previews without waiting for the pointer to stop',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const reads=[];
 const f=fixture(async time=>{reads.push(time);return {image:{time},x:0,y:0,width:320,height:180};});
 await f.load();f.player.begin();
 try{
  for(const time of [80,81,90,140,139]){
   f.player.seek(time);
   await Promise.resolve();
   assert.equal(f.draws.at(-1)[0].time,time,'each available frame paints during movement');
   assert.equal(f.video.currentTime,12);
   t.mock.timers.tick(16);
  }
  assert.deepEqual(reads,[80,81,90,140,139]);
  f.player.end();assert.equal(f.video.currentTime,139);
 }finally{f.player.destroy();}
});

test('native progress preview reuses its image and release leaves the native seek untouched',async()=>{
 const f=fixture();await f.load();f.player.begin();
 const image={naturalWidth:320,naturalHeight:180};f.player.previewImage(image,75);
 assert.equal(f.draws.at(-1)[0],image);assert.equal(f.video.currentTime,12);
 f.video.currentTime=76;f.player.end({commit:false});assert.equal(f.video.currentTime,76);
 assert.equal(f.draws.at(-1)[0],f.video);f.player.destroy();
});

test('releasing or closing a drag cancels pending preview reads before they can replace live frames',async()=>{
 const f=fixture();await f.load();f.player.begin();f.player.seek(90);f.player.end();
 const count=f.draws.length;await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.draws.length,count);
 f.player.begin();f.player.seek(130);f.player.suspend();assert.equal(f.video.currentTime,90);
 await new Promise(resolve=>setTimeout(resolve,100));f.player.resume();assert.equal(f.draws.at(-1)[0],f.video);f.player.destroy();
});

test('late preview responses cannot paint after release or after a different drag begins',async()=>{
 const pending=[];
 const f=fixture((time,signal)=>new Promise(resolve=>pending.push({time,signal,resolve})));
 await f.load();f.player.begin();f.player.seek(81);
 await new Promise(resolve=>setTimeout(resolve,100));
 f.player.end();f.player.begin();f.player.seek(143);
 const count=f.draws.length;
 pending[0].resolve({image:{preview:true},x:0,y:0,width:320,height:180});
 await Promise.resolve();assert.equal(pending[0].signal.aborted,true);assert.equal(f.draws.length,count);assert.equal(f.player.position(),143);
 await new Promise(resolve=>setTimeout(resolve,100));
 f.player.end({commit:false});const released=f.draws.length;
 pending[1].resolve({image:{preview:true},x:0,y:0,width:320,height:180});
 await Promise.resolve();assert.equal(f.draws.length,released);assert.equal(f.video.currentTime,81);f.player.destroy();
});
