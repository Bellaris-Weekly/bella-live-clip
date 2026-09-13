import Hls from 'hls.js';
import {makeHlsLoader} from './preview-player.js';

export function thumbnailSamples(record,streams,view,count=6) {
 return Array.from({length:count},(_,i)=>{
  const time=view.start+(view.end-view.start)*(i+.5)/count;
  const stream=streams.find(s=>time>=s.start_time-record.start&&time<s.end_time-record.start);
  return {time,stream,local:stream?time-(stream.start_time-record.start):null};
 });
}

// A separate, muted decoder keeps thumbnail seeks away from the user's player.
export async function readThumbnail(request,sample,signal) {
 signal.throwIfAborted();
 const video=document.createElement('video');video.muted=true;video.playsInline=true;
 const hls=new Hls({loader:makeHlsLoader(request),enableWorker:false,startPosition:sample.local,maxBufferLength:2,maxMaxBufferLength:2,backBufferLength:0});
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

export function createThumbnails({container,request,readFrame=readThumbnail}) {
 let record,streams=[],viewKey='',controller,timer;
 function cancel(){clearTimeout(timer);controller?.abort();controller=null;}
 function clear(){cancel();record=null;streams=[];viewKey='';container.replaceChildren();}
 async function render(samples,own,cells){
  for(const [i,sample]of samples.entries()){
   if(own.signal.aborted)return;
   if(!sample.stream){cells[i].textContent='无录像';continue;}
   try{
    const canvas=await readFrame(request,sample,own.signal);
    if(own.signal.aborted)return;
    cells[i].replaceChildren(canvas);
   }catch(error){if(own.signal.aborted)return;cells[i].textContent='暂无预览';}
  }
 }
 function update(view){
  if(!record)return;
  const key=`${view.start}:${view.end}`;if(key===viewKey)return;
  viewKey=key;cancel();const own=new AbortController();controller=own;
  const samples=thumbnailSamples(record,streams,view);
  const cells=samples.map(()=>{const cell=container.ownerDocument.createElement('div');cell.className='thumbnail';cell.textContent='…';return cell;});
  container.replaceChildren(...cells);
  timer=setTimeout(()=>void render(samples,own,cells),200);
 }
 return {load(next,parts){clear();record=next;streams=parts;},update,clear};
}
