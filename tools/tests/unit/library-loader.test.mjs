import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryLoader} from '../../../src/app/library-loader.js';

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
