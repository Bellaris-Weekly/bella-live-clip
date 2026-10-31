import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryLoader} from '../../../src/app/library-loader.js';
import {BiliApi} from '../../../src/services/bilibili.js';
import {MEMBERS} from '../../../src/domain/records.js';

const member={id:'bella'};
const records=[{key:'one'}];

function deferred(){let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}

test('preload starts history and enriches before the consumer opens the library',async()=>{
 const history=deferred(),calls=[];
 const loader=createLibraryLoader({api:{current:async()=>null,history:async()=>{calls.push('history');return history.promise;}},schedules:{enrich:async value=>{calls.push(['enrich',value]);return {records:value.map(record=>({...record,schedule:null})),failed:false};}}});
 const preload=loader.preload(member);
 assert.deepEqual(calls,['history']);
 history.resolve(records);
 const result=await preload;
 assert.equal(result.records[0].key,'one');assert.deepEqual(calls,['history',['enrich',records]]);
 const before=calls.length;assert.deepEqual(await loader.load(member),result);assert.equal(calls.length,before);
 assert.deepEqual(loader.get(member),result);
});

test('concurrent open and preload share one request, while caller cancellation leaves preload alive',async()=>{
 const history=deferred();let historyCalls=0,enrichCalls=0;
 const loader=createLibraryLoader({api:{current:async()=>null,history:async()=>{historyCalls++;return history.promise;}},schedules:{enrich:async value=>{enrichCalls++;return {records:value,failed:false};}}});
 const preload=loader.preload(member);const controller=new AbortController();const open=loader.load(member,{signal:controller.signal});controller.abort();
 await assert.rejects(open,{name:'AbortError'});history.resolve(records);await preload;
 assert.equal(historyCalls,1);assert.equal(enrichCalls,1);assert.deepEqual(loader.get(member).records,records);
});

test('failed schedule enrichment retries from cached history without repeating the list request',async()=>{
 let historyCalls=0,enrichCalls=0,failed=true;
 const loader=createLibraryLoader({api:{current:async()=>null,history:async()=>{historyCalls++;return records;}},schedules:{enrich:async value=>{enrichCalls++;if(failed)return {records:value.map(record=>({...record,schedule:null})),failed:true};return {records:value.map(record=>({...record,schedule:{type:'单播'}})),failed:false};}}});
 const first=await loader.load(member);assert.equal(first.failed,true);failed=false;
 const second=await loader.load(member);assert.equal(second.failed,false);assert.equal(second.records[0].schedule.type,'单播');
 assert.equal(historyCalls,1);assert.equal(enrichCalls,2);
});

test('live sessions lead each member library, replace duplicate replays and share preload requests',async()=>{
 const calls=[];
 const loader=createLibraryLoader({api:{
  history:async member=>[{key:member.id+'-live',live:false},{key:member.id+'-old',live:false}],
  current:async(member,signal,options)=>{calls.push(member.id);assert.equal(options.allowOffline,true);return {key:member.id+'-live',live:true,member:member.id};},
 },schedules:{enrich:async records=>({records:records.map(record=>({...record,schedule:{type:'单播'}})),failed:false})}});
 for(const id of ['bella','sinuo']){
  const selected={id};const preload=loader.preload(selected);const result=await loader.load(selected);await preload;
  assert.deepEqual(result.records.map(record=>record.key),[id+'-live',id+'-old']);
  assert.equal(result.records[0].live,true);assert.equal(result.records[0].member,id);assert.equal(result.records[0].schedule.type,'单播');
 }
 assert.deepEqual(calls,['bella','sinuo']);
});

test('refresh discovers a newly started stream and removes live state after it ends',async()=>{
 let current=null,history=[];
 const loader=createLibraryLoader({api:{history:async()=>history,current:async()=>current},schedules:{enrich:async records=>({records,failed:false})}});
 assert.deepEqual((await loader.load(member)).records,[]);
 current={key:'new',live:true};
 assert.deepEqual((await loader.load(member,{refresh:true})).records,[current]);
 current=null;history=[{key:'new',live:false}];
 const result=await loader.load(member,{refresh:true});assert.deepEqual(result.records,history);assert.equal(result.ready,true);
});

