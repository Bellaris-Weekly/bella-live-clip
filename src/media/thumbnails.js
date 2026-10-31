import Hls from 'hls.js';
import {makeHlsLoader} from './preview-player.js';
import {readSubmissionThumbnail} from './submission-thumbnail.js';
import {createThumbnailSource} from '../services/thumbnail-source.js';

export function thumbnailSamples(record,streams,view,count=6) {
 return Array.from({length:count},(_,i)=>{
  const time=view.start+(view.end-view.start)*(i+.5)/count;
  if(record.kind==='submission')return {time,stream:record,local:time};
  const stream=streams.find(s=>time>=s.start_time-record.start&&time<s.end_time-record.start);
  return {time,stream,local:stream?time-(stream.start_time-record.start):null};
 });
}

// A separate, muted decoder keeps thumbnail seeks away from the user's player.
export async function readThumbnail(request,sample,signal) {
 if(sample.stream.kind==='submission')return readSubmissionThumbnail(request,sample.stream,sample.local,signal);
 signal.throwIfAborted();
 const video=document.createElement('video');video.muted=true;video.playsInline=true;
 const hls=new Hls({loader:makeHlsLoader(request),enableWorker:false,startPosition:sample.local,maxBufferLength:1,maxMaxBufferLength:2,backBufferLength:0});
 let timer,abort;
 try {
  return await new Promise((resolve,reject)=>{
   abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>reject(new Error('缩略图加载超时')),15000);
   const ready=()=>{
    if(video.readyState<2||video.seeking||Math.abs(video.currentTime-sample.local)>.15)return;
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    try{canvas.getContext('2d').drawImage(video,0,0,160,90);resolve(canvas);}catch(error){reject(error);}
   };
   for(const name of ['loadeddata','seeked','canplay'])video.addEventListener(name,ready);
   video.addEventListener('error',()=>reject(new Error('缩略图解码失败')),{once:true});
   hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)reject(new Error('缩略图加载失败'));});
   hls.on(Hls.Events.MANIFEST_PARSED,()=>{video.currentTime=sample.local;});
   hls.loadSource(sample.stream.stream);hls.attachMedia(video);
  });
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',abort);hls.destroy();video.removeAttribute('src');video.load();
 }
}

export function createThumbnails({container,request,api,metadataRequest,readFrame=readThumbnail}) {
 let record,source,streams=[],viewKey='',controller,timer,displayView,currentView,moving=false,ready,decoding=Promise.resolve(),release=()=>{};
 function cancel(){clearTimeout(timer);ready=null;controller?.abort();controller=null;}
 function clear(){cancel();source?.dispose();source=null;record=null;streams=[];viewKey='';displayView=null;currentView=null;moving=false;release();container.replaceChildren();}
 // Video extraction competes with the main picture; platform images do not.
 async function decode(reader,sample,signal){
  let abort;
  try{await Promise.race([decoding,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
  finally{signal.removeEventListener('abort',abort);}
  signal.throwIfAborted();return readFrame(reader,sample,signal);
 }
 async function render(samples,own,cells){
  const reader=source;await reader.prepare(samples,own.signal);let cursor=0;
  await Promise.all(Array.from({length:2},async()=>{
   while(cursor<samples.length&&!own.signal.aborted){
    const i=cursor++,sample=samples[i];
    if(!sample.stream){cells[i].textContent='无录像';continue;}
    try{
     const canvas=await reader.read(sample,own.signal);
     if(own.signal.aborted)return;
     cells[i].replaceChildren(canvas);
    }catch(error){if(own.signal.aborted)return;cells[i].textContent='暂无预览';}
    publish();
   }
  }));
 }
 function project(){
  if(!displayView)return;
  const width=currentView.end-currentView.start;
  const cells=Array.from(container.children);
  cells.forEach((cell,i)=>{
   const start=displayView.start+(displayView.end-displayView.start)*i/cells.length;
   cell.style.left=`${(start-currentView.start)/width*100}%`;
   cell.style.width=`${(displayView.end-displayView.start)/cells.length/width*100}%`;
  });
 }
 function publish(){
  if(moving||!ready)return;
  container.replaceChildren(...ready.cells);displayView=ready.view;ready=null;project();
 }
 function update(view,{animating=false,target=view}={}){
  if(!record)return;
  currentView={...view};moving=animating;project();
  const key=`${target.start}:${target.end}`;
  if(key===viewKey){publish();return;}
  viewKey=key;cancel();const own=new AbortController();controller=own;
  const samples=thumbnailSamples(record,streams,target);
  const cells=samples.map(()=>{const cell=container.ownerDocument.createElement('div');cell.className='thumbnail';cell.textContent='…';return cell;});
  if(!displayView){container.replaceChildren(...cells);displayView={...target};project();}
  timer=setTimeout(async()=>{
   ready={cells,view:{...target}};
   try{await render(samples,own,cells);}catch(error){if(own.signal.aborted)return;}
   if(!own.signal.aborted)publish();
  },200);
 }
 return {load(next,parts,{defer=false,onFrames,center=0}={}){clear();record=next;streams=parts;
   decoding=defer?new Promise(resolve=>{release=resolve;}):Promise.resolve();
   source=createThumbnailSource({record,api,request,metadataRequest,readFrame:decode,onFrames});void source.warm(parts,center).catch(()=>{});},
  setStreams(parts,center=0){streams=parts;viewKey='';void source?.warm(parts,center).catch(()=>{});if(currentView)update(currentView);},
  frameUrl:time=>source?.frameUrl(time)??null,
  resume(){release();},update,clear};
}
