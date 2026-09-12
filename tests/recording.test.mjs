import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Output,BufferTarget,Mp4OutputFormat,EncodedVideoPacketSource,EncodedPacket,Input,BufferSource,MP4} from 'mediabunny';
import {config,frame} from './synthetic-frame.mjs';
import {formatCompactTime,formatDuration} from '../src/core.js';
import {saveRecording,createSegmentCache,estimateRecordingRate,estimateSelectionBytes} from '../src/recording.js';

test('紧凑起止时间与中文时长覆盖进位和不同高位零',()=>{
 for(const [n,s]of [[0,'0.000'],[9.125,'9.125'],[65.2,'1:05.200'],[3605.25,'1:00:05.250'],[59.9996,'1:00.000']])assert.equal(formatCompactTime(n),s);
 for(const [n,s]of [[0,'0.0秒'],[9.25,'9.3秒'],[59.96,'1分0.0秒'],[65.23,'1分5.2秒'],[3600,'1时0分0.0秒'],[3725.25,'1时2分5.3秒']])assert.equal(formatDuration(n),s);
});

test('预估按各段码率与相交时长计量，排除断流空隙',async()=>{
 const groups=[{start:100,segments:[{url:'a',duration:10,range:{offset:0,length:1000}}]},
  {start:120,segments:[{url:'b',duration:20}]}];
 const estimate=await estimateRecordingRate({request:async()=>({data:new ArrayBuffer(4000)})},groups);
 assert.equal(estimateSelectionBytes(estimate,100,{start:5,end:30}),2500);
 assert.equal(estimateSelectionBytes(estimate,100,{start:10,end:20}),0);
});

test('共享缓存按字节预算淘汰，并合并并发同片请求',async()=>{
 const seen=[];const read=createSegmentCache({request:async url=>{seen.push(url);return {data:new ArrayBuffer(4)};}},{maxBytes:8});
 await Promise.all([read({url:'a'}),read({url:'a'})]);await read({url:'b'});await read({url:'a'});await read({url:'c'});await read({url:'b'});
 assert.deepEqual(seen,['a','b','c','b']);
});

async function fixture(){
 const output=new Output({format:new Mp4OutputFormat({fastStart:'fragmented'}),target:new BufferTarget()});
 const source=new EncodedVideoPacketSource('avc');output.addVideoTrack(source);await output.start();
 const decoderConfig={...config,description:new Uint8Array(Buffer.from(config.description,'base64'))};
 for(let i=0;i<2400;i++)await source.add(new EncodedPacket(new Uint8Array(Buffer.from(frame,'base64')),'key',i/800,1/800),{decoderConfig});
 await output.finalize();return new Uint8Array(output.target.buffer);
}
function splitMp4(data){let cursor=0;while(cursor<data.length){const size=new DataView(data.buffer,data.byteOffset+cursor).getUint32(0);const type=new TextDecoder().decode(data.subarray(cursor+4,cursor+8));if(type==='moof')return [data.slice(0,cursor),data.slice(cursor)];cursor+=size;}throw new Error('No fragment');}
function disk(onWrite=()=>{}){
 const writes=[];let closed=false,aborted=false;
 return {writes,get closed(){return closed;},get aborted(){return aborted;},async createWritable(){return {async write(c){onWrite(c);writes.push({...c,data:c.data.slice()});},async close(){closed=true;},async abort(){aborted=true;}};},data(){const bytes=new Uint8Array(Math.max(...writes.map(c=>c.position+c.data.length)));for(const c of writes)bytes.set(c.data,c.position);return bytes;}};
}
function mockApi(data,kind='plain'){
 const [map,fragment]=splitMp4(data),seen=[];
 const manifest=['#EXTM3U','#EXT-X-TARGETDURATION:3'];
 for(let i=0;i<4;i++){
  if(i)manifest.push('#EXT-X-DISCONTINUITY');
  if(kind==='map')manifest.push(`#EXT-X-MAP:URI="map${i}"`);
  manifest.push('#EXTINF:3,',`part${i}`);
 }
 manifest.push('#EXT-X-ENDLIST');
 return {seen,async request(url,{type,signal}={}){signal?.throwIfAborted();seen.push(url);const bytes=url.includes('/map')?map:kind==='map'?fragment:data;return {data:type==='arraybuffer'?bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength):manifest.join('\n'),url};}};
}
for(const kind of ['plain','map'])test(`整场逐段写盘保留跨断流视频（${kind}）`,async()=>{
 const data=await fixture(),api=mockApi(data,kind);let earlyWrite=false;const file=disk(()=>{if(!api.seen.includes('https://example.com/part2'))earlyWrite=true;});
 await saveRecording(api,[{stream:'https://example.com/list',start_time:100}],file);
 assert.equal(file.closed,true);assert.equal(file.aborted,false);assert.ok(file.writes.length>1);assert.ok(earlyWrite,'必须在读完整场之前写盘');
 const input=new Input({source:new BufferSource(file.data()),formats:[MP4]});
 try{assert.ok(Math.abs(await input.computeDuration()-12)<.01);assert.ok(await input.getPrimaryVideoTrack());}finally{input.dispose();}
 for(let i=0;i<4;i++)assert.ok(api.seen.includes(`https://example.com/part${i}`));
});

test('取消、网络失败和写盘失败均终止文件，不能提交半成品',async()=>{
 const data=await fixture();
 for(const reason of ['abort','network','disk']){
  const own=new AbortController(),api=mockApi(data),original=api.request.bind(api);
  api.request=async(url,options)=>{if(url.endsWith('part1')){if(reason==='abort')own.abort();if(reason==='network')throw new Error('网络中断');}return original(url,options);};
  const file=disk(()=>{if(reason==='disk')throw new Error('磁盘已满');});
  await assert.rejects(saveRecording(api,[{stream:'https://example.com/list',start_time:100}],file,{signal:own.signal}));
  assert.equal(file.closed,false,reason);assert.equal(file.aborted,true,reason);
 }
});
