import {
 BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
 Mp4OutputFormat, Output, VideoSampleSink,
} from 'mediabunny';
import {openSubmissionMedia} from './remote-mp4.js';
import {clamp} from '../shared/math.js';

const WINDOW_SECONDS=8, BACK_SECONDS=15, MAX_WINDOW_BYTES=32*1024*1024;

// A complete random-access interval is required: stopping at a presentation
// timestamp can discard later-decoded B frames that belong before that point.
export async function readSubmissionPreviewWindow(tracks,time,{signal,span=WINDOW_SECONDS}={}) {
 signal?.throwIfAborted();
 const video=tracks.find(track=>track.isVideoTrack()), sink=new EncodedPacketSink(video);
 const first=await sink.getKeyPacket(time,{verifyKeyPackets:true})??await sink.getFirstKeyPacket({verifyKeyPackets:true});
 if(!first)throw new Error('视频没有可解码的关键帧');
 let last=await sink.getKeyPacket(time+span,{verifyKeyPackets:true});
 if(!last||last.timestamp<=first.timestamp)last=await sink.getNextKeyPacket(first,{verifyKeyPackets:true});
 else last=await sink.getNextKeyPacket(last,{verifyKeyPackets:true});
 // The first video frame can follow the requested start; retain the earlier
 // audio prefix without shifting either track's original presentation times.
 const start=Math.min(time,first.timestamp),end=last?.timestamp??Infinity;
 let bytes=0,actualEnd=start;
 const chunks=[];
 for(const track of tracks){
  signal?.throwIfAborted();
  const isVideo=track.isVideoTrack(),packets=new EncodedPacketSink(track);
  const begin=isVideo?first:await packets.getPacket(start)??await packets.getFirstPacket();
  if(!begin)throw new Error(isVideo?'视频轨道为空':'音频轨道为空');
  const source=isVideo?new EncodedVideoPacketSource('avc'):new EncodedAudioPacketSource('aac');
  const output=new Output({format:new Mp4OutputFormat({fastStart:'fragmented',minimumFragmentDuration:Infinity}),target:new BufferTarget()});
  if(isVideo)output.addVideoTrack(source,{rotation:await track.getRotation()});else output.addAudioTrack(source);
  const decoderConfig=await track.getDecoderConfig();
  try{
   await output.start();
   for await(const packet of packets.packets(begin,isVideo?last??undefined:undefined)){
    signal?.throwIfAborted();
    if(!isVideo&&packet.timestamp>=end)break;
    bytes+=packet.data.byteLength;
    if(bytes>MAX_WINDOW_BYTES)throw new Error('预览关键帧间隔过大，无法在预览缓存限制内加载');
    await source.add(packet,{decoderConfig});
    if(isVideo)actualEnd=Math.max(actualEnd,packet.timestamp+packet.duration);
   }
   source.close();await output.finalize();signal?.throwIfAborted();
   chunks.push({track,data:new Uint8Array(output.target.buffer)});
  }catch(error){await output.cancel();throw error;}
 }
 return {chunks,start,end:Number.isFinite(end)?end:actualEnd,finished:last===null};
}

function eventPromise(target,event,signal,action){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const clean=()=>{target.removeEventListener(event,done);target.removeEventListener('error',fail);signal?.removeEventListener('abort',abort);};
  const done=()=>{clean();resolve();};
  const fail=()=>{clean();reject(new Error('视频预览解码失败'));};
  const abort=()=>{clean();reject(signal.reason);};
  target.addEventListener(event,done,{once:true});target.addEventListener('error',fail,{once:true});signal?.addEventListener('abort',abort,{once:true});
  try{action?.();}catch(error){clean();reject(error);}
 });
}

function bufferedEnd(buffer,time){
 for(let i=0;i<buffer.buffered.length;i++)if(buffer.buffered.start(i)<=time+.05&&buffer.buffered.end(i)>time)return buffer.buffered.end(i);
 return time;
}

