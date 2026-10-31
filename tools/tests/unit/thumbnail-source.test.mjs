import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createThumbnailSource,thumbnailImageUrl} from '../../../src/services/thumbnail-source.js';

const record={key:'742106027349433696',start:1000,uid:123};
const sample=time=>({time,local:time,stream:{stream:'media',start_time:1000,end_time:100000}});
const signal=()=>new AbortController().signal;
const makeCanvas=()=>({width:0,height:0,args:[],getContext(){return {drawImage:(...args)=>this.args.push(args)};}});
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve};};
const image=()=>({closed:false,close(){this.closed=true;}});
function fixture(overrides={}){
 const requests=[],batches=[],images=[],loads=[];let fallbacks=0;
 const source=createThumbnailSource({record,makeCanvas,
  api:{keyframes:async(owner,times,signal)=>{assert.equal(owner,record);batches.push(times);return times.map(time=>({ts:1000+Math.round(time),url:`https://i0.hdslb.com/${Math.round(time)}.jpg`}));}},
  load:async url=>{loads.push(url);const item=image();images.push(item);return item;},
  request:async(url,options)=>{requests.push({url,options});return {data:new ArrayBuffer(1)};},
  decode:async()=>{const item=image();images.push(item);return item;},
  readFrame:async()=>{fallbacks++;return 'decoded-frame';},...overrides});
 return {source,requests,batches,images,loads,get fallbacks(){return fallbacks;}};
}

test('live stills are indexed on a fixed grid, so nearby views reuse one query and one image',async()=>{
 const f=fixture(),samples=[sample(61),sample(182)],s=signal();
 await f.source.prepare(samples,s);assert.deepEqual(f.batches,[[60,180]]);
 const first=await f.source.read(samples[0],s),second=await f.source.read(samples[1],s);
 assert.equal(f.fallbacks,0);assert.equal(f.loads.length,2);assert.equal(f.requests.length,0,'images skip the userscript manager');
 assert.ok(f.images.every(item=>item.closed));assert.equal(first.width,160);assert.equal(second.height,90);
 const again=await f.source.read(sample(70),s);assert.notEqual(first,again,'cached canvases must not be moved out of the visible strip');
 await f.source.prepare([sample(65),sample(175)],s);assert.equal(f.batches.length,1);assert.equal(f.loads.length,2);f.source.dispose();
});

test('stills are matched by request position: the service may snap timestamps or leave gaps, as on B 站',async()=>{
 const f=fixture({api:{keyframes:async()=>[{ts:1057,url:'https://i0.hdslb.com/snapped.jpg'},{ts:1120,url:''},{ts:1180,url:'https://i0.hdslb.com/third.jpg'}]}}),s=signal();
 await f.source.prepare([sample(60),sample(120),sample(180)],s);
 assert.equal(f.source.frameUrl(60),'https://i0.hdslb.com/snapped.jpg');
 assert.equal(f.source.frameUrl(120),'https://i0.hdslb.com/snapped.jpg','an empty position shows the previous image');
 assert.equal(f.source.frameUrl(180),'https://i0.hdslb.com/third.jpg');f.source.dispose();
});

test('missing or unsafe platform images use a nearby still and decode only when none is close',async()=>{
 const f=fixture({api:{keyframes:async()=>[{ts:1060,url:'https://i0.hdslb.com/good.jpg'},{ts:1120,url:'https://evil.example/frame.jpg'},{ts:9999,url:'https://i0.hdslb.com/wrong-time.jpg'}]}});
 const samples=[sample(60),sample(120),sample(180)],s=signal();await f.source.prepare(samples,s);
 for(const item of samples)await f.source.read(item,s);
 assert.equal(f.fallbacks,0);assert.deepEqual([...new Set(f.loads)],['https://i0.hdslb.com/good.jpg']);
 assert.equal(f.source.frameUrl(180),'https://i0.hdslb.com/good.jpg');assert.equal(f.source.frameUrl(3600),null);
 await f.source.prepare([sample(3600)],s);await f.source.read(sample(3600),s);assert.equal(f.fallbacks,1);f.source.dispose();
 assert.equal(thumbnailImageUrl('//i0.hdslb.com/frame.jpg'),'https://i0.hdslb.com/frame.jpg');
 for(const url of ['https://hdslb.com.evil.example/a','data:image/png;base64,a','javascript:alert(1)'])assert.throws(()=>thumbnailImageUrl(url));
});

test('never asks for a still beyond the available footage',async()=>{
 const f=fixture(),s=signal();
 await f.source.prepare([{time:170,local:170,stream:{start_time:1000,end_time:1175}}],s);
 assert.deepEqual(f.batches,[[120]]);f.source.dispose();
});

