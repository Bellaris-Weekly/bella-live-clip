import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayback,bindVideoControls} from '../../../src/media/playback.js';
import {createTimeline} from '../../../src/ui/timeline.js';

class Element {
 style={setProperty(key,value){this[key]=value;}};dataset={};handlers={};classList={add(){},remove(){}};
 setAttribute(){} replaceChildren(){} append(){}
 addEventListener(name,fn){this.handlers[name]=fn;}
 getBoundingClientRect(){return {left:0,width:100};}
 setPointerCapture(){this.captured=true;} hasPointerCapture(){return this.captured;}
 releasePointerCapture(){this.captured=false;}
 focus(){this.focused=true;}
 closest(){return this.dataset.handle?this:null;}
}
const makeVideo=paused=>Object.assign(new EventTarget(),{paused,ended:false,seeking:false,readyState:4,currentTime:0,playbackRate:1,playCount:0,pause(){this.paused=true;this.dispatchEvent(new Event('pause'));},play(){this.playCount++;this.paused=false;this.dispatchEvent(new Event('play'));return Promise.resolve();}});
const unrestricted={getRange:()=>null};

test('尚未开始的播放被暂停、拖动、关闭或换源打断时不报错，之后仍可播放',async()=>{
 for(const action of ['pause','scrub','cancel','reload']){
  const errors=[];let rejectPlay;
  const video=makeVideo(true);
  video.play=function(){this.playCount++;this.paused=false;return new Promise((resolve,reject)=>{rejectPlay=reject;});};
  video.pause=function(){this.paused=true;rejectPlay?.(new DOMException('播放被暂停打断','AbortError'));};
  video.load=function(){this.paused=true;rejectPlay?.(new DOMException('媒体源已重载','AbortError'));};
  const playback=createPlayback(video,(...args)=>errors.push(args),unrestricted);
  playback.toggle();
  if(action==='pause')playback.toggle();
  else if(action==='scrub')playback.begin();
  else if(action==='cancel')playback.cancel();
  else video.load();
  await Promise.resolve();
  assert.deepEqual(errors,[],action);assert.equal(video.paused,true,action);
  video.play=makeVideo(true).play;
  if(action==='scrub')playback.end();else playback.toggle();
  await Promise.resolve();
  assert.equal(video.paused,false,action);assert.equal(video.playCount,2,action);
 }
});

test('真实播放失败仍保留提示，不按报错文案判断取消',async()=>{
 for(const name of ['NotAllowedError','NotSupportedError','Error']){
  const errors=[],video=makeVideo(true);
  const error=new DOMException('The play() request was interrupted by a call to pause().',name);
  video.play=()=>Promise.reject(error);
  createPlayback(video,(...args)=>errors.push(args),unrestricted).toggle();
  await Promise.resolve();
  assert.deepEqual(errors,[[error.message,true]],name);
 }
});

