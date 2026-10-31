import Hls from 'hls.js';

import { clamp } from '../shared/math.js';

export function makeHlsLoader(request) {
 return class {
  constructor(){this.context=null;this.stats={aborted:false,loaded:0,total:0,retry:0,chunkCount:0,bwEstimate:0,loading:{start:0,first:0,end:0},parsing:{start:0,end:0},buffering:{start:0,first:0,end:0}};}
  load(context,config,callbacks){
   this.context=context;this.controller=new AbortController();this.stats.loading.start=performance.now();
   request(context.url,{type:context.responseType==='arraybuffer'?'arraybuffer':'text',signal:this.controller.signal,range:context.rangeEnd>context.rangeStart?{offset:context.rangeStart,length:context.rangeEnd-context.rangeStart}:null})
   .then(response=>{if(this.stats.aborted)return;const now=performance.now();this.stats.loading.first=this.stats.loading.end=now;this.stats.loaded=this.stats.total=typeof response.data==='string'?new TextEncoder().encode(response.data).length:response.data.byteLength;this.stats.chunkCount=1;callbacks.onSuccess({url:response.url,data:response.data},this.stats,context,null);})
   .catch(error=>{if(!this.stats.aborted)callbacks.onError({code:0,text:error.message},context,null,this.stats);});
  }
  abort(){this.stats.aborted=true;this.controller?.abort();}
  destroy(){this.abort();}
 };
}

export function createPlayer({video,loading,api,status,onTime,onError=()=>{},onReady=()=>{},HlsClass=Hls}) {
 let hls,record,streams=[],index=-1,generation=0,target=null,notified=false,attachedEnd=0;
 const offset=()=>streams[index] ? streams[index].start_time-record.start : 0;
 function attach(part,time=0){
  const token=++generation;hls?.destroy();video.pause();video.removeAttribute('src');video.load();index=part;
  target=time;attachedEnd=streams[part].end_time;loading.hidden=false;
  hls=new HlsClass({loader:makeHlsLoader(api.request),enableWorker:false,maxBufferLength:20,maxMaxBufferLength:40,backBufferLength:15,startPosition:time});
  hls.on(Hls.Events.ERROR,(_,data)=>{if(token===generation&&data.fatal){onError(new Error(`录像预览失败：${data.type} / ${data.details}`));loading.textContent='预览暂不可用，请刷新重试';status('录像预览失败，请刷新重试。',true);}});
  hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(token===generation&&target!==null)video.currentTime=target;});
  hls.loadSource(streams[index].stream);hls.attachMedia(video);
 }
 function seek(time){
  video.pause();
  // Prefer the loaded stream so a time on a shared boundary does not reload the previous one.
  const contains=p=>time>=p.start_time-record.start&&time<=p.end_time-record.start;
  const found=streams[index]&&contains(streams[index])?index:streams.findIndex(contains);
  if(found<0){target=NaN;loading.hidden=false;loading.textContent='该位置没有录像';return;}
  const local=clamp(time-(streams[found].start_time-record.start),0,Math.max(0,streams[found].end_time-streams[found].start_time-.001));
  loading.textContent='正在定位画面…';loading.hidden=false;
  // Keep buffered playback untouched during a background update. Only replace
  // its old snapshot when the user seeks into newly available footage.
  if(!hls||found!==index||time+record.start>=attachedEnd&&streams[found].end_time>attachedEnd)attach(found,local);else{target=local;video.currentTime=local;}
 }
 function ready(){if(hls&&(target===null||Math.abs(video.currentTime-target)<.12)&&video.readyState>=2&&!video.seeking){target=null;loading.hidden=true;if(!notified){notified=true;onReady(record);}}}
 video.addEventListener('seeked',ready);video.addEventListener('loadeddata',ready);video.addEventListener('canplay',ready);
 video.ontimeupdate=()=>{ready();onTime(offset()+video.currentTime);};
 video.onwaiting=()=>{loading.textContent='正在加载画面…';loading.hidden=false;};video.onplaying=()=>{loading.hidden=true;};
 function clear(){generation++;hls?.destroy();hls=null;video.pause();video.removeAttribute('src');video.load();streams=[];index=-1;target=null;notified=false;}
 function destroy(){clear();for(const event of ['seeked','loadeddata','canplay'])video.removeEventListener(event,ready);video.ontimeupdate=video.onwaiting=video.onplaying=null;}
 function availableTotal(){return (record.live?streams.at(-1).end_time:record.end)-record.start;}
 function extend(next){
  // Ignore partial/regressing responses. Stable segment indices also keep the
  // active HLS player and an existing selection attached to the same segment.
  if(!record?.live||next.length<streams.length||!next.length)return null;
  if(next.some((part,i)=>!Number.isFinite(part.start_time)||!Number.isFinite(part.end_time)||part.end_time<=part.start_time||typeof part.stream!=='string'||!part.stream||
   i>0&&part.start_time<next[i-1].end_time||i<streams.length&&(part.start_time!==streams[i].start_time||part.end_time<streams[i].end_time)))return null;
  const changed=next.length!==streams.length||next.some((part,i)=>part.end_time!==streams[i].end_time);
  streams=next;
  return changed?{streams,total:availableTotal()}:null;
 }
 return {getScreenshotVideo:()=>video,async load(nextRecord,signal){clear();const token=generation;record=nextRecord;loading.hidden=false;loading.textContent='正在获取录像地址…';const total=(record.live?Math.floor(Date.now()/1000):record.end)-record.start;const nextStreams=await api.clips(record,0,total,signal);signal.throwIfAborted();if(token!==generation)throw new DOMException('已切换场次','AbortError');streams=nextStreams;return {streams,total:availableTotal()};},extend,seek,clear,destroy,pause:()=>video.pause(),position:()=>offset()+video.currentTime};
}
