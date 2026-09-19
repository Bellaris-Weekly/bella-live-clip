import {clamp} from '../shared/math.js';

// One playback clock and one audio source: the page video owns playback. The
// canvas only displays decoded frames; it never opens a second media stream.
export function createSubmissionPlayer({canvas,loading,getVideo,isCurrent,onTime,onState,status,getRange,createPreview}) {
 const context=canvas.getContext('2d');
 let source=null,submission=null,visible=false,frameId=null,stopTimer=null,range=null;
 let scrubbing=false,previewTime=null,preview=null,previewRead=null;
 const listeners=[];
 const stopTimerNow=()=>{clearTimeout(stopTimer);stopTimer=null;};
 const stopFrame=()=>{if(frameId!==null)source?.cancelVideoFrameCallback(frameId);frameId=null;};
 const play=()=>{if(source)void source.play().catch(error=>{if(error.name!=='AbortError')status(error.message,true);});};
 function draw(){
  if(!source||!visible||scrubbing)return;
  onTime(source.currentTime);onState();
  if(source.readyState<2||source.seeking||!source.videoWidth){loading.hidden=false;return;}
  const width=Math.min(640,source.videoWidth),height=Math.round(width*source.videoHeight/source.videoWidth);
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  context.drawImage(source,0,0,width,height);loading.hidden=true;
 }
 function scheduleFrame(){
  if(frameId!==null||!source||source.paused||!visible||scrubbing)return;
  const own=source;
  frameId=own.requestVideoFrameCallback(()=>{
   frameId=null;if(source!==own||!visible)return;
   draw();check();scheduleFrame();
  });
 }
 function check(){
  stopTimerNow();
  if(!source||!range||source.paused||source.seeking||scrubbing)return;
  if(source.currentTime>=range.end){
   const end=range.end;range=null;source.pause();source.currentTime=end;draw();return;
  }
  if(source.playbackRate>0)stopTimer=setTimeout(check,(range.end-source.currentTime)/source.playbackRate*1000);
 }
 function update(){draw();check();scheduleFrame();}
 function clearPreview(){
  previewRead?.abort();previewRead=null;
 }
 function cancel(){
  stopTimerNow();range=null;clearPreview();scrubbing=false;previewTime=null;
 }
 function detach(){
  stopFrame();stopTimerNow();
  for(const [name,listener]of listeners)source.removeEventListener(name,listener);
  listeners.length=0;source=null;range=null;clearPreview();scrubbing=false;previewTime=null;
 }
 function refresh(){
  if(!visible||!submission)return;
  const next=isCurrent()?getVideo():null;
  if(next!==source){
   detach();context.clearRect(0,0,canvas.width,canvas.height);
   source=next;
   if(source){
    const listen=(name,listener)=>{source.addEventListener(name,listener);listeners.push([name,listener]);};
    for(const name of ['loadeddata','seeked','timeupdate','playing','ratechange','resize'])listen(name,update);
    listen('play',update);
    for(const name of ['pause','ended'])listen(name,()=>{stopFrame();stopTimerNow();draw();});
    listen('seeking',()=>{if(range&&(source.currentTime<range.start||source.currentTime>range.end))range=null;stopTimerNow();update();});
    listen('emptied',()=>{range=null;stopFrame();stopTimerNow();context.clearRect(0,0,canvas.width,canvas.height);loading.hidden=false;});
    listen('waiting',()=>{if(!scrubbing){loading.hidden=false;loading.textContent='等待 B 站播放器缓冲…';}stopTimerNow();});
   }
  }
  if(!source){loading.hidden=false;loading.textContent=isCurrent()?'等待 B 站播放器…':'已切换视频，请载入当前视频';onState();return;}
  if(!scrubbing)loading.textContent='等待 B 站播放器画面…';update();
 }
 function showPreview(frame,time){
  if(!scrubbing||!visible)return;
  previewTime=time;onTime(time);
  canvas.width=Math.min(640,frame.width);canvas.height=Math.round(canvas.width*frame.height/frame.width);
  context.drawImage(frame.image,frame.x,frame.y,frame.width,frame.height,0,0,canvas.width,canvas.height);loading.hidden=true;
 }
 const seek=async time=>{
  refresh();if(!submission||!visible)return;
  const target=clamp(time,0,Math.max(0,submission.duration-.001));
  if(!scrubbing){if(source)source.currentTime=target;return;}
  clearPreview();previewTime=target;onTime(target);loading.hidden=false;loading.textContent='正在读取进度预览图…';
  const own=new AbortController();previewRead=own;
  try{const frame=await preview.read(target,own.signal);if(!own.signal.aborted&&previewRead===own)showPreview(frame,target);}
  catch(error){if(!own.signal.aborted&&previewRead===own){loading.hidden=false;loading.textContent='当前位置暂无预览图，松开后定位播放';}}
 };
 const toggle=()=>{refresh();range=null;stopTimerNow();if(source){if(source.paused||source.ended)play();else source.pause();}};
 const click=event=>{if(event.detail===1)toggle();};
 const key=event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();event.stopPropagation();toggle();}};
 const fullscreen=()=>{void canvas.requestFullscreen().catch(error=>status(error.message,true));};
 canvas.addEventListener('click',click);canvas.addEventListener('keydown',key);canvas.addEventListener('dblclick',fullscreen);
 function clear(){detach();preview?.dispose();preview=null;submission=null;visible=false;context.clearRect(0,0,canvas.width,canvas.height);}
 return {
  async load(next,signal){signal.throwIfAborted();clear();submission=next;preview=createPreview(next);visible=true;refresh();return {total:next.duration};},
  refresh,seek,position:()=>previewTime??source?.currentTime??0,isPaused:()=>!source||source.paused||source.ended,
  pause(){source?.pause();},toggle,check,cancel,
  begin(){refresh();clearPreview();range=null;stopTimerNow();stopFrame();scrubbing=true;previewTime=source?.currentTime??0;},
  previewImage(image,time){clearPreview();showPreview({image,x:0,y:0,width:image.naturalWidth,height:image.naturalHeight},time);},
  end({commit=true}={}){const target=previewTime,wasScrubbing=scrubbing;clearPreview();scrubbing=false;previewTime=null;if(wasScrubbing&&commit&&source&&target!==null)source.currentTime=target;update();},
  playSelection(){refresh();if(!source)return;range={...getRange()};source.currentTime=range.start;play();},
  suspend(){cancel();visible=false;detach();},
  resume(){visible=true;refresh();},
  clear,destroy(){clear();canvas.removeEventListener('click',click);canvas.removeEventListener('keydown',key);canvas.removeEventListener('dblclick',fullscreen);},
 };
}
