import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTimeline,fitSelection} from '../../../src/ui/timeline.js';

class Element {
  writes=0; children=[]; attributes={}; handlers={}; dataset={};
  classList={add(){},remove(){}};
  style=new Proxy({setProperty(key,value){this[key]=value;}}, {set:(target,key,value)=>{this.writes++;target[key]=value;return true;}});
  set textContent(value){this.writes++;this.text=value;}
  get textContent(){return this.text;}
  setAttribute(key,value){this.writes++;this.attributes[key]=value;}
  replaceChildren(...children){this.writes++;this.children=children;}
  append(...children){this.writes++;this.children.push(...children);}
  addEventListener(name,handler){this.handlers[name]=handler;}
  getBoundingClientRect(){return {left:0,width:100};}
  focus(){this.focused=true;}
 closest(){return this.dataset.handle?this:null;}
  setPointerCapture(){this.captured=true;}
  hasPointerCapture(){return this.captured;}
  releasePointerCapture(){this.captured=false;}
}

function fixture(t){
  let id=0;const frames=new Map();
  for(const [key,value] of [['document',{createElement:()=>new Element()}],['cancelAnimationFrame',id=>frames.delete(id)],['requestAnimationFrame',fn=>{frames.set(++id,fn);return id;}],['matchMedia',()=>({matches:false})]]){
    const saved=Object.getOwnPropertyDescriptor(globalThis,key);
    globalThis[key]=value;
    t.after(()=>{if(saved)Object.defineProperty(globalThis,key,saved);else delete globalThis[key];});
  }
  const elements=Object.fromEntries(['track','startHandle','endHandle','selectionElement','playhead','ticks','labels'].map(key=>[key,new Element()]));
  elements.startHandle.dataset.handle='start';elements.endHandle.dataset.handle='end';
  const previews=[],selections=[],views=[];
  const timeline=createTimeline({...elements,onPreview:value=>previews.push(value),onSelection:value=>selections.push(value),onView:(view,motion)=>views.push({view,motion})});
  const staticElements=[elements.startHandle,elements.endHandle,elements.selectionElement,elements.labels,elements.ticks,...elements.ticks.children];
  return {...elements,timeline,previews,selections,views,frames,advance(now){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(now));},staticWrites:()=>staticElements.map(el=>el.writes)};
}

test('播放进度与点击预览只更新指针，短片和长场均不重写刻度或选区',t=>{
  const f=fixture(t);
  for(const duration of [24,7200]){
    f.timeline.reset(duration);
    const writes=f.staticWrites(),selectionCount=f.selections.length;
    for(const fraction of [.1,.5,.9]){
      f.timeline.setCurrent(duration*fraction);
      assert.ok(Math.abs(parseFloat(f.playhead.style.left)-fraction*100)<1e-9);
      assert.equal(f.playhead.hidden,false);
    }
    f.track.handlers.pointerdown({button:0,clientX:75,pointerId:1,target:f.track,preventDefault(){}});
    assert.equal(f.previews.at(-1),duration*.75);
    assert.equal(f.playhead.style.left,'75%');
    f.timeline.setCurrent(0);
    assert.equal(f.playhead.style.left,'75%','拖动中忽略播放器的旧进度');
    f.track.handlers.pointerup({pointerId:1});
    assert.deepEqual(f.staticWrites(),writes);
    assert.equal(f.selections.length,selectionCount);
    assert.deepEqual(f.timeline.getSelection(),{start:0,end:duration});
  }
});

test('缩放和选区调整复用刻度节点，锁定只改变边界可用状态',t=>{
  const f=fixture(t);
  f.timeline.reset(100);
  const nodes=[...f.ticks.children];
  assert.deepEqual(nodes.map(el=>el.textContent),['00:00:00','00:00:25','00:00:50','00:01:15','00:01:40']);
  f.track.handlers.wheel({deltaY:Math.log(.5)/.005,deltaX:0,clientX:50,shiftKey:false,preventDefault(){}});
  assert.deepEqual(f.timeline.getView(),{start:25,end:75});
  assert.deepEqual(nodes.map(el=>el.textContent),['00:00:25','00:00:37','00:00:50','00:01:02','00:01:15']);
  f.timeline.setCurrent(10);assert.equal(f.playhead.hidden,true);
  f.timeline.setCurrent(50);assert.equal(f.playhead.hidden,false);assert.equal(f.playhead.style.left,'50%');
  f.timeline.setSelection({start:30,end:70});
  assert.equal(f.startHandle.style.left,'10%');assert.equal(f.endHandle.style.left,'90%');
  assert.equal(f.labels.textContent,'00:30 — 01:10');
  assert.equal(f.startHandle.attributes['aria-valuenow'],'30.000');
  const writes=f.staticWrites();
  for(const locked of [true,false]){
    f.timeline.lock(locked);
    assert.equal(f.startHandle.disabled,locked);assert.equal(f.endHandle.disabled,locked);
    assert.deepEqual(f.staticWrites(),writes);
  }
  f.timeline.reset(24);
  assert.equal(f.endHandle.attributes['aria-valuemax'],24);
  assert.deepEqual(f.ticks.children,nodes);
  nodes.forEach((node,i)=>assert.equal(f.ticks.children[i],node));
});