test('播放位置与左右边界拖动均恢复原来的播放状态，覆盖松手和取消',()=>{
 const oldDocument=globalThis.document,oldCancel=globalThis.cancelAnimationFrame,oldRequest=globalThis.requestAnimationFrame;
 globalThis.document={createElement:()=>new Element()};globalThis.cancelAnimationFrame=()=>{};globalThis.requestAnimationFrame=()=>1;
 try{
  for(const paused of [true,false])for(const handle of ['playhead','start','end'])for(const ending of ['pointerup','pointercancel']){
   const video=makeVideo(paused),playback=createPlayback(video,()=>assert.fail('播放错误'),unrestricted);
   const elements=Object.fromEntries(['track','startHandle','endHandle','selectionElement','playhead','ticks','labels'].map(k=>[k,new Element()]));
   elements.startHandle.dataset.handle='start';elements.endHandle.dataset.handle='end';
   let position;
   const timeline=createTimeline({...elements,onPreview:t=>{video.pause();position=t;},onScrubStart:()=>playback.begin(),onScrubEnd:()=>playback.end()});
   timeline.reset(100,{start:10,end:80});
   timeline.setSelection({start:10.704,end:80.602});
   assert.equal(elements.labels.textContent,'00:10 — 01:20');
   assert.deepEqual(timeline.getSelection(),{start:10.704,end:80.602});
   timeline.setSelection({start:10,end:80});
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
 const video=makeVideo(true),playback=createPlayback(video,()=>assert.fail('播放错误'),unrestricted);
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


test('普通画面隐藏控件并响应点击，全屏和退出时切换原生控件',async()=>{
 const video=Object.assign(new EventTarget(),makeVideo(true));
 const root={fullscreenElement:null};
 video.ownerDocument=new EventTarget();video.getRootNode=()=>root;
 let requests=0;
 video.requestFullscreen=async()=>{requests++;root.fullscreenElement=video;video.ownerDocument.dispatchEvent(new Event('fullscreenchange'));};
 const fail=()=>assert.fail('播放器操作失败');
 bindVideoControls(video,createPlayback(video,fail,unrestricted),fail);
 const click=detail=>video.dispatchEvent(Object.assign(new Event('click'),{detail}));
 assert.equal(video.controls,false);
 click(1);assert.equal(video.paused,false);
 click(1);assert.equal(video.paused,true);
 click(2);assert.equal(video.paused,true);
 video.dispatchEvent(new Event('dblclick'));await Promise.resolve();
 assert.equal(requests,1);assert.equal(video.controls,true);
 click(1);assert.equal(video.paused,true,'全屏交给原生控件，不重复切换');
 video.dispatchEvent(new Event('dblclick'));assert.equal(requests,1);
 for(const target of [null,{}]){
  root.fullscreenElement=target;video.ownerDocument.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(video.controls,false,'退出视频全屏或其他元素全屏时隐藏');
 }
 click(1);assert.equal(video.paused,false);
});

test('键盘调整播放位置和两个边界后保留播放或暂停状态',t=>{
 const oldDocument=globalThis.document,oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
 globalThis.document={createElement:()=>new Element()};globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
 t.after(()=>{globalThis.document=oldDocument;globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;});
 for(const paused of [true,false])for(const type of ['playhead','start','end']){
  const video=makeVideo(paused),playback=createPlayback(video,()=>assert.fail('播放错误'),unrestricted);
  const elements=Object.fromEntries(['track','startHandle','endHandle','selectionElement','playhead','ticks','labels'].map(k=>[k,new Element()]));
  elements.startHandle.dataset.handle='start';elements.endHandle.dataset.handle='end';
  let position;
  const timeline=createTimeline({...elements,onPreview:value=>{video.pause();position=value;},onScrubStart:()=>playback.begin(),onScrubEnd:()=>playback.end()});
  timeline.reset(100,{start:10,end:80});timeline.setCurrent(30);
  timeline.handleKeyDown({key:'ArrowRight',target:type==='playhead'?elements.track:elements[type+'Handle'],preventDefault(){},stopPropagation(){}});
  assert.equal(video.paused,paused);assert.equal(video.playCount,paused?0:1);
  assert.equal(position,type==='playhead'?35:type==='start'?15:85);
 }
});

function boundedPlayback(t,initial){
 const video=makeVideo(true),timers=new Map();let id=0,range={...initial};
 t.mock.method(globalThis,'setTimeout',(callback,delay)=>{timers.set(++id,{callback,delay});return id;});
 t.mock.method(globalThis,'clearTimeout',key=>timers.delete(key));
 // The player exposes recording time, which may differ from the video's local time.
 const offset=initial.start/2,position=()=>offset+video.currentTime;
 const seek=time=>{video.pause();video.currentTime=time-offset;};
 const playback=createPlayback(video,()=>assert.fail('播放错误'),{getRange:()=>range,position,seek});
 return {video,playback,timers,position,seek,setRange(next){range=next;playback.check();},advance(time){video.currentTime=time-offset;}};
}

test('选区外开始播放会回到起点，按剩余时长停止且不循环，原生播放也受约束',t=>{
 for(const range of [{start:5,end:12},{start:3600.25,end:3601.75}]){
  const f=boundedPlayback(t,range);
  f.playback.toggle();assert.equal(f.position(),range.start);assert.equal(f.video.paused,false);
  assert.equal([...f.timers.values()].at(-1).delay,(range.end-range.start)*1000);
  f.video.playbackRate=2;f.video.dispatchEvent(new Event('ratechange'));
  const deadline=[...f.timers.values()].at(-1);assert.equal(deadline.delay,(range.end-range.start)*500);
  const plays=f.video.playCount;f.advance(range.end+.02);deadline.callback();
  assert.equal(f.video.paused,true);assert.equal(f.position(),range.end);assert.equal(f.timers.size,0);assert.equal(f.video.playCount,plays);
  void f.video.play();assert.equal(f.position(),range.start,'原生全屏控件也从起点重播');assert.equal(f.video.paused,false);
  f.playback.cancel();assert.equal(f.timers.size,0);
 }
});

test('播放中拖动到终点或缩短选区立即停止，暂停预览不被强制拉回',t=>{
 const f=boundedPlayback(t,{start:10,end:30});
 f.playback.toggle();f.playback.begin();f.seek(35);f.playback.end();
 assert.equal(f.video.paused,true);assert.equal(f.position(),30,'拖到终点外停在终点，不自动重播');
 f.playback.toggle();f.playback.begin();f.seek(4);f.playback.end();
 assert.equal(f.position(),10);assert.equal(f.video.paused,false,'拖到起点前从起点恢复');
 f.advance(20);f.setRange({start:10,end:15});assert.equal(f.position(),15);assert.equal(f.video.paused,true);
 f.seek(3);f.video.dispatchEvent(new Event('seeked'));assert.equal(f.position(),3,'暂停时允许预览选区外画面');
 f.playback.toggle();f.video.dispatchEvent(new Event('waiting'));assert.equal(f.timers.size,0);
 f.video.dispatchEvent(new Event('playing'));assert.equal(f.timers.size,1);
 f.playback.cancel();
});
