import {clamp} from '../shared/math.js';
import {formatTimeRange} from '../shared/format.js';
import {zoomWindow, panWindow, validateRange} from './timeline-model.js';
import {isEditing} from './shortcuts.js';

const KEYBOARD_STEP=5;

export function fitSelection(start,end,total,min=0) {
 const width=Math.min(total-min,(end-start)*1.12);
 const left=clamp(start-(width-(end-start))/2,min,total-width);
 return {start:left,end:left+width};
}
export function dragSelection(session,x,width,selection,total,min=0) {
 const delta=(x-session.x)/width*(session.view.end-session.view.start);
 return moveBoundary(selection,session.type,session.anchor+delta,total,min);
}
function moveBoundary(selection,type,time,total,min=0) {
 const gap=Math.min(.001,(total-min)/2);
 const target=clamp(time,min,total);
 const next={...selection};
 if(type==='start')next.start=Math.min(target,selection.end-gap);
 else next.end=Math.max(target,selection.start+gap);
 return next;
}
export function createTimeline({track,startHandle,endHandle,selectionElement,playhead,ticks,labels,onPreview,onScrubStart,onScrubEnd,onSelection=()=>{},onView=()=>{}}) {
 let min=0,total=0,selection={start:0,end:1},view={start:0,end:1},drag=null,current=0,locked=false,frame=0,pending,zoomFrame=0,zooming=false,zoomTarget=null,tickTimes=[];
 const pct=t=>clamp((t-view.start)/(view.end-view.start)*100,0,100);
 const timeLabel=t=>{const h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60;return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');};
 const tickElements=Array.from({length:5},()=>document.createElement('span'));
 ticks.replaceChildren(...tickElements);
 function renderPlayhead(){
  playhead.style.left=`${pct(current)}%`;playhead.hidden=current<view.start||current>view.end;
 }
 const loaded=()=>total>min;
 function renderLock(){for(const el of [startHandle,endHandle])el.disabled=locked||!loaded();}
 function render(){
  startHandle.style.left=`${pct(selection.start)}%`;endHandle.style.left=`${pct(selection.end)}%`;
  selectionElement.style.left=`${pct(selection.start)}%`;selectionElement.style.right=`${100-pct(selection.end)}%`;
  for(const [el,value]of[[startHandle,selection.start],[endHandle,selection.end]]){el.setAttribute('aria-valuenow',value.toFixed(3));el.setAttribute('aria-valuemin',min);el.setAttribute('aria-valuemax',total);}
  if(!zooming)tickTimes=tickElements.map((_,i)=>view.start+(view.end-view.start)*i/4);
  tickElements.forEach((span,i)=>{
   const position=(tickTimes[i]-view.start)/(view.end-view.start)*100;
   span.textContent=timeLabel(tickTimes[i]);span.style.left=`${position}%`;
   span.style.transform=`translateX(-${clamp(position,0,100)}%)`;
  });
  track.dataset.zoom=`${((total-min)/(view.end-view.start)).toFixed(1)}×`;
  track.style.setProperty('--view-start',`${(view.start-min)/(total-min)*100}%`);
  track.style.setProperty('--view-width',`${(view.end-view.start)/(total-min)*100}%`);
  labels.textContent=formatTimeRange(selection.start,selection.end);
  renderPlayhead();renderLock();onView({...view},{animating:zooming,target:zoomTarget??view});
 }
 function stopZoom(){
  if(!zooming)return;
  cancelAnimationFrame(zoomFrame);zoomFrame=0;zooming=false;zoomTarget=null;track.classList.remove('refitting');
 }
 function setSelection(next,refit=false){
  validateRange(next.start,next.end,total,min);stopZoom();selection=next;render();onSelection({...selection});if(refit)fitView();
 }
 function fitView(){
  stopZoom();
  const target=fitSelection(selection.start,selection.end,total,min);
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
   const left=clamp(middle-width/2,min,total-width);
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
  if(drag.type==='playhead')target=clamp(drag.view.start+(x-rect.left)/rect.width*(drag.view.end-drag.view.start),min,total);
  else{selection=dragSelection(drag,x,rect.width,selection,total,min);target=selection[drag.type];view={start:Math.min(view.start,selection.start),end:Math.max(view.end,selection.end)};}
  current=target;
  if(drag.type==='playhead')renderPlayhead();else{render();onSelection({...selection});}
  onPreview(target);
 }
 function flush(){cancelAnimationFrame(frame);frame=0;if(pending!==undefined){apply(pending);pending=undefined;}}
 track.addEventListener('pointerdown',e=>{
  if(e.button!==0||locked||!loaded())return;e.preventDefault();if(zooming){stopZoom();render();}
  const type=e.target.closest('[data-handle]')?.dataset.handle||'playhead';
  (type==='playhead'?track:type==='start'?startHandle:endHandle).focus({preventScroll:true});
  drag={type,x:e.clientX,view:{...view},anchor:selection[type]};onScrubStart?.();track.setPointerCapture(e.pointerId);apply(e.clientX);
 });
 // A release outside the page may never reach the track; end the drag as soon as the button is up.
 track.addEventListener('pointermove',e=>{if(!drag)return;if(!(e.buttons&1)){finish(e);return;}pending=e.clientX;if(!frame)frame=requestAnimationFrame(flush);});
 function finish(e){if(!drag)return;flush();const type=drag.type;drag=null;if(track.hasPointerCapture(e.pointerId))track.releasePointerCapture(e.pointerId);if(type!=='playhead')fitView();onScrubEnd?.(current,{canceled:e.type==='pointercancel'});}
 track.addEventListener('pointerup',finish);track.addEventListener('pointercancel',finish);track.addEventListener('lostpointercapture',finish);
 track.addEventListener('wheel',e=>{if(locked||!loaded()||drag)return;e.preventDefault();stopZoom();const r=track.getBoundingClientRect();view=e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)?panWindow(view,total,(e.deltaX||e.deltaY)/r.width*(view.end-view.start),min):zoomWindow(view,total,Math.exp(e.deltaY*.005),(e.clientX-r.left)/r.width,min);render();},{passive:false});
 function handleKeyDown(e){
  if(e.defaultPrevented||e.isComposing||e.altKey||e.ctrlKey||e.metaKey||isEditing(e)||!['ArrowLeft','ArrowRight'].includes(e.key)||locked||!loaded()||drag)return;
  e.preventDefault();e.stopPropagation();
  const type=e.target.closest('[data-handle]')?.dataset.handle||'playhead';
  const delta=e.key==='ArrowRight'?KEYBOARD_STEP:-KEYBOARD_STEP;
  onScrubStart?.();
  if(type==='playhead'){
   current=clamp(current+delta,min,total);
   if(zooming){stopZoom();render();}else renderPlayhead();
  }else{
   const next=moveBoundary(selection,type,selection[type]+delta,total,min);
   current=next[type];setSelection(next,true);
  }
  onPreview(current);onScrubEnd?.(current);
 }
 // reset() takes a duration (0..duration) or explicit {start,end} bounds.
 return {handleKeyDown,reset(bounds,next){const range=typeof bounds==='number'?{start:0,end:bounds}:bounds;stopZoom();min=range.start;total=range.end;current=min;view={...range};setSelection(next??{...range});},setSelection,getSelection:()=>({...selection}),getView:()=>({...view}),setCurrent(t){if(!drag){current=t;renderPlayhead();}},lock(value){locked=value;if(value&&zooming){stopZoom();render();}renderLock();},stop(){if(zooming){stopZoom();render();}}};
}
