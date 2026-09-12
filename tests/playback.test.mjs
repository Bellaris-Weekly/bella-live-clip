import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayback} from '../src/playback.js';
import {createTimeline} from '../src/timeline.js';

class Element {
 style={};dataset={};handlers={};classList={add(){},remove(){}};
 setAttribute(){} replaceChildren(){} append(){}
 addEventListener(name,fn){this.handlers[name]=fn;}
 getBoundingClientRect(){return {left:0,width:100};}
 setPointerCapture(){this.captured=true;} hasPointerCapture(){return this.captured;}
 releasePointerCapture(){this.captured=false;}
 closest(){return this.dataset.handle?this:null;}
}
const makeVideo=paused=>({paused,ended:false,playCount:0,pause(){this.paused=true;},play(){this.playCount++;this.paused=false;return Promise.resolve();}});

test('播放位置与左右边界拖动均恢复原来的播放状态，覆盖松手和取消',()=>{
 const oldDocument=globalThis.document,oldCancel=globalThis.cancelAnimationFrame,oldRequest=globalThis.requestAnimationFrame;
 globalThis.document={createElement:()=>new Element()};globalThis.cancelAnimationFrame=()=>{};globalThis.requestAnimationFrame=()=>1;
 try{
  for(const paused of [true,false])for(const handle of ['playhead','start','end'])for(const ending of ['pointerup','pointercancel']){
   const video=makeVideo(paused),playback=createPlayback(video,()=>assert.fail('播放错误'));
   const elements=Object.fromEntries(['track','startHandle','endHandle','selectionElement','playhead','ticks','labels'].map(k=>[k,new Element()]));
   elements.startHandle.dataset.handle='start';elements.endHandle.dataset.handle='end';
   let position;
   const timeline=createTimeline({...elements,onPreview:t=>{video.pause();position=t;},onScrubStart:()=>playback.begin(),onScrubEnd:()=>playback.end()});
   timeline.reset(100,{start:10,end:80});
   const target=handle==='playhead'?elements.track:elements[handle+'Handle'];
   const event={button:0,clientX:50,pointerId:1,target,preventDefault(){}};
   elements.track.handlers.pointerdown(event);
   assert.equal(video.paused,true);assert.equal(video.playCount,0);
   elements.track.handlers.pointermove({...event,clientX:60});
   elements.track.handlers[ending](event);
   assert.equal(video.paused,paused,`${handle}/${ending}`);
   assert.equal(video.playCount,paused?0:1);
   assert.equal(position,handle==='playhead'?60:handle==='start'?20:90);
  }
 }finally{globalThis.document=oldDocument;globalThis.cancelAnimationFrame=oldCancel;globalThis.requestAnimationFrame=oldRequest;}
});

test('播放按钮能切换状态，关闭面板取消尚未结束的恢复意图',()=>{
 const video=makeVideo(true),playback=createPlayback(video,()=>assert.fail('播放错误'));
 playback.toggle();assert.equal(video.paused,false);
 playback.toggle();assert.equal(video.paused,true);
 playback.toggle();playback.begin();playback.cancel();playback.end();assert.equal(video.paused,true);
});


test('默认选区覆盖整场，两端直接位于时间轴起止位置',()=>{
 const oldDocument=globalThis.document;
 globalThis.document={createElement:()=>new Element()};
 try{
  const elements=Object.fromEntries(['track','startHandle','endHandle','selectionElement','playhead','ticks','labels'].map(k=>[k,new Element()]));
  let selected;
  const timeline=createTimeline({...elements,onPreview(){},onSelection:value=>selected=value});
  for(const duration of [24,4976,7200]){
   timeline.reset(duration);
   assert.deepEqual(timeline.getSelection(),{start:0,end:duration});
   assert.deepEqual(timeline.getView(),{start:0,end:duration});
   assert.deepEqual(selected,{start:0,end:duration});
   assert.equal(elements.startHandle.style.left,'0%');
   assert.equal(elements.endHandle.style.left,'100%');
   elements.track.handlers.wheel({deltaY:-100,deltaX:0,clientX:50,shiftKey:false,preventDefault(){}});
   const zoomed=timeline.getView();assert.ok(zoomed.end-zoomed.start<duration);
   assert.deepEqual(timeline.getSelection(),{start:0,end:duration});
   elements.track.handlers.wheel({deltaY:10,deltaX:0,clientX:50,shiftKey:true,preventDefault(){}});
   assert.ok(timeline.getView().start>zoomed.start);
   assert.deepEqual(timeline.getSelection(),{start:0,end:duration});
  }
 }finally{globalThis.document=oldDocument;}
});
