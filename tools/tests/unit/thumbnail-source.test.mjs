import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createThumbnailSource,thumbnailImageUrl} from '../../../src/services/thumbnail-source.js';

const record={key:'742106027349433696',start:1000,uid:123};
const sample=time=>({time,local:time,stream:{stream:'media'}});
const signal=()=>new AbortController().signal;
const makeCanvas=()=>({width:0,height:0,args:[],getContext(){return {drawImage:(...args)=>this.args.push(args)};}});
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve};};
function fixture(overrides={}){
 const requests=[],batches=[],images=[];let fallbacks=0;
 const source=createThumbnailSource({record,makeCanvas,
  api:{keyframes:async(owner,times,signal)=>{assert.equal(owner,record);batches.push(times);return times.map(time=>({ts:1000+Math.round(time),url:`https://i0.hdslb.com/${Math.round(time)}.jpg`}));}},
  request:async(url,options)=>{requests.push({url,options});return {data:new ArrayBuffer(1)};},
  decode:async()=>{const image={closed:false,close(){this.closed=true;}};images.push(image);return image;},
  readFrame:async()=>{fallbacks++;return 'decoded-frame';},...overrides});
 return {source,requests,batches,images,get fallbacks(){return fallbacks;}};
}

test('live thumbnail images are fetched in one timestamp query with anonymous image downloads and reusable small canvases',async()=>{
 const f=fixture(),samples=[sample(10),sample(20)],s=signal();
 await f.source.prepare(samples,s);assert.deepEqual(f.batches,[[10,20]]);
 const first=await f.source.read(samples[0],s),second=await f.source.read(samples[1],s);
 assert.equal(f.fallbacks,0);assert.equal(f.requests.length,2);assert.ok(f.requests.every(({options})=>options.auth===undefined&&options.type==='arraybuffer'));
 assert.ok(f.images.every(image=>image.closed));assert.equal(first.width,160);assert.equal(second.height,90);
 const again=await f.source.read(samples[0],s);assert.notEqual(first,again,'cached canvases must not be moved out of the visible strip');
 await f.source.prepare(samples,s);assert.equal(f.batches.length,1);assert.equal(f.requests.length,2);f.source.dispose();
});

test('missing or unsafe platform images fall back only for the affected times',async()=>{
 const f=fixture({api:{keyframes:async()=>[{ts:1010,url:'https://i0.hdslb.com/good.jpg'},{ts:1020,url:'https://evil.example/frame.jpg'},{ts:9999,url:'https://i0.hdslb.com/wrong-time.jpg'}]}});
 const samples=[sample(10),sample(20),sample(30)],s=signal();await f.source.prepare(samples,s);
 for(const item of samples)await f.source.read(item,s);
 assert.equal(f.requests.length,1);assert.equal(f.fallbacks,2);f.source.dispose();
 assert.equal(thumbnailImageUrl('//i0.hdslb.com/frame.jpg'),'https://i0.hdslb.com/frame.jpg');
 for(const url of ['https://hdslb.com.evil.example/a','data:image/png;base64,a','javascript:alert(1)'])assert.throws(()=>thumbnailImageUrl(url));
});

test('failed or timed out image metadata does not repeatedly block extraction for the same record',async()=>{
 for(const pending of [false,true]){
  let calls=0;
  const f=fixture({timeout:10,api:{keyframes:async()=>{calls++;if(pending)return new Promise(()=>{});throw new Error('login required');}}}),s=signal();
  await f.source.prepare([sample(10)],s);assert.equal(await f.source.read(sample(10),s),'decoded-frame');
  await f.source.prepare([sample(20)],s);assert.equal(await f.source.read(sample(20),s),'decoded-frame');
  assert.equal(calls,1);assert.equal(f.fallbacks,2);f.source.dispose();
 }
});

test('cancelled views do not poison the image source or start fallback extraction',async()=>{
 let calls=0;const wait=deferred();
 const f=fixture({api:{keyframes:async()=>++calls===1?wait.promise:[{ts:1020,url:'https://i0.hdslb.com/new.jpg'}]}});
 const controller=new AbortController(),pending=f.source.prepare([sample(10)],controller.signal);
 controller.abort();await assert.rejects(pending,{name:'AbortError'});wait.resolve([{ts:1010,url:'https://i0.hdslb.com/old.jpg'}]);
 const s=signal();await f.source.prepare([sample(20)],s);await f.source.read(sample(20),s);
 assert.equal(calls,2);assert.equal(f.requests[0].url,'https://i0.hdslb.com/new.jpg');assert.equal(f.fallbacks,0);f.source.dispose();
});

test('a stalled image download is aborted before falling back to frame extraction',async()=>{
 let imageSignal;
 const f=fixture({timeout:10,request:async(_,{signal})=>{imageSignal=signal;return new Promise(()=>{});}}),s=signal();
 await f.source.prepare([sample(10)],s);assert.equal(await f.source.read(sample(10),s),'decoded-frame');
 assert.equal(imageSignal.aborted,true);assert.equal(f.fallbacks,1);f.source.dispose();
});

test('disposing during image decoding closes the bitmap and prevents late canvas publication',async()=>{
 const decoded=deferred(),started=deferred();let closed=false;
 const f=fixture({decode:()=>{started.resolve();return decoded.promise;}}),s=signal();
 await f.source.prepare([sample(10)],s);const read=f.source.read(sample(10),s);
 const rejected=assert.rejects(read,{name:'AbortError'});await started.promise;f.source.dispose();
 decoded.resolve({close(){closed=true;}});await rejected;assert.equal(closed,true);assert.equal(f.fallbacks,0);
});

test('thumbnail cache is bounded across long timeline exploration',async()=>{
 const f=fixture(),s=signal();
 for(let time=0;time<49;time++){await f.source.prepare([sample(time)],s);await f.source.read(sample(time),s);}
 await f.source.read(sample(48),s);assert.equal(f.requests.length,49);
 await f.source.prepare([sample(0)],s);await f.source.read(sample(0),s);assert.equal(f.requests.length,50);f.source.dispose();
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
