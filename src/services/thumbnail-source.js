import {createSubmissionStoryboard} from './submission-storyboard.js';

const CACHE_LIMIT = 48;

export function thumbnailImageUrl(value) {
  const url = new URL(value, 'https://live.bilibili.com');
  if (!['https:', 'http:'].includes(url.protocol) ||
      !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) {
    throw new Error('预览图地址不受支持。');
  }
  url.protocol = 'https:';
  return url.href;
}

// One source belongs to one loaded record. Only small rendered stills are cached.
export function createThumbnailSource({record,api,request,metadataRequest=request,readFrame,
  createStoryboard=createSubmissionStoryboard,decode=blob=>createImageBitmap(blob),
  makeCanvas=()=>document.createElement('canvas'),timeout=5000}) {
  const cache=new Map(),urls=new Map(),lifetime=new AbortController();
  let failed=false;
  const storyboard=record.kind==='submission' ? createStoryboard({submission:record,metadataRequest,mediaRequest:request}) : null;
  // Signed URLs change on each live refresh; a frame's session/time does not.
  const key=sample=>`${sample.stream?.start_time??record.key}:${sample.local}`;
  function copy(source) {
    if(!source?.getContext)return source;
    const canvas=makeCanvas();canvas.width=160;canvas.height=90;
    canvas.getContext('2d').drawImage(source,0,0,160,90);return canvas;
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
  async function prepare(samples,signal) {
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    if(storyboard||failed||!api?.keyframes)return;
    const missing=samples.filter(sample=>sample.stream&&!cache.has(key(sample))&&!urls.has(Math.round(record.start+sample.time)));
    if(!missing.length)return;
    try {
      const frames=await limited(signal,child=>api.keyframes(record,missing.map(sample=>sample.time),child));
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      const requested=new Set(missing.map(sample=>Math.round(record.start+sample.time)));
      for(const frame of frames)if(requested.has(Number(frame.ts))&&frame.url){
        try{urls.set(Number(frame.ts),thumbnailImageUrl(frame.url));}catch{}
      }
      while(urls.size>CACHE_LIMIT)urls.delete(urls.keys().next().value);
    } catch(error) {
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      // Unavailable/unauthorized images use bounded frame extraction for this record.
      failed=true;
    }
  }
  async function read(sample,signal) {
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    const id=key(sample),cached=cache.get(id);
    if(cached){remember(id,cached);return copy(cached);}
    let canvas;
    try {
      if(storyboard){
        const frame=await limited(signal,child=>storyboard.read(sample.local,child));
        signal.throwIfAborted();lifetime.signal.throwIfAborted();
        canvas=makeCanvas();canvas.width=160;canvas.height=90;
        canvas.getContext('2d').drawImage(frame.image,frame.x,frame.y,frame.width,frame.height,0,0,160,90);
      }else{
        const url=urls.get(Math.round(record.start+sample.time));
        if(!url)throw new Error('当前位置暂无平台预览图');
        const {data}=await limited(signal,child=>request(url,{type:'arraybuffer',signal:child}));
        signal.throwIfAborted();lifetime.signal.throwIfAborted();
        const bitmap=await decode(new Blob([data]));
        try{
          signal.throwIfAborted();lifetime.signal.throwIfAborted();
          canvas=makeCanvas();canvas.width=160;canvas.height=90;
          canvas.getContext('2d').drawImage(bitmap,0,0,160,90);
        }finally{bitmap.close();}
      }
    }catch(error){
      signal.throwIfAborted();lifetime.signal.throwIfAborted();
      canvas=await readFrame(request,sample,signal);
    }
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    remember(id,canvas);return copy(canvas);
  }
  return {prepare,read,dispose(){lifetime.abort();storyboard?.dispose();cache.clear();urls.clear();}};
}