test('左右边界松手后整条视野连续放大，刻度保留时间参照，选区不回弹',t=>{
 const f=fixture(t);
 for(const duration of [24,7200])for(const type of ['start','end']){
  f.timeline.reset(duration,{start:duration*.2,end:duration*.8});
  f.timeline.setCurrent(duration*.5);
  const event={button:0,clientX:type==='start'?20:80,pointerId:1,target:f[type+'Handle'],preventDefault(){}};
  f.track.handlers.pointerdown(event);
  f.track.handlers.pointermove({...event,clientX:type==='start'?30:70});
  f.track.handlers.pointerup(event);
  const selected=f.timeline.getSelection(),before=f.timeline.getView(),ticks=f.ticks.children.map(el=>el.textContent);
  assert.deepEqual(before,{start:0,end:duration},'松手当帧不跳到目标视野');
  assert.equal(f.views.at(-1).motion.animating,true,'松手即通知目标视野，在动画期间开始生成倒计时');
  assert.deepEqual(f.views.at(-1).motion.target,fitSelection(selected.start,selected.end,duration));
  f.advance(0);f.advance(210);
  const middle=f.timeline.getView(),target=fitSelection(selected.start,selected.end,duration);
  assert.ok(middle.end-middle.start<duration);
  assert.ok(middle.end-middle.start>target.end-target.start);
  assert.deepEqual(f.ticks.children.map(el=>el.textContent),ticks,'缩放时原刻度随画面移动');
  assert.ok(parseFloat(f.ticks.children[0].style.left)<0);
  assert.equal(f.views.at(-1).motion.animating,true);
  const expected=(selected[type]-middle.start)/(middle.end-middle.start)*100;
  assert.ok(Math.abs(parseFloat(f.playhead.style.left)-expected)<1e-8);
  f.advance(420);
  assert.deepEqual(f.timeline.getView(),target);
  assert.deepEqual(f.timeline.getSelection(),selected);
  assert.equal(f.views.at(-1).motion.animating,false);
  assert.equal(f.frames.size,0);
 }
});

test('动画被新交互、换场或锁定打断后没有旧帧回跳',t=>{
 const f=fixture(t);
 for(const action of ['pointer','wheel','keyboard','reset','lock','stop']){
  f.timeline.lock(false);f.timeline.reset(100);
  f.timeline.setSelection({start:20,end:60},true);f.advance(0);f.advance(120);
  const middle=f.timeline.getView();
  if(action==='pointer')f.track.handlers.pointerdown({button:0,clientX:50,pointerId:1,target:f.track,preventDefault(){}});
  if(action==='wheel')f.track.handlers.wheel({deltaY:-20,deltaX:0,clientX:50,preventDefault(){}});
  if(action==='keyboard')f.timeline.handleKeyDown({key:'ArrowRight',target:f.startHandle,preventDefault(){},stopPropagation(){}});
  if(action==='reset')f.timeline.reset(24);
  if(action==='lock')f.timeline.lock(true);
  if(action==='stop')f.timeline.stop();
  const interrupted=f.timeline.getView();
  f.advance(1000);
  assert.deepEqual(f.timeline.getView(),interrupted,'旧动画不能恢复');
  if(action==='pointer'){
   assert.deepEqual(interrupted,middle);f.track.handlers.pointerup({pointerId:1});
  }
  if(action==='keyboard'){f.advance(1420);assert.ok(f.timeline.getSelection().start>20);}
  if(action==='reset')assert.deepEqual(interrupted,{start:0,end:24});
 }
});

test('减少动态效果时直接聚焦且不安排动画帧',t=>{
 const f=fixture(t);globalThis.matchMedia=()=>({matches:true});
 f.timeline.reset(100);f.timeline.setSelection({start:30,end:40},true);
 assert.deepEqual(f.timeline.getView(),fitSelection(30,40,100));assert.equal(f.frames.size,0);
});


test('靠近首尾的细小选区在整个放大过程都留在视野内',t=>{
 const f=fixture(t);
 for(const selection of [{start:1,end:2},{start:98,end:99}]){
  f.timeline.reset(100);f.timeline.setSelection(selection,true);
  for(let now=0;now<=420;now+=21){
   f.advance(now);const view=f.timeline.getView();
   assert.ok(view.start<=selection.start&&view.end>=selection.end);
  }
 }
});

