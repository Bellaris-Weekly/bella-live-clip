import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createControls} from '../../../src/ui/controls.js';

function fixture(){
  const writes=[];
  const element=(id,initial={})=>new Proxy({id,disabled:false,hidden:false,...initial},{set(target,key,value){writes.push([id,key,value]);target[key]=value;return true;}});
  const ids=['markStart','markEnd','togglePlayback','wholeRecording','download','cancel','startHandle','endHandle','back','refreshEditor','refreshLibrary','copy','precise','member','cards','exportMode','progress','launcher'];
  const elements=Object.fromEntries(ids.map(id=>[id,element(id)]));
  const label=element('label',{textContent:'导出'});elements.download.querySelector=()=>label;
  elements.cards.children=[];elements.launcher.dataset=element('dataset');
  let queries=0;const locks=[];
  const root={getElementById:id=>elements[id],querySelectorAll(){queries++;return ids.slice(0,16).map(id=>elements[id]);}};
  const update=createControls(root,{lock:value=>locks.push(value)});
  writes.length=0;
  return {...elements,label,writes,locks,update,element,get queries(){return queries;}};
}

test('加载、整场及空闲状态一次计算可用性，取消按钮始终可用',()=>{
  const f=fixture();f.cards.children.push(f.element('card'));
  for(const busy of [false,true])for(const ready of [false,true])for(const whole of [false,true]){
    f.update({busy,ready,whole,page:'edit'});
    assert.equal(f.back.disabled,busy);assert.equal(f.cards.children[0].disabled,busy);
    assert.equal(f.download.disabled,busy||!ready);assert.equal(f.wholeRecording.disabled,busy||!ready);
    assert.equal(f.markStart.disabled,busy||!ready||whole);assert.equal(f.markEnd.disabled,busy||!ready||whole);
    assert.equal(f.locks.at(-1),busy||!ready||whole);
    assert.equal(f.cancel.disabled,false);assert.equal(f.cancel.hidden,!busy);
    assert.equal(f.exportMode.hidden,whole);assert.equal(f.label.textContent,whole?'导出整场':'导出');
    assert.equal(f.progress.hidden,!busy);assert.equal(f.download.hidden,false);
  }
});

test('重复渲染不写入 DOM，切换模式保留按钮节点，新建卡片正确禁用',()=>{
  const f=fixture(),state={busy:false,ready:true,whole:false,page:'edit'};
  f.update(state);const writes=f.writes.length,locks=f.locks.length;
  f.update(state);f.update(state);
  assert.equal(f.writes.length,writes);assert.equal(f.locks.length,locks);assert.equal(f.queries,1);
  f.update({...state,whole:true});
  assert.equal(f.download.querySelector('span'),f.label);
  assert.ok(f.writes.every(([,key])=>key!=='innerHTML'));
  const card=f.element('new-card');f.cards.children.push(card);
  f.update({...state,busy:true});assert.equal(card.disabled,true);
  f.update({...state,page:'library'});assert.equal(card.disabled,false);assert.equal(f.download.hidden,true);
});
