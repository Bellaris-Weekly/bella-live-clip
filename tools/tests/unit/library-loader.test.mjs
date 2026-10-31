import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryLoader} from '../../../src/app/library-loader.js';
import {BiliApi} from '../../../src/services/bilibili.js';
import {MEMBERS} from '../../../src/domain/records.js';

const member={id:'bella'};
const records=[{key:'one'}];

function deferred(){let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}

test('interactive library returns usable records before schedules or avatars finish',async()=>{
 const enrichment=deferred(),updates=[];let calls=0;
 const loader=createLibraryLoader({backgroundEnrichment:true,onUpdate:(member,result)=>updates.push(result),
  api:{history:async()=>records,current:async()=>null},
  schedules:{enrich:async value=>{calls++;return enrichment.promise;}}});
 const early=await loader.load(member);assert.deepEqual(early.records,records);assert.equal(early.pending,true);assert.equal(calls,1);
 assert.equal(await loader.load(member),early);assert.equal(updates.length,0);
 enrichment.resolve({records:[{key:'one',schedule:{type:'单播'}}],failed:false});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(updates.length,1);assert.equal(updates[0].ready,true);assert.equal(loader.get(member),updates[0]);
 assert.equal((await loader.load(member)).records[0].schedule.type,'单播');assert.equal(calls,1);
});

test('refresh cancels background enrichment and prevents stale schedule publication',async()=>{
 const old=deferred(),updates=[];let calls=0;
 const loader=createLibraryLoader({backgroundEnrichment:true,onUpdate:(_,result)=>updates.push(result),
  api:{history:async()=>records,current:async()=>null},
  schedules:{enrich:async value=>++calls===1?old.promise:{records:[{key:'fresh'}],failed:false}}});
 await loader.load(member);await loader.load(member,{refresh:true});
 await new Promise(resolve=>setImmediate(resolve));old.resolve({records:[{key:'stale'}],failed:false});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(updates.map(result=>result.records[0].key),['fresh']);assert.equal(loader.get(member).records[0].key,'fresh');
});

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

function storeFixture(saved){const writes=[];return {writes,read:()=>saved,write:(_,value)=>writes.push(value)};}
const ready={api:{history:async()=>records,current:async()=>null},schedules:{enrich:async value=>({records:value,failed:false})}};
test('a list saved by another tab within minutes needs no requests',async()=>{
 let calls=0;const store=storeFixture({time:1000,records:[{key:'saved'}]});
 const loader=createLibraryLoader({...ready,api:{...ready.api,history:async()=>{calls++;return records;}},store,now:()=>1000+60000});
 assert.equal((await loader.load(member)).records[0].key,'saved');assert.equal(calls,0);
});
test('an older saved list shows at once and refreshes behind it',async()=>{
 const store=storeFixture({time:1000,records:[{key:'saved'}]}),updates=[];
 const loader=createLibraryLoader({...ready,backgroundEnrichment:true,onUpdate:(_,result)=>updates.push(result),store,now:()=>1000+3600000});
 assert.equal(loader.get(member).records[0].key,'saved','visible before any request');
 await loader.load(member);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(loader.get(member).records[0].key,'one');assert.equal(updates.length,1);
 assert.equal(store.writes.length,1);assert.equal(store.writes[0].time,1000+3600000);
});
test('day-old, malformed and partial lists are not trusted',async()=>{
 for(const saved of [{time:1000,records:[{key:'old'}]},{time:1000+86400000*2-1,records:'x'},null]){
  const loader=createLibraryLoader({...ready,store:storeFixture(saved),now:()=>1000+86400000*2});
  assert.equal(loader.get(member),null);
 }
 const store=storeFixture(null);
 const loader=createLibraryLoader({...ready,api:{...ready.api,current:async()=>{throw new Error('offline');}},store});
 await loader.load(member);assert.equal(store.writes.length,0,'a list missing live status is not shared');
});
