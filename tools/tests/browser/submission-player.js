import {createSubmissionPlayer} from '../../../src/media/submission-player.js';

// Standalone browser probe for an actual page video (including MSE-backed B站
// videos). Caller owns the page video; this probe must not change its playback.
export async function runSubmissionPlayerChecks({video,canvas,loading,submission,onProgress=()=>{}}){
 const before={paused:video.paused,time:video.currentTime,muted:video.muted,volume:video.volume};
 const errors=[],times=[];
 const player=createSubmissionPlayer({canvas,loading,getVideo:()=>video,isCurrent:()=>true,
  getRange:()=>({start:0,end:submission.duration}),onTime:t=>times.push(t),onState(){},status:e=>errors.push(e)});
 try{
  onProgress('显示页面播放器的已解码画面');
  await player.load(submission,new AbortController().signal);
  if(video.paused!==before.paused||video.muted!==before.muted||video.volume!==before.volume)throw new Error('镜像改变了原播放器状态');
  if(!canvas.width||loading.hidden!==true)throw new Error('镜像未显示画面');
  if(Math.abs(times.at(-1)-video.currentTime)>.2)throw new Error('镜像时间没有跟随原播放器');
  player.suspend();
  if(video.paused!==before.paused)throw new Error('关闭镜像暂停了页面');
  player.resume();
  if(errors.length)throw new Error(errors.join(';'));
  return {passed:true,width:canvas.width,height:canvas.height,time:times.at(-1),preservedAudio:true};
 }finally{player.destroy();}
}
