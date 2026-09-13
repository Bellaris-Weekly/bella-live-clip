import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTimeline} from '../../../src/ui/timeline.js';

class Element {
  writes=0; children=[]; attributes={}; handlers={}; dataset={};
  classList={add(){},remove(){}};
  style=new Proxy({}, {set:(target,key,value)=>{this.writes++;target[key]=value;return true;}});
  set textContent(value){this.writes++;this.text=value;}
  get textContent(){return this.text;}
  setAttribute(key,value){this.writes++;this.attributes[key]=value;}
  replaceChildren(...children){this.writes++;this.children=children;}
  append(...children){this.writes++;this.children.push(...children);}
  addEventListener(name,handler){this.handlers[name]=handler;}
  getBoundingClientRect(){return {left:0,width:100};}
  closest(){return this.dataset.handle?this:null;}
  setPointerCapture(){this.captured=true;}
  hasPointerCapture(){return this.captured;}
  releasePointerCapture(){this.captured=false;}
}

function fixture(t){
  for(const [key,value] of [['document',{createElement:()=>new Element()}],['cancelAnimationFrame',()=>{}]]){
    const saved=Object.getOwnPropertyDescriptor(globalThis,key);
    globalThis[key]=value;
    t.after(()=>{if(saved)Object.defineProperty(globalThis,key,saved);else delete globalThis[key];});
  }
  const elements=Object.fromEntries(['track','startHandle','endHandle','selectionElement','playhead','ticks','labels'].map(key=>[key,new Element()]));
  elements.startHandle.dataset.handle='start';elements.endHandle.dataset.handle='end';
  const previews=[],selections=[];
  const timeline=createTimeline({...elements,onPreview:value=>previews.push(value),onSelection:value=>selections.push(value)});
  const staticElements=[elements.startHandle,elements.endHandle,elements.selectionElement,elements.labels,elements.ticks,...elements.ticks.children];
  return {...elements,timeline,previews,selections,staticWrites:()=>staticElements.map(el=>el.writes)};
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
