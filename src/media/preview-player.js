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

export function createPlayer({video,loading,api,status,onTime}) {
 let hls,record,streams=[],index=0,generation=0,target=null;
 const offset=()=>streams[index] ? streams[index].start_time-record.start : 0;
 function attach(part,time=0){
  const token=++generation;hls?.destroy();video.pause();video.removeAttribute('src');video.load();index=part;
  target=time;loading.hidden=false;
  hls=new Hls({loader:makeHlsLoader(api.request),enableWorker:false,maxBufferLength:20,maxMaxBufferLength:40,backBufferLength:15,startPosition:time});
  hls.on(Hls.Events.ERROR,(_,data)=>{if(token===generation&&data.fatal){loading.textContent='预览暂不可用，请刷新重试';status('录像预览失败，请刷新重试。',true);}});
  hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(token===generation&&target!==null)video.currentTime=target;});
  hls.loadSource(streams[index].stream);hls.attachMedia(video);
 }
 function seek(time){
  video.pause();const found=streams.findIndex(p=>time>=p.start_time-record.start&&time<=p.end_time-record.start);
  if(found<0){target=NaN;loading.hidden=false;loading.textContent='该位置没有录像';return;}
  const local=clamp(time-(streams[found].start_time-record.start),0,Math.max(0,streams[found].end_time-streams[found].start_time-.001));
  loading.textContent='正在定位画面…';loading.hidden=false;
  if(found!==index)attach(found,local);else{target=local;video.currentTime=local;}
 }
 function ready(){if((target===null||Math.abs(video.currentTime-target)<.12)&&video.readyState>=2&&!video.seeking){target=null;loading.hidden=true;}}
 video.addEventListener('seeked',ready);video.addEventListener('loadeddata',ready);video.addEventListener('canplay',ready);
 video.ontimeupdate=()=>{ready();onTime(offset()+video.currentTime);};
 video.onwaiting=()=>{loading.textContent='正在加载画面…';loading.hidden=false;};video.onplaying=()=>{loading.hidden=true;};
 function clear(){generation++;hls?.destroy();hls=null;video.pause();video.removeAttribute('src');video.load();streams=[];target=null;}
 function destroy(){clear();for(const event of ['seeked','loadeddata','canplay'])video.removeEventListener(event,ready);video.ontimeupdate=video.onwaiting=video.onplaying=null;}
 return {async load(nextRecord,signal){clear();record=nextRecord;const total=(record.live?Math.floor(Date.now()/1000):record.end)-record.start;streams=await api.clips(record,0,total,signal);signal.throwIfAborted();attach(0);return {streams,total};},seek,clear,destroy,pause:()=>video.pause(),position:()=>offset()+video.currentTime};
}
