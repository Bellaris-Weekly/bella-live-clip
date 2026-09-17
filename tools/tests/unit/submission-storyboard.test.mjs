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

test('storyboard uses matching video/part metadata and caches only the current sheet',async()=>{
 const requests=[],bitmaps=[];
 const preview=createSubmissionStoryboard({submission:{bvid:'BV1zhe36nEDa',cid:123,referer:'https://www.bilibili.com/video/BV1zhe36nEDa/'},
  metadataRequest:async(url,options)=>{requests.push(url);assert.equal(new URL(url).searchParams.get('cid'),'123');assert.equal(options.auth,true);return {data:JSON.stringify({code:0,data})};},
  mediaRequest:async(url,options)=>{requests.push(url);assert.equal(options.auth,undefined);assert.equal(options.type,'arraybuffer');return {data:new ArrayBuffer(1)};},
  decode:async()=>{const bitmap={width:640,height:360,closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;}});
 const signal=new AbortController().signal;
 const first=await preview.read(9,signal);assert.equal(first.x,320);assert.equal(first.width,320);
 await preview.read(11,signal);assert.equal(requests.length,2);
 await preview.read(20,signal);assert.equal(requests.length,3);assert.equal(bitmaps[0].closed,true);
 preview.dispose();assert.equal(bitmaps[1].closed,true);
});

test('aborted decoding releases the bitmap and cannot replace a later preview',async()=>{
 const controller=new AbortController();let closed=false;
 const preview=createSubmissionStoryboard({submission:{bvid:'BV1zhe36nEDa',cid:123},metadataRequest:async()=>({data:JSON.stringify({code:0,data})}),mediaRequest:async()=>({data:new ArrayBuffer(1)}),decode:async()=>{controller.abort();return {close(){closed=true;}};}});
 await assert.rejects(preview.read(0,controller.signal),error=>error===controller.signal.reason);assert.equal(closed,true);preview.dispose();
});
