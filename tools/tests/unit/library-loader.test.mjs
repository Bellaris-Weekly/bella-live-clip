import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryLoader} from '../../../src/app/library-loader.js';

const member={id:'bella'};
const records=[{key:'one'}];

function deferred(){let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}

test('preload starts history and enriches before the consumer opens the library',async()=>{
 const history=deferred(),calls=[];
 const loader=createLibraryLoader({api:{history:async()=>{calls.push('history');return history.promise;}},schedules:{enrich:async value=>{calls.push(['enrich',value]);return {records:value.map(record=>({...record,schedule:null})),failed:false};}}});
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
 const loader=createLibraryLoader({api:{history:async()=>{historyCalls++;return history.promise;}},schedules:{enrich:async value=>{enrichCalls++;return {records:value,failed:false};}}});
 const preload=loader.preload(member);const controller=new AbortController();const open=loader.load(member,{signal:controller.signal});controller.abort();
 await assert.rejects(open,{name:'AbortError'});history.resolve(records);await preload;
 assert.equal(historyCalls,1);assert.equal(enrichCalls,1);assert.deepEqual(loader.get(member).records,records);
});

test('failed schedule enrichment retries from cached history without repeating the list request',async()=>{
 let historyCalls=0,enrichCalls=0,failed=true;
 const loader=createLibraryLoader({api:{history:async()=>{historyCalls++;return records;}},schedules:{enrich:async value=>{enrichCalls++;if(failed)return {records:value.map(record=>({...record,schedule:null})),failed:true};return {records:value.map(record=>({...record,schedule:{type:'单播'}})),failed:false};}}});
 const first=await loader.load(member);assert.equal(first.failed,true);failed=false;
 const second=await loader.load(member);assert.equal(second.failed,false);assert.equal(second.records[0].schedule.type,'单播');
 assert.equal(historyCalls,1);assert.equal(enrichCalls,2);
});