test('a failed live lookup preserves history and retries instead of caching absence',async()=>{
 let failed=true,calls=0;
 const loader=createLibraryLoader({api:{history:async()=>records,current:async()=>{calls++;if(failed)throw new Error('network');return {key:'live',live:true};}},schedules:{enrich:async records=>({records,failed:false})}});
 const first=await loader.load(member);assert.deepEqual(first.records,records);assert.equal(first.liveFailed,true);assert.equal(first.ready,false);
 failed=false;const second=await loader.load(member);assert.equal(second.records[0].key,'live');assert.equal(second.liveFailed,false);assert.equal(second.ready,true);assert.equal(calls,2);
});

test('refresh cancels an old live lookup and prevents stale library replacement',async()=>{
 const pending=deferred();let calls=0;
 const loader=createLibraryLoader({api:{history:async()=>records,current:async()=>++calls===1?pending.promise:{key:'fresh',live:true}},schedules:{enrich:async records=>({records,failed:false})}});
 const old=loader.load(member);const rejection=assert.rejects(old,{name:'AbortError'});
 const fresh=await loader.load(member,{refresh:true});pending.resolve({key:'stale',live:true});await rejection;
 assert.deepEqual(loader.get(member),fresh);assert.equal(fresh.records[0].key,'fresh');
});

test('an activity live session missing from replay history appears in the member library and uses its exact clip identity',async()=>{
 const sinuo=MEMBERS.find(member=>member.id==='sinuo');
 const key='742106027349433696',title='【3D出道周年纪念直播】执笔入梦';
 let unavailable=true;const calls=[];
 const api=new BiliApi(async value=>{
  const url=new URL(value);calls.push(url);
  if(url.hostname==='live.bilibili.com')return {data:'<script>window.__BILIACT_EVAPAGEDATA__={};</script>'};
  let data;
  if(url.pathname.endsWith('/GetOtherSliceList')){
   data={replay_info:[{live_key:'741000000000000001',live_info:{title:'历史直播'},start_time:1793300000,end_time:1793303600,room_id:sinuo.room}],pagination:{total:1}};
  }else if(url.pathname.endsWith('/getRoomBaseInfo')){
   if(unavailable)return {data:JSON.stringify({code:-352})};
   data={by_room_ids:{[sinuo.room]:{room_id:sinuo.room,uid:sinuo.uid,title,live_status:1,live_id_str:key,live_time:'2026-10-31 19:50:47'}}};
  }else if(url.pathname.endsWith('/GetUserSliceStream')){
   assert.equal(url.searchParams.get('live_uid'),sinuo.uid);
   assert.equal(url.searchParams.get('live_key'),key);
   assert.equal(url.searchParams.get('start_time'),'1793447457');
   assert.equal(url.searchParams.get('end_time'),'1793447467');
   data={list:[{start_time:1793447457,end_time:1793447467}]};
  }else assert.fail(`unexpected request: ${url.pathname}`);
  return {data:JSON.stringify({code:0,data})};
 });
 const loader=createLibraryLoader({api,schedules:{enrich:async records=>({records,failed:false})}});
 const first=await loader.load(sinuo);
 assert.equal(first.liveFailed,true);assert.equal(first.ready,false);assert.equal(first.records.length,1);
 unavailable=false;calls.length=0;
 // The previous failure must not cache the absence of a current live session.
 const recovered=await loader.load(sinuo);
 assert.equal(recovered.liveFailed,false);assert.equal(recovered.ready,true);
 assert.deepEqual(recovered.records.map(record=>record.key),[key,'741000000000000001']);
 const live=recovered.records[0];assert.equal(live.title,title);assert.equal(live.live,true);assert.equal(live.member,'思诺');
 assert.ok(calls.every(url=>url.hostname==='api.live.bilibili.com'));
 assert.equal((await api.clips(live,10,20)).length,1);
});
