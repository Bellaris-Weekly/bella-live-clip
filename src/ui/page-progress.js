// Listen without preventing B站's own drag/seek behavior. Its already-cropped
// progress image is reused when available; the player can request a still otherwise.
export function bindPageProgress({document,getPlayer,isActive}) {
 let drag=null,frame=null,finishFrame=null;
 const timeFromLabel=text=>text.trim().split(':').reduce((sum,part)=>sum*60+Number(part),0);
 function paint(){
  frame=null;if(!drag||!isActive())return;
  const image=document.querySelector('.bpx-player-progress-preview-image');
  const label=document.querySelector('.bpx-player-progress-preview-time')?.textContent??'';
  const time=/^\d+(?::\d{2}){1,2}$/.test(label.trim())?timeFromLabel(label):drag.time;
  if(image?.complete&&image.naturalWidth)drag.player.previewImage(image,time);
  else drag.player.seek(drag.time);
 }
 function move(event){
  if(!drag||event.pointerId!==drag.id||!isActive())return;
  const rect=drag.track.getBoundingClientRect();
  drag.time=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width))*drag.duration;
  if(frame===null)frame=requestAnimationFrame(paint);
 }
 function down(event){
  if(event.button!==0||!isActive())return;
  const track=event.target.closest('.bpx-player-progress-schedule-wrap, .bpx-player-progress');
  const video=document.querySelector('.bpx-player-container video, .bilibili-player-video video')??document.querySelector('video');
  if(!track||!video||!(video.duration>0))return;
  if(finishFrame!==null)cancelAnimationFrame(finishFrame);finishFrame=null;
  drag={id:event.pointerId,track,duration:video.duration,player:getPlayer(),time:video.currentTime};
  drag.player.begin();move(event);
 }
 function finish(event){
  if(!drag||event.pointerId!==drag.id)return;
  const own=drag;drag=null;if(frame!==null)cancelAnimationFrame(frame);frame=null;
  // Mouseup handlers in the site perform the committed seek after pointerup.
  finishFrame=requestAnimationFrame(()=>{finishFrame=null;own.player.end({commit:false});});
 }
 document.addEventListener('pointerdown',down,{capture:true});document.addEventListener('pointermove',move,{capture:true});
 document.addEventListener('pointerup',finish,{capture:true});document.addEventListener('pointercancel',finish,{capture:true});
 return ()=>{
  if(frame!==null)cancelAnimationFrame(frame);if(finishFrame!==null)cancelAnimationFrame(finishFrame);drag?.player.end({commit:false});drag=null;
  document.removeEventListener('pointerdown',down,{capture:true});document.removeEventListener('pointermove',move,{capture:true});
  document.removeEventListener('pointerup',finish,{capture:true});document.removeEventListener('pointercancel',finish,{capture:true});
 };
}
