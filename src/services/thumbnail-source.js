import {createSubmissionStoryboard} from './submission-storyboard.js';
import {drawFitted} from '../shared/fit.js';

// The platform's own editor never asks for live stills closer than this.
export const FRAME_INTERVAL = 60;
const BATCH_SIZE = 30, CACHE_LIMIT = 300, NEIGHBORS = 5;

export function thumbnailImageUrl(value) {
  const url = new URL(value, 'https://live.bilibili.com');
  if (!['https:', 'http:'].includes(url.protocol) ||
      !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) {
    throw new Error('预览图地址不受支持。');
  }
  url.protocol = 'https:';
  return url.href;
}

// An image element uses the browser cache and needs neither CORS nor the
// userscript manager. Only drawn to canvases that are never read back.
export function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (settle, value) => {
      image.onload = image.onerror = null; signal.removeEventListener('abort', abort); settle(value);
    };
    const abort = () => { image.src = ''; finish(reject, signal.reason); };
    image.onload = () => finish(resolve, image);
    image.onerror = () => finish(reject, new Error('预览图加载失败。'));
    signal.addEventListener('abort', abort, {once: true});
    image.src = url;
  });
}

// One source belongs to one loaded record. Live stills sit on a fixed time grid,
// so zooming, panning and live growth reuse what is already known.
export function createThumbnailSource({record,api,request,metadataRequest=request,readFrame,
  createStoryboard=createSubmissionStoryboard,decode=blob=>createImageBitmap(blob),load=loadImage,
  makeCanvas=()=>document.createElement('canvas'),timeout=5000,onFrames=()=>{}}) {
  const cache=new Map(),urls=new Map(),pending=new Map(),blobs=[],lifetime=new AbortController();
  let failed=false;
  const storyboard=record.kind==='submission' ? createStoryboard({submission:record,metadataRequest,mediaRequest:request}) : null;
  // The newest position has no later grid point yet: never ask beyond the footage.
  const slotOf=sample=>Math.min(Math.round(sample.time/FRAME_INTERVAL),Math.floor((sample.stream.end_time-record.start)/FRAME_INTERVAL));
  // Signed URLs change on each live refresh; a frame's session/time does not.
  const key=sample=>`${sample.stream?.start_time??record.key}:${sample.local}`;
  function canvasFor(draw,width,height) {
    const canvas=makeCanvas();canvas.width=160;canvas.height=90;
    const context=canvas.getContext('2d');
    drawFitted(context,(x,y,w,h)=>draw(context,x,y,w,h),width,height,160,90);
    return canvas;
  }
  function copy(source) {
    if(!source?.getContext)return source;
    return canvasFor((context,...rect)=>context.drawImage(source,...rect),source.width,source.height);
  }
  function remember(id,canvas) {
    cache.delete(id);cache.set(id,canvas);
    if(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);
  }
  async function limited(signal,action) {
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    const own=new AbortController(),abort=()=>own.abort(signal.reason),dispose=()=>own.abort(lifetime.signal.reason);
    signal.addEventListener('abort',abort,{once:true});lifetime.signal.addEventListener('abort',dispose,{once:true});
    const timer=setTimeout(()=>own.abort(new Error('预览图请求超时')),timeout);
    try {
      // Bound waits even if the underlying transport delivers cancellation late.
      return await Promise.race([action(own.signal),new Promise((_,reject)=>{
        if(own.signal.aborted)reject(own.signal.reason);
        else own.signal.addEventListener('abort',()=>reject(own.signal.reason),{once:true});
      })]);
    } finally {
      clearTimeout(timer);signal.removeEventListener('abort',abort);lifetime.signal.removeEventListener('abort',dispose);
    }
  }
  function store(slots,frames) {
    // The list follows the request order and its timestamps may be snapped to a
    // nearby stored image. An empty position shows the previous image, as on B 站.
    let previous=null;
    for(const [i,slot] of slots.entries()){
      const frame=frames.length===slots.length?frames[i]:frames.find(item=>Number(item.ts)===record.start+slot*FRAME_INTERVAL);
      let url=null;
      if(frame?.url&&Math.abs(Number(frame.ts)-(record.start+slot*FRAME_INTERVAL))<=FRAME_INTERVAL){
        try{url=thumbnailImageUrl(frame.url);}catch{}
      }
      url??=frames.length===slots.length&&frame&&!frame.url?previous:null;
      if(url){urls.set(slot,url);previous=url;}
    }
    onFrames();
  }
  // A batch belongs to the record rather than one view, so a new view can reuse it.
  function fetchBatch(slots) {
    const batch=(async()=>{
      try{store(slots,await limited(lifetime.signal,signal=>api.keyframes(record,slots.map(slot=>slot*FRAME_INTERVAL),signal)));}
      catch(error){
        lifetime.signal.throwIfAborted();
        // Unavailable/unauthorized images use bounded frame extraction for this record.
        failed=true;
      }finally{for(const slot of slots)pending.delete(slot);}
    })();
    for(const slot of slots)pending.set(slot,batch);
    return batch;
  }
  async function prepare(samples,signal) {
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    if(storyboard||failed||!api?.keyframes)return;
    const slots=[...new Set(samples.filter(sample=>sample.stream).map(slotOf))];
    const missing=slots.filter(slot=>!urls.has(slot)&&!pending.has(slot));
    if(missing.length)void fetchBatch(missing).catch(()=>{});
    let abort;
    try{
      await Promise.race([Promise.all(slots.map(slot=>pending.get(slot))),new Promise((_,reject)=>{
        abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
      })]);
    }finally{signal.removeEventListener('abort',abort);}
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
  }
  // Index the whole recording in the background so a drag has an image anywhere.
  async function warm(parts,center=0) {
    if(storyboard||failed||!api?.keyframes)return;
    const slots=[...new Set(parts.flatMap(part=>{
      const first=Math.ceil((part.start_time-record.start)/FRAME_INTERVAL),last=Math.floor((part.end_time-record.start)/FRAME_INTERVAL);
      return Array.from({length:Math.max(0,last-first+1)},(_,i)=>first+i);
    }))].filter(slot=>!urls.has(slot)&&!pending.has(slot)).sort((a,b)=>Math.abs(a*FRAME_INTERVAL-center)-Math.abs(b*FRAME_INTERVAL-center));
    for(let i=0;i<slots.length&&!failed&&!lifetime.signal.aborted;i+=BATCH_SIZE){
      // In request order, as the service expects a chronological list.
      const batch=slots.slice(i,i+BATCH_SIZE).filter(slot=>!urls.has(slot)&&!pending.has(slot)).sort((a,b)=>a-b);
      if(batch.length)await fetchBatch(batch).catch(()=>{});
    }
  }
  function frameUrl(time) {
    const slot=Math.round(time/FRAME_INTERVAL);
    for(let distance=0;distance<=NEIGHBORS;distance++){
      const url=urls.get(slot-distance)??urls.get(slot+distance);
      if(url)return url;
    }
    return null;
  }
  async function drawImage(sample,signal) {
    // Once decoding, every position gets its own picture rather than a neighbor's.
    const url=urls.get(slotOf(sample))??(failed?null:frameUrl(sample.time));
    if(!url)throw new Error('当前位置暂无平台预览图');
    let image;
    try{image=await limited(signal,child=>load(url,child));}
    catch(error){
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      const {data}=await limited(signal,child=>request(url,{type:'arraybuffer',signal:child}));
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      image=await decode(new Blob([data]));
    }
    try{
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      return canvasFor((context,...rect)=>context.drawImage(image,...rect),image.naturalWidth??image.width,image.naturalHeight??image.height);
    }finally{image.close?.();}
  }
  // Decoded stills also serve the large drag preview, which displays URLs.
  function publish(sample,canvas) {
    if(storyboard||!canvas?.toBlob)return;
    const slot=slotOf(sample);
    canvas.toBlob(blob=>{
      if(!blob||lifetime.signal.aborted||urls.has(slot))return;
      const url=URL.createObjectURL(blob);blobs.push(url);urls.set(slot,url);onFrames();
    },'image/jpeg',.8);
  }
  async function read(sample,signal) {
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    // Different positions on one grid slot are the same platform image.
    const slotId=!storyboard&&urls.has(slotOf(sample))?`image:${slotOf(sample)}`:null;
    const id=slotId??key(sample),cached=cache.get(id);
    if(cached){remember(id,cached);return copy(cached);}
    let canvas;
    try {
      if(storyboard){
        const frame=await limited(signal,child=>storyboard.read(sample.local,child));
        signal.throwIfAborted();lifetime.signal.throwIfAborted();
        canvas=canvasFor((context,...rect)=>context.drawImage(frame.image,frame.x,frame.y,frame.width,frame.height,...rect),frame.width,frame.height);
      }else canvas=await drawImage(sample,signal);
    }catch(error){
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      canvas=await readFrame(request,sample,signal);
      publish(sample,canvas);
    }
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    remember(id,canvas);return copy(canvas);
  }
  return {prepare,read,warm,frameUrl,
    // True when pictures must be decoded because the image service refused this account.
    decodes:()=>!storyboard&&(failed||!api?.keyframes),
    hasFrame:time=>urls.has(Math.round(time/FRAME_INTERVAL)),
    dispose(){lifetime.abort();storyboard?.dispose();cache.clear();urls.clear();for(const url of blobs)URL.revokeObjectURL(url);}};
}
