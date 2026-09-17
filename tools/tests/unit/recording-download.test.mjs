import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingDownload} from '../../../src/media/recording-download.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const groups=count=>[{segments:Array.from({length:count},(_,i)=>({url:String(i),duration:2,range:{offset:i*4,length:4}}))}];

test('six concurrent reads finish out of order but yield in order and never refetch a consumed segment',async()=>{
  const starts=[],finish=new Map();let active=0,peak=0;
  const download=createRecordingDownload({request:async(url,{range})=>{
    starts.push(url);active++;peak=Math.max(peak,active);
    await new Promise(resolve=>finish.set(url,resolve));active--;
    return {data:new Uint8Array([range.offset]).buffer};
  }},groups(12));
  const iterator=download.segments();
  try{
    const first=iterator.next();await tick();assert.equal(starts.length,6);assert.equal(peak,6);
    for(const url of ['5','4','3','2','1'])finish.get(url)();
    await tick();assert.equal(starts.length,6,'prefetch must not run through the whole recording');
    finish.get('0')();assert.equal((await first).value.index,0);
    for(let i=1;i<12;i++){
      const next=iterator.next();await tick();
      for(const done of finish.values())done();
      const {value}=await next;assert.equal(value.index,i);assert.equal(value.data[0],i*4);
    }
    assert.equal((await iterator.next()).done,true);assert.equal(new Set(starts).size,12);assert.equal(starts.length,12);
  }finally{await iterator.return();await download.close();}
});

test('byte reservations stop prefetch at the budget and consumption releases space',async()=>{
  const seen=[];
  const download=createRecordingDownload({request:async url=>{seen.push(url);return {data:new ArrayBuffer(4)};}},groups(10),{maxBytes:8});
  const iterator=download.segments();
  try{
    await iterator.next();await tick();assert.deepEqual(seen,['0','1']);
    await iterator.next();await tick();assert.deepEqual(seen,['0','1','2']);
  }finally{await iterator.return();await download.close();}
});

test('one oversized demanded segment progresses without downloading the remainder into memory',async()=>{
  const seen=[],items=groups(4);for(const s of items[0].segments)s.range.length=32;
  const download=createRecordingDownload({request:async url=>{seen.push(url);return {data:new ArrayBuffer(32)};}},items,{maxBytes:8});
  const iterator=download.segments();
  try{
    for(let i=0;i<4;i++){assert.equal((await iterator.next()).value.index,i);assert.equal(seen.length,i+1);}
  }finally{await iterator.return();await download.close();}
});

test('failure or cancellation aborts the other requests and leaves no speculative task running',async()=>{
  for(const cancel of [true,false]){
    const controller=new AbortController(),failure=new Error('permanent failure');let active=0,fail;
    const download=createRecordingDownload({request:(url,{signal})=>new Promise((resolve,reject)=>{
      active++;signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true});
      if(url==='0')fail=()=>reject(failure);
    })},groups(8),{signal:controller.signal});
    const iterator=download.segments(),pending=iterator.next();await tick();
    if(cancel)controller.abort(failure);else fail();
    await assert.rejects(pending,error=>error===failure);await download.close();assert.equal(active,0);
  }
});
