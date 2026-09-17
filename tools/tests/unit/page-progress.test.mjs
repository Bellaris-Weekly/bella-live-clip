import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindPageProgress} from '../../../src/ui/page-progress.js';

test('native progress drag reuses its image and lets the site own the final seek',t=>{
 const frames=new Map();let next=0;
 const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
 globalThis.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 t.after(()=>{globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;});
 const flush=()=>{const values=[...frames.values()];frames.clear();for(const fn of values)fn();};
 const document=new EventTarget(),calls=[],video={duration:4000,currentTime:10};
 const image={complete:true,naturalWidth:320},label={textContent:'01:02:03'};
 const track={getBoundingClientRect:()=>({left:100,width:1000})};let active=true,available=true;
 document.querySelector=selector=>selector.includes('preview-image')?(available?image:null):selector.includes('preview-time')?label:video;
 const player={begin:()=>calls.push(['begin']),previewImage:(img,time)=>calls.push(['image',img,time]),seek:time=>calls.push(['seek',time]),end:options=>calls.push(['end',options])};
 const unbind=bindPageProgress({document,getPlayer:()=>player,isActive:()=>active});
 function event(type,extra={}){const e=new Event(type);Object.defineProperties(e,Object.fromEntries(Object.entries({button:0,pointerId:1,clientX:600,target:{closest:()=>track},...extra}).map(([key,value])=>[key,{value}])));document.dispatchEvent(e);}
 event('pointerdown');flush();assert.deepEqual(calls,[['begin'],['image',image,3723]]);
 assert.equal(video.currentTime,10);
 event('pointerup');assert.equal(calls.length,2);video.currentTime=3724;flush();assert.deepEqual(calls.at(-1),['end',{commit:false}]);assert.equal(video.currentTime,3724);
 available=false;event('pointerdown');flush();assert.deepEqual(calls.at(-1),['seek',2000]);
 event('pointercancel');flush();assert.deepEqual(calls.at(-1),['end',{commit:false}]);
 active=false;const count=calls.length;event('pointerdown');flush();assert.equal(calls.length,count);
 unbind();active=true;event('pointerdown');assert.equal(calls.length,count);
});
