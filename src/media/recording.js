import { Input, MP4, MPEG_TS, BufferSource,
  Output, StreamTarget, Mp4OutputFormat, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';
import {createRecordingDownload} from './recording-download.js';
import {RecordingTimeline,recordingTime} from './recording-timeline.js';
// Fragments run to several megabytes; one byte and its Content-Range give the size.
async function segmentSize(api,segment,signal) {
  try{
    const {headers}=await api.request(segment.url,{type:'arraybuffer',range:{offset:0,length:1},needHeaders:true,signal});
    const total=Number(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headers??'')?.[1]);
    if(total>0)return total;
  }catch(error){signal?.throwIfAborted();}
  return (await api.request(segment.url,{type:'arraybuffer',signal})).data.byteLength;
}

export async function estimateRecordingRate(api, groups, signal, previous) {
  // Sample each uninterrupted part so quality changes are reflected in its estimate.
  const rates=[];
  for (const group of groups) {
    const cached=previous?.groups.find(old=>old.start===group.start&&old.streamIndex===group.streamIndex);
    if(cached){rates.push({...group,rate:cached.rate});continue;}
    const sample=group.segments[Math.floor(group.segments.length/2)];
    const size=sample.range?.length ?? await segmentSize(api,sample,signal);
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

export async function saveRecording(api, groups, fileHandle, {signal,stopSignal,onProgress=()=>{},onSegment=()=>{},concurrency=6}={}) {
  let file,input,output,bytes=0,written=0,processed=0,reconnecting=0,attempt=0,phase='downloading';
  const requests=new AbortController();
  const abort=()=>requests.abort(signal.reason),stop=()=>{phase='stopping';requests.abort(stopSignal.reason);};
  signal?.addEventListener('abort',abort,{once:true});stopSignal?.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)abort();else if(stopSignal?.aborted)stop();
  const samples=[{at:performance.now(),bytes:0}], started=samples[0].at;
  function report(complete=false){
    const now=performance.now();
    while(samples.length>1&&samples[1].at<now-5000)samples.shift();
    const speed=(bytes-samples[0].bytes)/Math.max(1,(now-Math.max(started,samples[0].at))/1000);
    onProgress({bytes,written,progress:complete?processed:Math.min(.99,processed),speed,reconnecting,attempt,phase});
  }
  const download=createRecordingDownload(api,groups,{signal:requests.signal,concurrency,
    onRead:size=>{bytes+=size;samples.push({at:performance.now(),bytes});report();},
    onRetry:state=>{reconnecting=state.count;attempt=state.attempt;report();}});
  const timeline=new RecordingTimeline(),tracks=new Map();
  let groupIndex=-1,map,pendingDiscontinuity=false;
  try {
    signal?.throwIfAborted();
    if(stopSignal?.aborted)return {stopped:true,saved:false,bytes:0,duration:0};
    file=await fileHandle.createWritable();
    // A graceful stop cancels requests, not the disk transaction. Index writes
    // must remain possible after the network signal has been aborted.
    const writable=new WritableStream({async write(chunk){signal?.throwIfAborted();await file.write(chunk);written=Math.max(written,chunk.position+chunk.data.byteLength);report();}});
    // Keep media on disk and write the index at completion. Regular MP4 carries
    // the composition-time/edit metadata needed for B-frame playback sync.
    output=new Output({format:new Mp4OutputFormat({fastStart:false}),target:new StreamTarget(writable,{chunked:true,chunkSize:1024*1024})});
    try{for await(const item of download.segments()){
      const discontinuity=item.groupIndex!==groupIndex;
      if(discontinuity){
        groupIndex=item.groupIndex;pendingDiscontinuity=true;
        for(const target of tracks.values())target.needsKey=true;
        map=groups[groupIndex].map?await download.readMap(groups[groupIndex].map):null;
      }
      const data=map?new Uint8Array(map.byteLength+item.data.byteLength):item.data;
      if(map){data.set(map);data.set(item.data,map.byteLength);}
      input=new Input({source:new BufferSource(data),formats:[MP4,MPEG_TS]});
      const segmentTracks=[];
      let sourceStart=Infinity,sourceEnd=-Infinity;
      for(const track of await input.getTracks()){
        const key=`${track.type}:${track.number}`,codec=await track.getCodec();
        if(!['video','audio'].includes(track.type)||!output.format.getSupportedCodecs().includes(codec))throw new Error('本场编码无法保存为 MP4，已停止，以免丢失声音或画面。');
        const config=await track.getDecoderConfig();
        let target=tracks.get(key);
        if(!target){
          if(output.state!=='pending')throw new Error('录像中途音视频结构发生变化，无法保存到同一个 MP4。');
          const source=track.type==='video'?new EncodedVideoPacketSource(codec):new EncodedAudioPacketSource(codec);
          if(track.type==='video')output.addVideoTrack(source,{rotation:await track.getRotation()});
          else output.addAudioTrack(source);
          target={source,codec,needsKey:true,written:false};tracks.set(key,target);
        }
        if(target.codec!==codec)throw new Error('录像中途音视频结构发生变化，无法保存到同一个 MP4。');
        const packets=[];
        for await(const original of new EncodedPacketSink(track).packets()){
          download.signal.throwIfAborted();
          sourceStart=Math.min(sourceStart,original.timestamp);
          sourceEnd=Math.max(sourceEnd,original.timestamp+original.duration);
          // Container sync flags may be wrong in either direction, including
          // AAC marked as dependent. Inspect every packet, not just sync flags.
          const type=await track.determinePacketType(original)??original.type;
          const packet=type===original.type?original:original.clone({type});
          // A recording (or a new discontinuity) can begin inside a GOP.
          // Wait for a verified random-access packet, even across files. Ordinary
          // segment boundaries must keep delta packets belonging to the prior GOP.
          if(target.needsKey){if(packet.type!=='key')continue;target.needsKey=false;}
          packets.push(packet);
        }
        segmentTracks.push({key,packets,target,config});
      }
      if(!segmentTracks.some(track=>track.packets.length)){
        input.dispose();input=null;processed=(item.index+1)/item.count;report();continue;
      }
      const offset=timeline.append(segmentTracks,pendingDiscontinuity);pendingDiscontinuity=false;
      onSegment({segment:item.segment,start:recordingTime(sourceStart+offset),end:recordingTime(sourceEnd+offset)});
      if(output.state==='pending')await output.start();
      // Interleave tracks in small batches without changing each track's decode order.
      const cursors=segmentTracks.map(()=>0);
      while(segmentTracks.some((track,i)=>cursors[i]<track.packets.length)){
        for(const [i,track]of segmentTracks.entries()){
          for(let batch=0;batch<32&&cursors[i]<track.packets.length;batch++){
            // Finish all tracks of a segment once muxing starts. Stopping in
            // the middle of a batch could leave audio/video at different ends.
            signal?.throwIfAborted();
            const packet=track.packets[cursors[i]++];
            await track.target.source.add(packet.clone({timestamp:recordingTime(packet.timestamp+offset)}),{decoderConfig:track.config});
            track.target.written=true;
          }
        }
      }
      input.dispose();input=null;processed=(item.index+1)/item.count;report();
    }}catch(error){
      signal?.throwIfAborted();
      if(!stopSignal?.aborted||error!==stopSignal.reason||download.signal.reason!==stopSignal.reason)throw error;
    }
    signal?.throwIfAborted();
    const stopped=Boolean(stopSignal?.aborted&&processed<1);
    if(stopped&&(!tracks.size||[...tracks.values()].some(track=>!track.written)))return {stopped:true,saved:false,bytes:0,duration:0};
    if(!tracks.size||[...tracks.values()].some(track=>!track.written))throw new Error('这段录像缺少关键帧，无法导出。');
    phase='finalizing';report();
    for(const track of tracks.values())track.source.close();
    await output.finalize();signal?.throwIfAborted();await file.close();file=null;phase='saved';report(true);
    return {bytes:written,stopped,saved:true,duration:timeline.end};
  } catch(error) {
    if(signal?.aborted)throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort',abort);stopSignal?.removeEventListener('abort',stop);
    await download.close();
    try{if(output && output.state!=='finalized' && output.state!=='canceled')await output.cancel();}
    finally{input?.dispose();if(file)await file.abort();}
  }
}
