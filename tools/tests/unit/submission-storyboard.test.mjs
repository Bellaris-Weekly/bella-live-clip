import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storyboardCell,createSubmissionStoryboard} from '../../../src/services/submission-storyboard.js';
const data={img_x_len:2,img_y_len:2,img_x_size:480,img_y_size:270,image:['//bimp.hdslb.com/a.jpg','//bimp.hdslb.com/b.jpg'],index:[0,0,5,10,15,20,25]};

test('time index maps to the correct sprite cell across rows, sheets and end boundaries',()=>{
 for(const index of [data.index,data.index.slice(1)]){
  for(const [time,x,y,sheet]of [[0,0,0,'a'],[9,480,0,'a'],[10,0,270,'a'],[20,0,0,'b'],[99,480,0,'b']]){
   const cell=storyboardCell({...data,index},time);assert.equal(cell.x,x);assert.equal(cell.y,y);assert.equal(cell.url,`https://bimp.hdslb.com/${sheet}.jpg`);
  }
 }
});

test('empty previews and foreign image origins fail without sending credentials',()=>{
 for(const value of [{...data,index:[]},{...data,image:[]},{...data,image:['https://hdslb.com.evil.test/a']}])assert.throws(()=>storyboardCell(value,0));
});

test('storyboard uses matching video/part metadata and reuses both sides of a sheet boundary',async()=>{
 const requests=[],bitmaps=[];
 const preview=createSubmissionStoryboard({submission:{bvid:'BV1zhe36nEDa',cid:123,referer:'https://www.bilibili.com/video/BV1zhe36nEDa/'},
  metadataRequest:async(url,options)=>{requests.push(url);assert.equal(new URL(url).searchParams.get('cid'),'123');assert.equal(options.auth,true);return {data:JSON.stringify({code:0,data})};},
  mediaRequest:async(url,options)=>{requests.push(url);assert.equal(options.auth,undefined);assert.equal(options.type,'arraybuffer');return {data:new ArrayBuffer(1)};},
  decode:async()=>{const bitmap={width:640,height:360,closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;}});
 const signal=new AbortController().signal;
 const first=await preview.read(9,signal);assert.equal(first.x,320);assert.equal(first.width,320);
 await preview.read(11,signal);assert.equal(requests.length,2);
 await preview.read(20,signal);assert.equal(requests.length,3);assert.equal(bitmaps[0].closed,false);
 await preview.read(9,signal);await preview.read(20,signal);assert.equal(requests.length,3);
 preview.dispose();assert.equal(bitmaps[0].closed,true);assert.equal(bitmaps[1].closed,true);
});

test('canceling a consumer during decoding retains the shared bitmap until disposal',async()=>{
 const controller=new AbortController();let closed=false;
 const preview=createSubmissionStoryboard({submission:{bvid:'BV1zhe36nEDa',cid:123},metadataRequest:async()=>({data:JSON.stringify({code:0,data})}),mediaRequest:async()=>({data:new ArrayBuffer(1)}),decode:async()=>{controller.abort();return {close(){closed=true;}};}});
 await assert.rejects(preview.read(0,controller.signal),error=>error===controller.signal.reason);assert.equal(closed,false);preview.dispose();assert.equal(closed,true);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(metadata=data){
 const info=deferred(),requests=[],bitmaps=[];
 let metadataCalls=0,metadataSignal;
 const preview=createSubmissionStoryboard({submission:{bvid:'BV-test',cid:456},
  metadataRequest:(_,{signal})=>{metadataCalls++;metadataSignal=signal;return info.promise;},
  mediaRequest:(url,{signal})=>{const pending=deferred();requests.push({url,signal,...pending});return pending.promise;},
  decode:async()=>{const image={width:640,height:360,closed:false,close(){this.closed=true;}};bitmaps.push(image);return image;}});
 return {preview,info,requests,bitmaps,get metadataCalls(){return metadataCalls;},get metadataSignal(){return metadataSignal;},
  metadata(){info.resolve({data:JSON.stringify({code:0,data:metadata})});},
  image(index){requests[index].resolve({data:new ArrayBuffer(1)});}};
}

test('rapid positions share pending metadata and image requests while old callers cancel promptly',async()=>{
 for(const [first,second,third]of [[0,9,14],[20,21,25]]){
  const f=fixture(),a=new AbortController(),b=new AbortController(),c=new AbortController();
  const old=f.preview.read(first,a.signal);const oldRejected=assert.rejects(old,error=>error===a.signal.reason);
  a.abort();await oldRejected;
  const next=f.preview.read(second,b.signal);const nextRejected=assert.rejects(next,error=>error===b.signal.reason);
  assert.equal(f.metadataCalls,1);assert.equal(f.metadataSignal.aborted,false);
  f.metadata();await flush();assert.equal(f.requests.length,1);
  b.abort();await nextRejected;assert.equal(f.requests[0].signal.aborted,false);
  const latest=f.preview.read(third,c.signal);await flush();assert.equal(f.requests.length,1);
  f.image(0);const frame=await latest;
  assert.equal(frame.image,f.bitmaps[0]);assert.equal(f.bitmaps.length,1);
  f.preview.dispose();assert.equal(f.bitmaps[0].closed,true);
 }
});

test('crossing a boundary while both images load reuses requests and crops each response correctly',async()=>{
 const f=fixture(),signal=new AbortController().signal;f.metadata();
 const a=f.preview.read(9,signal);await flush();
 const b=f.preview.read(20,signal);await flush();
 const back=f.preview.read(14,signal);await flush();assert.equal(f.requests.length,2);
 f.image(1);const right=await b;assert.equal(right.x,0);assert.equal(right.y,0);
 f.image(0);const [left,returned]=await Promise.all([a,back]);
 assert.equal(left.image,returned.image);assert.notEqual(left.image,right.image);
 assert.equal(left.x,320);assert.equal(left.y,0);assert.equal(returned.x,0);assert.equal(returned.y,180);
 f.preview.dispose();assert.ok(f.bitmaps.every(image=>image.closed));
});

test('sheet cache evicts the least recently used bitmap and aborts evicted pending downloads',async()=>{
 const extended={...data,image:[...data.image,'//bimp.hdslb.com/c.jpg'],index:[0,5,10,15,20,25,30,35,40]};
 const f=fixture(extended),signal=new AbortController().signal;f.metadata();
 const a=f.preview.read(0,signal);await flush();f.image(0);await a;
 const b=f.preview.read(20,signal);await flush();f.image(1);await b;
 await f.preview.read(0,signal); // A is now most recently used.
 const c=f.preview.read(40,signal);await flush();
 assert.equal(f.bitmaps[0].closed,false);assert.equal(f.bitmaps[1].closed,true);
 f.image(2);await c;
 const again=f.preview.read(20,signal);await flush();assert.equal(f.requests.length,4);
 f.image(3);await again;f.preview.dispose();assert.ok(f.bitmaps.every(image=>image.closed));

 const pending=fixture(extended);pending.metadata();
 const first=pending.preview.read(0,signal);const rejected=assert.rejects(first,{name:'AbortError'});await flush();
 const second=pending.preview.read(20,signal);await flush();
 const third=pending.preview.read(40,signal);await flush();
 assert.equal(pending.requests[0].signal.aborted,true);
 pending.image(0);pending.image(1);pending.image(2);
 await Promise.all([rejected,second,third]);assert.equal(pending.bitmaps.length,2);pending.preview.dispose();
});

test('failed shared requests can retry and disposing prevents new work or late decoded images',async()=>{
 const f=fixture(),signal=new AbortController().signal;f.metadata();
 const first=f.preview.read(0,signal),rejected=assert.rejects(first,/offline/);await flush();
 f.requests[0].reject(new Error('offline'));await rejected;
 const retry=f.preview.read(9,signal);await flush();assert.equal(f.metadataCalls,1);assert.equal(f.requests.length,2);
 f.image(1);await retry;f.preview.dispose();
 await assert.rejects(f.preview.read(20,signal),{name:'AbortError'});assert.equal(f.requests.length,2);

 const decoding=deferred(),started=deferred();let closed=false;
 const preview=createSubmissionStoryboard({submission:{bvid:'BV-test',cid:789},
  metadataRequest:async()=>({data:JSON.stringify({code:0,data})}),mediaRequest:async()=>({data:new ArrayBuffer(1)}),
  decode:()=>{started.resolve();return decoding.promise;}});
 const read=preview.read(0,signal),lateRejected=assert.rejects(read,{name:'AbortError'});
 await started.promise;preview.dispose();decoding.resolve({close(){closed=true;}});
 await lateRejected;assert.equal(closed,true);
});
