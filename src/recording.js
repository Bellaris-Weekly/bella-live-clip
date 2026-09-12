import { Input, HLS, MP4, MPEG_TS, CustomPathedSource, CustomSource, BufferSource,
  Output, StreamTarget, Mp4OutputFormat, Conversion } from 'mediabunny';
export async function estimateRecordingRate(api, groups, signal) {
  // Sample each uninterrupted part so quality changes are reflected in its estimate.
  const rates=[];
  for (const group of groups) {
    const sample=group.segments[Math.floor(group.segments.length/2)];
    const size=sample.range?.length ?? (await api.request(sample.url,{type:'arraybuffer',signal})).data.byteLength;
    const rate=size/sample.duration;
    rates.push({...group,rate});
  }
  return {groups:rates};
}

export function estimateSelectionBytes(estimate, recordStart, selection) {
  let bytes=0;
  for (const group of estimate.groups) {
    let cursor=group.start-recordStart;
    for (const segment of group.segments) {
      const overlap=Math.max(0,Math.min(cursor+segment.duration,selection.end)-Math.max(cursor,selection.start));
      bytes+=overlap*(segment.range ? segment.range.length/segment.duration : group.rate);
      cursor+=segment.duration;
    }
  }
  return bytes;
}

// All media bytes live in one shared LRU, not in one retained buffer per HLS source.
// A single server segment can exceed the budget; it is released on the next load.
export function createSegmentCache(api,{signal,onRead=()=>{},maxBytes=32*1024*1024}={}) {
  const cache=new Map(),pending=new Map();let held=0;
  return async segment=>{
    signal?.throwIfAborted();
    const key=JSON.stringify([segment.url,segment.range]);
    if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
    if(pending.has(key))return pending.get(key);
    const promise=(async()=>{
      const response=await api.request(segment.url,{type:'arraybuffer',range:segment.range,signal});
      signal?.throwIfAborted();const data=new Uint8Array(response.data);
      while(cache.size && held+data.byteLength>maxBytes){const [old,value]=cache.entries().next().value;cache.delete(old);held-=value.byteLength;}
      cache.set(key,data);held+=data.byteLength;onRead(data.byteLength);return data;
    })();
    pending.set(key,promise);
    try{return await promise;}finally{pending.delete(key);}
  };
}

export function recordingSource(groups,read) {
  const resources=new Map();let number=0;
  const lines=['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:'+Math.ceil(groups.reduce((max,g)=>g.segments.reduce((n,s)=>Math.max(n,s.duration),max),0))];
  for(const [i,group]of groups.entries()){
    if(i)lines.push('#EXT-X-DISCONTINUITY');
    for(const segment of group.segments){
      const path=`https://recording.invalid/${number++}`;
      resources.set(path,group.map?[group.map,segment]:[segment]);
      lines.push(`#EXTINF:${segment.duration},`,path);
    }
  }
  lines.push('#EXT-X-ENDLIST');
  const manifest=new TextEncoder().encode(lines.join('\n'));
  return new CustomPathedSource('https://recording.invalid/index.m3u8',request=>{
    if(request.isRoot)return new BufferSource(manifest);
    const parts=resources.get(String(request.path));
    let sizes;
    return new CustomSource({maxCacheSize:0,
      async getSize(){sizes=[];for(const part of parts)sizes.push((await read(part)).byteLength);return sizes.reduce((a,b)=>a+b,0);},
      async read(start,end){
        const result=new Uint8Array(end-start);let offset=0;
        for(const [i,part]of parts.entries()){
          const left=Math.max(start,offset),right=Math.min(end,offset+sizes[i]);
          if(right>left)result.set((await read(part)).subarray(left-offset,right-offset),left-start);
          offset+=sizes[i];
        }
        return result;
      },
    });
  });
}

export async function saveRecording(api, groups, fileHandle, {signal,onProgress=()=>{}}={}) {
  let file,input,output,conversion,canceling,bytes=0,written=0;
  const cancel=()=>{if(conversion)canceling=conversion.cancel();};
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    signal?.throwIfAborted();file=await fileHandle.createWritable();
    const read=createSegmentCache(api,{signal,onRead:size=>{bytes+=size;onProgress({bytes,written});}});
    input=new Input({source:recordingSource(groups,read),formats:[HLS,MP4,MPEG_TS]});
    // The wrapper leaves committing/aborting the file to this function, including on muxer cancellation.
    const writable=new WritableStream({async write(chunk){signal?.throwIfAborted();await file.write(chunk);written=Math.max(written,chunk.position+chunk.data.byteLength);onProgress({bytes,written});}});
    output=new Output({format:new Mp4OutputFormat({fastStart:'fragmented'}),target:new StreamTarget(writable,{chunked:true,chunkSize:1024*1024})});
    conversion=await Conversion.init({input,output,copy:{mode:'forced'},showWarnings:false,composable:true});
    signal?.throwIfAborted();
    if(!conversion.isValid||conversion.discardedTracks.length)throw new Error('本场编码无法完整保存为 MP4，已停止下载，避免丢失声音或画面。');
    conversion.onProgress=progress=>onProgress({progress,bytes,written});
    await output.start();await conversion.execute();signal?.throwIfAborted();await output.finalize();signal?.throwIfAborted();await file.close();file=null;
    return {bytes:written};
  } catch(error) {
    if(signal?.aborted)throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort',cancel);
    try{if(canceling)await canceling;if(output && output.state!=='finalized' && output.state!=='canceled')await output.cancel();}
    finally{input?.dispose();if(file)await file.abort();}
  }
}
