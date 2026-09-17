import {clamp} from '../shared/math.js';
import {formatTimeRange} from '../shared/format.js';
import {zoomWindow, panWindow, validateRange} from './timeline-model.js';
import {isEditing} from './shortcuts.js';

const KEYBOARD_STEP=5;

export function fitSelection(start,end,total) {
 const width=Math.min(total,(end-start)*1.12);
 const left=clamp(start-(width-(end-start))/2,0,total-width);
 return {start:left,end:left+width};
}
export function dragSelection(session,x,width,selection,total) {
 const delta=(x-session.x)/width*(session.view.end-session.view.start);
 return moveBoundary(selection,session.type,session.anchor+delta,total);
}
function moveBoundary(selection,type,time,total) {
 const gap=Math.min(.001,total/2);
 const target=clamp(time,0,total);
 const next={...selection};
 if(type==='start')next.start=Math.min(target,selection.end-gap);
 else next.end=Math.max(target,selection.start+gap);
 return next;
}
export function createTimeline({track,startHandle,endHandle,selectionElement,playhead,ticks,labels,onPreview,onScrubStart,onScrubEnd,onSelection=()=>{},onView=()=>{}}) {
 let total=0,selection={start:0,end:1},view={start:0,end:1},drag=null,current=0,locked=false,frame=0,pending,zoomFrame=0,zooming=false,zoomTarget=null,tickTimes=[];
 const pct=t=>clamp((t-view.start)/(view.end-view.start)*100,0,100);
 const timeLabel=t=>{const h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60;return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');};
 const tickElements=Array.from({length:5},()=>document.createElement('span'));
 ticks.replaceChildren(...tickElements);
 function renderPlayhead(){
  playhead.style.left=`${pct(current)}%`;playhead.hidden=current<view.start||current>view.end;
 }
 function renderLock(){for(const el of [startHandle,endHandle])el.disabled=locked||!total;}
 function render(){
  startHandle.style.left=`${pct(selection.start)}%`;endHandle.style.left=`${pct(selection.end)}%`;
  selectionElement.style.left=`${pct(selection.start)}%`;selectionElement.style.right=`${100-pct(selection.end)}%`;
  for(const [el,value]of[[startHandle,selection.start],[endHandle,selection.end]]){el.setAttribute('aria-valuenow',value.toFixed(3));el.setAttribute('aria-valuemin',0);el.setAttribute('aria-valuemax',total);}
  if(!zooming)tickTimes=tickElements.map((_,i)=>view.start+(view.end-view.start)*i/4);
  tickElements.forEach((span,i)=>{
   const position=(tickTimes[i]-view.start)/(view.end-view.start)*100;
   span.textContent=timeLabel(tickTimes[i]);span.style.left=`${position}%`;
   span.style.transform=`translateX(-${clamp(position,0,100)}%)`;
  });
  track.dataset.zoom=`${(total/(view.end-view.start)).toFixed(1)}×`;
  track.style.setProperty('--view-start',`${view.start/total*100}%`);
  track.style.setProperty('--view-width',`${(view.end-view.start)/total*100}%`);
  labels.textContent=formatTimeRange(selection.start,selection.end);
  renderPlayhead();renderLock();onView({...view},{animating:zooming,target:zoomTarget??view});
 }
 function stopZoom(){
  if(!zooming)return;
  cancelAnimationFrame(zoomFrame);zoomFrame=0;zooming=false;zoomTarget=null;track.classList.remove('refitting');
 }
 function setSelection(next,refit=false){
  validateRange(next.start,next.end,total);stopZoom();selection=next;render();onSelection({...selection});if(refit)fitView();
 }
 function fitView(){
  stopZoom();
  const target=fitSelection(selection.start,selection.end,total);
  if(target.start===view.start&&target.end===view.end)return;
  if(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){view=target;render();return;}
  const from={...view},span=from.end-from.start,center=(from.start+from.end)/2;
  const targetSpan=target.end-target.start,targetCenter=(target.start+target.end)/2;
  let began;
  zooming=true;zoomTarget=target;track.classList.add('refitting');
  onView({...view},{animating:true,target});
  function step(now){
   began??=now;
   const progress=clamp((now-began)/420,0,1),ease=progress*progress*(3-2*progress);
   const width=span*Math.exp(Math.log(targetSpan/span)*ease);
   // Use the same interpolation for both edges so a visible selection stays visible.
   const travel=span===targetSpan?ease:(span-width)/(span-targetSpan);
   const middle=center+(targetCenter-center)*travel;
   const left=clamp(middle-width/2,0,total-width);
   view={start:left,end:left+width};
   if(progress===1){stopZoom();view=target;}
   render();
   if(zooming)zoomFrame=requestAnimationFrame(step);
  }
  zoomFrame=requestAnimationFrame(step);
 }
 function apply(x){
  if(!drag)return;
  const rect=track.getBoundingClientRect();let target;
  if(drag.type==='playhead')target=clamp(drag.view.start+(x-rect.left)/rect.width*(drag.view.end-drag.view.start),0,total);
  else{selection=dragSelection(drag,x,rect.width,selection,total);target=selection[drag.type];view={start:Math.min(view.start,selection.start),end:Math.max(view.end,selection.end)};}
  current=target;
  if(drag.type==='playhead')renderPlayhead();else{render();onSelection({...selection});}
  onPreview(target);
 }
 function flush(){cancelAnimationFrame(frame);frame=0;if(pending!==undefined){apply(pending);pending=undefined;}}
 track.addEventListener('pointerdown',e=>{
  if(e.button!==0||locked||!total)return;e.preventDefault();if(zooming){stopZoom();render();}
  const type=e.target.closest('[data-handle]')?.dataset.handle||'playhead';
  (type==='playhead'?track:type==='start'?startHandle:endHandle).focus({preventScroll:true});
  drag={type,x:e.clientX,view:{...view},anchor:selection[type]};onScrubStart?.();track.setPointerCapture(e.pointerId);apply(e.clientX);
 });
 track.addEventListener('pointermove',e=>{if(!drag)return;pending=e.clientX;if(!frame)frame=requestAnimationFrame(flush);});
 function finish(e){if(!drag)return;flush();const type=drag.type;drag=null;if(track.hasPointerCapture(e.pointerId))track.releasePointerCapture(e.pointerId);if(type!=='playhead')fitView();onScrubEnd?.(current);}
 track.addEventListener('pointerup',finish);track.addEventListener('pointercancel',finish);
 track.addEventListener('wheel',e=>{if(locked||!total||drag)return;e.preventDefault();stopZoom();const r=track.getBoundingClientRect();view=e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)?panWindow(view,total,(e.deltaX||e.deltaY)/r.width*(view.end-view.start)):zoomWindow(view,total,Math.exp(e.deltaY*.005),(e.clientX-r.left)/r.width);render();},{passive:false});
 function handleKeyDown(e){
  if(e.defaultPrevented||e.isComposing||e.altKey||e.ctrlKey||e.metaKey||isEditing(e)||!['ArrowLeft','ArrowRight'].includes(e.key)||locked||!total||drag)return;
  e.preventDefault();e.stopPropagation();
  const type=e.target.closest('[data-handle]')?.dataset.handle||'playhead';
  const delta=e.key==='ArrowRight'?KEYBOARD_STEP:-KEYBOARD_STEP;
  onScrubStart?.();
  if(type==='playhead'){
   current=clamp(current+delta,0,total);
   if(zooming){stopZoom();render();}else renderPlayhead();
  }else{
   const next=moveBoundary(selection,type,selection[type]+delta,total);
   current=next[type];setSelection(next,true);
  }
  onPreview(current);onScrubEnd?.(current);
 }
 return {handleKeyDown,reset(duration,next={start:0,end:duration}){stopZoom();total=duration;current=0;view={start:0,end:total};setSelection(next);},setSelection,getSelection:()=>({...selection}),getView:()=>({...view}),setCurrent(t){if(!drag){current=t;renderPlayhead();}},lock(value){locked=value;if(value&&zooming){stopZoom();render();}renderLock();},stop(){if(zooming){stopZoom();render();}}};
}