export function createSubmissionPlayer({video,loading,request,status,onTime}) {
 let session=null,target=null;
 const listeners=[];
 const listen=(name,callback)=>{video.addEventListener(name,callback);listeners.push([name,callback]);};
 function ready(){
  if(session&&video.readyState>=2&&!video.seeking&&(target===null||Math.abs(video.currentTime-target)<.15)){target=null;loading.hidden=true;}
 }
 function report(error,own){
  if(session!==own||own.controller.signal.aborted||error.name==='AbortError')return;
  own.failed=true;video.pause();loading.hidden=false;loading.textContent='预览暂不可用，请刷新重试';status(error.message,true);
 }
 async function fill(own,time){
  const controller=new AbortController(),abort=()=>controller.abort(own.controller.signal.reason);
  own.controller.signal.addEventListener('abort',abort,{once:true});
  if(own.controller.signal.aborted)abort();
  own.fillController=controller;
  own.fillTime=time;
  const signal=controller.signal;
  const media=openSubmissionMedia(request,own.submission,{signal});
  own.media=media;
  try{
   const tracks=await media.getTracks();signal.throwIfAborted();
   const window=await readSubmissionPreviewWindow(tracks,time,{signal});signal.throwIfAborted();
   for(let i=0;i<window.chunks.length;i++){
    const buffer=own.buffers[i];
    if(buffer.updating)await eventPromise(buffer,'updateend',signal);
    const cutoff=Math.max(0,video.currentTime-BACK_SECONDS);
    if(cutoff>0&&buffer.buffered.length&&buffer.buffered.start(0)<cutoff)await eventPromise(buffer,'updateend',signal,()=>buffer.remove(0,cutoff));
    // A seek may leave a distant former window. Keep only a small neighborhood.
    const upper=Math.max(video.currentTime,time)+WINDOW_SECONDS*3;
    if(buffer.buffered.length&&buffer.buffered.end(buffer.buffered.length-1)>upper)await eventPromise(buffer,'updateend',signal,()=>buffer.remove(upper,Infinity));
    await eventPromise(buffer,'updateend',signal,()=>buffer.appendBuffer(window.chunks[i].data));
   }
   signal.throwIfAborted();own.next=window.end;own.finished=window.finished;
   return window;
  }finally{own.controller.signal.removeEventListener('abort',abort);media.dispose();if(own.media===media)own.media=null;if(own.fillController===controller)own.fillController=null;}
 }
 async function pump(){
  const own=session;if(!own||!own.ready||own.running||own.failed)return;
  const time=video.currentTime,end=Math.min(...own.buffers.map(buffer=>bufferedEnd(buffer,time)));
  if(end-time>=4||(own.finished&&end>=own.submission.duration-.1))return;
  own.running=true;
  try{await fill(own,end>time+.1?own.next:time);}catch(error){report(error,own);}finally{own.running=false;if(own.pending){own.pending=false;void pump();}}
 }
 function seekedTo(){
  const own=session;if(!own)return;
  target=video.currentTime;loading.hidden=false;loading.textContent='正在定位画面…';
  if(own.running&&Math.abs(own.fillTime-video.currentTime)>.05&&own.buffers.some(buffer=>bufferedEnd(buffer,video.currentTime)===video.currentTime)){
   own.pending=true;own.fillController?.abort();
  }
  void pump();
 }
 function clear(){
  const old=session;session=null;target=null;
  old?.controller.abort();old?.media?.dispose();old?.unlink();
  video.pause();video.removeAttribute('src');video.load();
  if(old?.url)URL.revokeObjectURL(old.url);
 }
 listen('timeupdate',()=>{if(!session)return;ready();onTime(video.currentTime);void pump();});
 listen('seeking',seekedTo);
 for(const event of ['seeked','loadeddata','canplay'])listen(event,()=>{ready();void pump();});
 listen('waiting',()=>{if(session){loading.hidden=false;loading.textContent='正在加载画面…';void pump();}});
 listen('playing',()=>{if(session)loading.hidden=true;});
 listen('error',()=>{if(session)report(new Error('视频预览解码失败'),session);});
 return {
  async load(submission,signal){
   clear();signal.throwIfAborted();
   if(typeof MediaSource==='undefined')throw new Error('当前浏览器不支持视频预览');
   const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
   signal.addEventListener('abort',abort,{once:true});
   const own={submission,controller,unlink:()=>signal.removeEventListener('abort',abort),buffers:[],ready:false,running:false,failed:false};session=own;
   loading.hidden=false;loading.textContent='正在加载画面…';
   try{
    const media=openSubmissionMedia(request,submission,{signal:controller.signal});own.media=media;
    let codecs;
    try{const tracks=await media.getTracks();codecs=await Promise.all(tracks.map(async track=>`${track.isVideoTrack()?'video':'audio'}/mp4; codecs="${await track.getCodecParameterString()}"`));}finally{media.dispose();own.media=null;}
    controller.signal.throwIfAborted();
    for(const codec of codecs)if(!MediaSource.isTypeSupported(codec))throw new Error('当前浏览器不支持此视频的音视频格式');
    own.source=new MediaSource();own.url=URL.createObjectURL(own.source);
    await eventPromise(own.source,'sourceopen',controller.signal,()=>{video.src=own.url;});
    own.source.duration=submission.duration;own.buffers=codecs.map(codec=>own.source.addSourceBuffer(codec));
    const window=await fill(own,0);
    controller.signal.throwIfAborted();
    video.currentTime=Math.max(0,window.start);
    if(video.readyState<2)await eventPromise(video,'loadeddata',controller.signal);
    own.ready=true;loading.hidden=true;return {total:submission.duration};
   }catch(error){if(session===own)clear();throw error;}
  },
  seek(time){if(!session)return;target=clamp(time,0,Math.max(0,session.submission.duration-.001));video.currentTime=target;seekedTo();},
  clear,pause:()=>video.pause(),position:()=>target??video.currentTime,
  destroy(){clear();for(const [name,callback] of listeners)video.removeEventListener(name,callback);},
 };
}

export async function readSubmissionThumbnail(request,submission,time,signal){
 signal.throwIfAborted();
 const media=openSubmissionMedia(request,submission,{signal});let sample;
 try{
  const track=await media.videoInput.getPrimaryVideoTrack();
  if(!track)throw new Error('视频轨道为空');
  sample=await new VideoSampleSink(track).getSample(time);signal.throwIfAborted();
  if(!sample)throw new Error('该位置没有可解码的画面');
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
  sample.draw(canvas.getContext('2d'),0,0,160,90);return canvas;
 }finally{sample?.close();media.dispose();}
}
