import {VideoSampleSink} from 'mediabunny';
import {openSubmissionMedia} from './remote-mp4.js';

export async function readSubmissionThumbnail(request,submission,time,signal){
 signal.throwIfAborted();
 const media=openSubmissionMedia(request,submission,{signal,preview:true});let sample;
 try{
  const track=await media.videoInput.getPrimaryVideoTrack();
  if(!track)throw new Error('视频轨道为空');
  sample=await new VideoSampleSink(track).getSample(time);signal.throwIfAborted();
  if(!sample)throw new Error('该位置没有可解码的画面');
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
  sample.draw(canvas.getContext('2d'),0,0,160,90);return canvas;
 }finally{sample?.close();media.dispose();}
}
