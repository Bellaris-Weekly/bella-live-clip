import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Output,BufferTarget,Mp4OutputFormat,EncodedVideoPacketSource,EncodedPacket,EncodedPacketSink,Input,BufferSource,MP4} from 'mediabunny';
import {RecordingPlan} from '../../../src/media/recording-plan.js';
import {exportSelection} from '../../../src/media/export.js';
import {config,frame} from '../support/synthetic-frame.mjs';
import {formatCompactTime,formatDuration} from '../../../src/shared/format.js';
import {saveRecording,estimateRecordingRate,estimateSelectionBytes} from '../../../src/media/recording.js';
import {RequestError} from '../../../src/services/retry-request.js';
import {config as bConfig,packets as bPackets} from '../support/b-frames.mjs';

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
function mockApi(data,kind='plain',count=4){
 const [map,fragment]=splitMp4(data),seen=[];
 const manifest=['#EXTM3U','#EXT-X-TARGETDURATION:3'];
 for(let i=0;i<count;i++){
  if(i)manifest.push('#EXT-X-DISCONTINUITY');
  if(kind==='map')manifest.push(`#EXT-X-MAP:URI="map${i}"`);
  manifest.push('#EXTINF:3,',`part${i}`);
 }
 manifest.push('#EXT-X-ENDLIST');
 return {seen,async request(url,{type,signal}={}){signal?.throwIfAborted();seen.push(url);const bytes=url.includes('/map')?map:kind==='map'?fragment:data;return {data:type==='arraybuffer'?bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength):manifest.join('\n'),url};}};
}
for(const duration of [2.7,2.95])test(`整场拼接使用媒体实际时长，不因清单低估 ${(3-duration).toFixed(2)} 秒而倒退`,async()=>{
 const data=await fixture(),file=disk();
 const segments=Array.from({length:3},(_,i)=>({url:`part${i}`,duration}));
 const api={request:async()=>({data:data.buffer})};
 await saveRecording(api,[{start:0,segments}],file);
 const input=new Input({source:new BufferSource(file.data()),formats:[MP4]});
 try{assert.ok(Math.abs(await input.computeDuration()-9)<.01);}
 finally{input.dispose();}
 assert.equal(file.closed,true);assert.equal(file.aborted,false);
});

test('真实 B 帧跨分片重置保留解码顺序、画面负载及显示间隔，输出完整 MP4 索引',async()=>{
 const source=new EncodedVideoPacketSource('avc'),output=new Output({format:new Mp4OutputFormat(),target:new BufferTarget()});
 output.addVideoTrack(source);await output.start();
 const decoderConfig={...bConfig,description:new Uint8Array(Buffer.from(bConfig.description,'base64'))};
 for(const p of bPackets)await source.add(new EncodedPacket(new Uint8Array(Buffer.from(p.data,'base64')),p.type,p.timestamp,p.duration),{decoderConfig});
 source.close();await output.finalize();
 const file=disk();
 await saveRecording({request:async()=>({data:output.target.buffer})},[{segments:[{url:'first',duration:.3},{url:'second',duration:.3}]}],file);
 const bytes=file.data(),boxTypes=[];
 for(let offset=0;offset<bytes.length;){
  const view=new DataView(bytes.buffer),size=view.getUint32(offset);
  boxTypes.push(new TextDecoder().decode(bytes.subarray(offset+4,offset+8)));
  offset+=size===1?Number(view.getBigUint64(offset+8)):size;
 }
 assert.ok(boxTypes.includes('moov'));assert.ok(!boxTypes.includes('moof'),'完整文件索引必须携带 B 帧时间修正信息');
 const input=new Input({source:new BufferSource(bytes),formats:[MP4]});
 try{
  const track=await input.getPrimaryVideoTrack(),packets=[];
  for await(const p of new EncodedPacketSink(track).packets())packets.push(p);
  assert.equal(packets.length,bPackets.length*2);
  assert.ok(packets.some((p,i)=>i&&p.timestamp<packets[i-1].timestamp),'不能将 B 帧按显示时间排序');
  for(const [i,p]of packets.entries()){
   const original=bPackets[i%bPackets.length];
   assert.deepEqual(p.data,new Uint8Array(Buffer.from(original.data,'base64')));
   assert.ok(Math.abs(p.timestamp-original.timestamp-(i>=bPackets.length?.4:0))<.00002);
  }
 }finally{input.dispose();}
});
for(const kind of ['plain','map'])test(`整场逐段写盘保留跨断流视频（${kind}）`,async()=>{
 const data=await fixture(),api=mockApi(data,kind,10);let earlyWrite=false;const file=disk(()=>{if(!api.seen.includes('https://example.com/part8'))earlyWrite=true;});
 await saveRecording(api,await new RecordingPlan(api,[{stream:'https://example.com/list',start_time:100,end_time:130}]).load(),file);
 assert.equal(file.closed,true);assert.equal(file.aborted,false);assert.ok(file.writes.length>1);assert.ok(earlyWrite,'必须在读完整场之前写盘');
 const input=new Input({source:new BufferSource(file.data()),formats:[MP4]});
 try{assert.ok(Math.abs(await input.computeDuration()-30)<.01);assert.ok(await input.getPrimaryVideoTrack());}finally{input.dispose();}
 for(let i=0;i<10;i++)assert.ok(api.seen.includes(`https://example.com/part${i}`));
});