function arrow(f,target,key='ArrowRight',extra={}){
 const event={target,key,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};
 f.timeline.handleKeyDown(event);return event;
}

test('左右键按五秒调整播放位置，连续按键累积且不改选区',t=>{
 const f=fixture(t);
 for(const duration of [24,7200]){
  f.timeline.reset(duration);f.timeline.setCurrent(7);
  const writes=f.staticWrites();
  for(const [key,expected,extra]of [['ArrowRight',12,{}],['ArrowRight',17,{repeat:true}],['ArrowLeft',12,{shiftKey:true}]]){
   const event=arrow(f,f.track,key,extra);
   assert.equal(f.previews.at(-1),expected);assert.equal(event.defaultPrevented,true);assert.equal(event.stopped,true);
  }
  assert.deepEqual(f.timeline.getSelection(),{start:0,end:duration});assert.deepEqual(f.staticWrites(),writes);
  f.timeline.setCurrent(duration-2);arrow(f,f.track);assert.equal(f.previews.at(-1),duration);
  f.timeline.setCurrent(2);arrow(f,f.track,'ArrowLeft');assert.equal(f.previews.at(-1),0);
 }
});

test('点击任一边界会聚焦，缩放后与重复按键仍按五秒调整同一边界',t=>{
 const f=fixture(t);
 for(const duration of [24,7200])for(const type of ['start','end']){
  f.timeline.reset(duration,{start:6,end:duration-6});
  const handle=f[type+'Handle'];
  f.track.handlers.pointerdown({button:0,clientX:50,pointerId:1,target:handle,preventDefault(){}});
  f.track.handlers.pointerup({pointerId:1});assert.equal(handle.focused,true);
  f.advance(0);f.advance(420);
  const original=f.timeline.getSelection(),key=type==='start'?'ArrowLeft':'ArrowRight',expected=type==='start'?1:duration-1;
  arrow(f,handle,key,{shiftKey:true});assert.equal(f.timeline.getSelection()[type],expected);assert.equal(f.previews.at(-1),expected);
  const other=type==='start'?'end':'start';assert.equal(f.timeline.getSelection()[other],original[other]);
  arrow(f,handle,key,{repeat:true});assert.equal(f.timeline.getSelection()[type],type==='start'?0:duration);
  const before=f.timeline.getSelection();
  f.track.handlers.pointerdown({button:0,clientX:50,pointerId:2,target:f.track,preventDefault(){}});f.track.handlers.pointerup({pointerId:2});
  assert.equal(f.track.focused,true);const position=f.previews.at(-1);
  arrow(f,f.track,'ArrowLeft');assert.equal(f.previews.at(-1),Math.max(0,position-5));assert.deepEqual(f.timeline.getSelection(),before);
 }
});

test('方向键调整不能让起止点交叉，短于五秒的录像也保持有效选区',t=>{
 const f=fixture(t);
 for(const duration of [.0008,3,100]){
  f.timeline.reset(duration,{start:0,end:Math.min(duration,3)});
  arrow(f,f.startHandle);let selected=f.timeline.getSelection();assert.ok(selected.start>=0&&selected.start<selected.end);
  arrow(f,f.endHandle,'ArrowLeft');selected=f.timeline.getSelection();assert.ok(selected.end<=duration&&selected.end>selected.start);
 }
});

test('未加载、锁定、拖动、编辑输入和系统组合键不会被方向键逻辑接管',t=>{
 const f=fixture(t);
 assert.equal(arrow(f,f.track).defaultPrevented,undefined);
 f.timeline.reset(100);f.timeline.lock(true);assert.equal(arrow(f,f.startHandle).defaultPrevented,undefined);f.timeline.lock(false);
 for(const extra of [{altKey:true},{ctrlKey:true},{metaKey:true},{isComposing:true},{defaultPrevented:true},{key:'ArrowUp'},{target:{tagName:'INPUT'}},{target:{isContentEditable:true}}]){
  const count=f.previews.length;arrow(f,f.track,'ArrowRight',extra);assert.equal(f.previews.length,count);
 }
 f.track.handlers.pointerdown({button:0,clientX:50,pointerId:1,target:f.track,preventDefault(){}});
 assert.equal(arrow(f,f.track).defaultPrevented,undefined);f.track.handlers.pointerup({pointerId:1});
 f.timeline.setCurrent(90);f.timeline.reset(100);arrow(f,f.track);assert.equal(f.previews.at(-1),5,'换场清除上一场播放位置');
});
