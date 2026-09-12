import {
  Input, BlobSource, MP4, MPEG_TS, Output, BufferTarget, Mp4OutputFormat, Conversion, QUALITY_HIGH,
} from 'mediabunny';
import { mapConcurrent, selectPlaylistRange } from './hls.js';

export async function convertMp4(blob, { start, end, precise = false, signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const input = new Input({ source: new BlobSource(blob), formats: [MP4, MPEG_TS] });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let conversion;
  const cancel = () => { if (conversion) void conversion.cancel(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const options = { input, output, copy: precise ? false : { mode: 'forced' }, showWarnings: false };
    if (start !== undefined || end !== undefined) options.trim = { start, end };
    if (precise) { options.video = { codec: 'avc', bitrate: QUALITY_HIGH }; options.audio = { codec: 'aac', bitrate: 192000 }; }
    conversion = await Conversion.init(options);
    signal?.throwIfAborted();
    if (!conversion.isValid || conversion.discardedTracks.length) {
      throw new Error(precise
        ? '当前浏览器无法完成这段录像的精确编码，请使用原画下载或更新 Chrome / Edge。'
        : '这段录像无法完整封装为 MP4，已停止导出，避免丢失声音或画面。');
    }
    conversion.onProgress = onProgress;
    await conversion.execute();
    signal?.throwIfAborted();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    input.dispose();
  }
}

async function mediaDuration(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try { return await input.computeDuration(); }
  finally { input.dispose(); }
}

// Use the same full playlist timeline as the preview, then retrieve only overlapping segments.
export async function exportSelection(api,record,groups,selection,{signal,precise=false,onProgress=()=>{}}){
 const outputs=[];let bytes=0;
 const parsed={groups:groups.filter(group=>selection.start<group.streamEnd-record.start).map(group=>({...group,offset:group.start-record.start}))};
 for(const plan of selectPlaylistRange(parsed,selection.start,selection.end)){
   const segments=plan.map?[plan.map,...plan.segments]:plan.segments;let done=0;
   const chunks=await mapConcurrent(segments,3,async segment=>{const r=await api.request(segment.url,{type:'arraybuffer',range:segment.range,signal});bytes+=r.data.byteLength;onProgress({phase:'download',done:++done,count:segments.length,bytes});return r.data;},signal);
   const normalized=await convertMp4(new Blob(chunks),{signal});const duration=await mediaDuration(normalized);
   const start=Math.min(plan.start,duration),end=Math.min(plan.end,duration);
   if(end<=start)throw new Error('选区与录像时间线不一致，请刷新后重新定位。');
   const blob=await convertMp4(normalized,{start,end,precise,signal,onProgress:p=>onProgress({phase:'encode',progress:p,bytes})});
   outputs.push({blob,start:plan.offset+start,end:plan.offset+end});
 }
 if(!outputs.length)throw new Error('选区中没有可用录像，请调整起止位置。');
 return outputs;
}