test('the background index covers every part in bounded chronological batches, nearest first',async()=>{
 const f=fixture();
 await f.source.warm([{start_time:1000,end_time:1000+7200}],7200);
 assert.ok(f.batches.every(batch=>batch.length<=30&&batch.every((time,i)=>!i||time>batch[i-1])));
 assert.equal(f.batches.flat().length,121);assert.ok(f.batches[0].includes(7200),'live sessions fill from the newest picture');
 const calls=f.batches.length;await f.source.warm([{start_time:1000,end_time:1000+7200}],0);assert.equal(f.batches.length,calls);
 await f.source.warm([{start_time:1000,end_time:1000+7260}],7260);assert.deepEqual(f.batches.at(-1),[7260],'live growth only asks for new positions');
 f.source.dispose();
});

test('failed or timed out image metadata does not repeatedly block extraction for the same record',async()=>{
 for(const pending of [false,true]){
  let calls=0;
  const f=fixture({timeout:10,api:{keyframes:async()=>{calls++;if(pending)return new Promise(()=>{});throw new Error('login required');}}}),s=signal();
  await f.source.prepare([sample(60)],s);assert.equal(await f.source.read(sample(60),s),'decoded-frame');
  await f.source.prepare([sample(120)],s);assert.equal(await f.source.read(sample(120),s),'decoded-frame');
  await f.source.warm([{start_time:1000,end_time:2000}]);
  assert.equal(calls,1);assert.equal(f.fallbacks,2);f.source.dispose();
 }
});

test('cancelled views stop waiting but keep the shared batch for the next view',async()=>{
 let calls=0;const wait=deferred();
 const f=fixture({api:{keyframes:async()=>{calls++;return wait.promise;}}});
 const controller=new AbortController(),pending=f.source.prepare([sample(60)],controller.signal);
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
 const s=signal(),next=f.source.prepare([sample(60)],s);wait.resolve([{ts:1060,url:'https://i0.hdslb.com/new.jpg'}]);await next;await f.source.read(sample(60),s);
 assert.equal(calls,1);assert.deepEqual(f.loads,['https://i0.hdslb.com/new.jpg']);assert.equal(f.fallbacks,0);f.source.dispose();
});

test('images blocked for the page are fetched through the userscript manager',async()=>{
 const f=fixture({load:async()=>{throw new Error('blocked');}}),s=signal();
 await f.source.prepare([sample(60)],s);await f.source.read(sample(60),s);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.auth,undefined);assert.equal(f.requests[0].options.type,'arraybuffer');
 assert.equal(f.fallbacks,0);f.source.dispose();
});

test('a stalled image download is aborted before falling back to frame extraction',async()=>{
 let imageSignal;
 const f=fixture({timeout:10,load:(_,signal)=>{imageSignal=signal;return new Promise(()=>{});},request:async()=>{throw new Error('offline');}}),s=signal();
 await f.source.prepare([sample(60)],s);assert.equal(await f.source.read(sample(60),s),'decoded-frame');
 assert.equal(imageSignal.aborted,true);assert.equal(f.fallbacks,1);f.source.dispose();
});

test('disposing during image decoding closes the bitmap and prevents late canvas publication',async()=>{
 const decoded=deferred(),started=deferred();let closed=false;
 const f=fixture({load:()=>{started.resolve();return decoded.promise;}}),s=signal();
 await f.source.prepare([sample(60)],s);const read=f.source.read(sample(60),s);
 const rejected=assert.rejects(read,{name:'AbortError'});await started.promise;f.source.dispose();
 decoded.resolve({close(){closed=true;}});await rejected;assert.equal(f.fallbacks,0);
 await new Promise(resolve=>setImmediate(resolve));
});

test('thumbnail cache is bounded across long timeline exploration',async()=>{
 const f=fixture(),s=signal();
 for(let slot=0;slot<301;slot++){await f.source.prepare([sample(slot*60)],s);await f.source.read(sample(slot*60),s);}
 await f.source.read(sample(300*60),s);assert.equal(f.loads.length,301);
 await f.source.prepare([sample(0)],s);await f.source.read(sample(0),s);assert.equal(f.loads.length,302);f.source.dispose();
});

test('submission strips use the platform storyboard and keep decoding as a fallback',async()=>{
 let disposed=false,reads=0;
 const f=fixture({record:{kind:'submission',bvid:'BV-test',cid:12},createStoryboard:()=>({
  async read(time){reads++;if(time===20)throw new Error('no storyboard');return {image:{},x:10,y:20,width:320,height:180};},
  dispose(){disposed=true;},
 })});
 const s=signal();await f.source.prepare([sample(10),sample(20)],s);
 const frame=await f.source.read(sample(10),s);await f.source.read(sample(20),s);
 assert.equal(frame.args[0][0].args[0].length,9);assert.equal(reads,2);assert.equal(f.fallbacks,1);assert.equal(f.batches.length,0);
 f.source.dispose();assert.equal(disposed,true);
});