test('取消、网络失败和写盘失败均终止文件，不能提交半成品',async()=>{
 const data=await fixture();
 for(const reason of ['abort','network','disk']){
  const own=new AbortController(),api=mockApi(data),original=api.request.bind(api);
  api.request=async(url,options)=>{if(url.endsWith('part1')){if(reason==='abort')own.abort();if(reason==='network')throw new Error('网络中断');}return original(url,options);};
  const file=disk(()=>{if(reason==='disk')throw new Error('磁盘已满');});
  await assert.rejects(saveRecording(api,await new RecordingPlan(api,[{stream:'https://example.com/list',start_time:100,end_time:112}]).load(),file,{signal:own.signal}));
  assert.equal(file.closed,false,reason);assert.equal(file.aborted,true,reason);
 }
});

test('写盘后网络中断会保留文件和进度，只重新请求失败分片',async()=>{
 const data=await fixture(),api=mockApi(data,'plain',10),original=api.request.bind(api),file=disk();
 const events=[];let attempts=0,opens=0;
 const create=file.createWritable;file.createWritable=()=>{opens++;return create();};
 api.request=async(url,options)=>{
  if(url.endsWith('part8')&&attempts++===0){assert.ok(file.writes.length>0);throw new RequestError('temporary offline',{retryable:true});}
  return original(url,options);
 };
 const plan=await new RecordingPlan(api,[{stream:'https://example.com/list',start_time:100,end_time:130}]).load();
 await saveRecording(api,plan,file,{onProgress:event=>events.push(event)});
 assert.equal(opens,1);assert.equal(attempts,2);assert.equal(file.closed,true);assert.equal(file.aborted,false);
 assert.ok(events.some(event=>event.reconnecting===1));assert.equal(events.at(-1).reconnecting,0);
 assert.equal(events.at(-1).progress,1);assert.ok(events.slice(0,-1).every(event=>event.progress<1));
 assert.ok(events.every((event,i)=>!i||event.bytes>=events[i-1].bytes&&event.written>=events[i-1].written));
 for(let i=0;i<10;i++)assert.equal(api.seen.filter(url=>url.endsWith(`/part${i}`)).length,1);
 const input=new Input({source:new BufferSource(file.data()),formats:[MP4]});
 try{assert.ok(Math.abs(await input.computeDuration()-30)<.01);}finally{input.dispose();}
});

test('整场等待重连时取消，会中止文件和后续重试',async()=>{
 const data=await fixture(),api=mockApi(data),original=api.request.bind(api),file=disk(),controller=new AbortController();let attempts=0;
 api.request=async(url,options)=>{
  if(url.endsWith('part1')){attempts++;throw new RequestError('offline',{retryable:true});}
  return original(url,options);
 };
 const plan=await new RecordingPlan(api,[{stream:'https://example.com/list',start_time:100,end_time:112}]).load();
 await assert.rejects(saveRecording(api,plan,file,{signal:controller.signal,onProgress:event=>{if(event.reconnecting)controller.abort();}}),error=>error===controller.signal.reason);
 assert.equal(attempts,1);assert.equal(file.aborted,true);assert.equal(file.closed,false);
});

for(const kind of ['plain','map'])test(`选区使用共享清单保留跨段时间与实际 MP4 时长（${kind}）`,async()=>{
 const data=await fixture(),api=mockApi(data,kind);
 const plan=new RecordingPlan(api,[{stream:'https://example.com/first-list',start_time:100,end_time:112},{stream:'https://example.com/second-list',start_time:130,end_time:142}]);
 const groups=await plan.load();
 await estimateRecordingRate(api,await plan.load());
 for(const [start,end,ranges] of [[11,15,[[11,13],[13,15]]],[39,42,[[40,42]]]]){
  const outputs=await exportSelection(api,{start:90},await plan.load(),{start,end},{});
  assert.deepEqual(outputs.map(output=>[output.start,output.end]),ranges);
  for(const output of outputs){
   const input=new Input({source:new BufferSource(new Uint8Array(await output.blob.arrayBuffer())),formats:[MP4]});
   try{assert.ok(Math.abs(await input.computeDuration()-(output.end-output.start))<.01);assert.ok(await input.getPrimaryVideoTrack());}finally{input.dispose();}
  }
 }
 assert.equal(api.seen.filter(url=>url.endsWith('-list')).length,2,'预估和重复导出不能重读清单');
});

test('清单比接口报告的录像更长时，选区不能重新选中已结束的录像段',async()=>{
 const data=await fixture();
 for(const start of [100,130]){
  const api=mockApi(data),plan=new RecordingPlan(api,[{stream:'https://example.com/list',start_time:start,end_time:start+1}]);
  await assert.rejects(exportSelection(api,{start:90},await plan.load(),{start:start+1-90,end:start+2-90},{}),/没有可用录像/);
  assert.deepEqual(api.seen,['https://example.com/list'],'没有相交录像时不下载分片');
 }
});
