import {clamp, formatCompactTime, zoomWindow, panWindow, validateRange} from './core.js';

export function fitSelection(start,end,total) {
 const width=Math.min(total,(end-start)*1.12);
 const left=clamp(start-(width-(end-start))/2,0,total-width);
 return {start:left,end:left+width};
}
export function dragSelection(session,x,width,selection,total) {
 const delta=(x-session.x)/width*(session.view.end-session.view.start);
 const gap=Math.min(.001,total/2);
 const target=clamp(session.anchor+delta,0,total);
 const next={...selection};
 if(session.type==='start')next.start=Math.min(target,selection.end-gap);
 else next.end=Math.max(target,selection.start+gap);
 return next;
}
export function createTimeline({track,startHandle,endHandle,selectionElement,playhead,ticks,labels,onPreview,onScrubStart,onScrubEnd,onSelection=()=>{}}) {
 let total=0,selection={start:0,end:1},view={start:0,end:1},drag=null,current=0,locked=false,frame=0,pending;
 const pct=t=>clamp((t-view.start)/(view.end-view.start)*100,0,100);
 const timeLabel=t=>{const h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60;return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');};
 function render(){
  startHandle.style.left=`${pct(selection.start)}%`;endHandle.style.left=`${pct(selection.end)}%`;
  selectionElement.style.left=`${pct(selection.start)}%`;selectionElement.style.right=`${100-pct(selection.end)}%`;
  playhead.style.left=`${pct(current)}%`;playhead.hidden=current<view.start||current>view.end;
  for(const [el,value]of[[startHandle,selection.start],[endHandle,selection.end]]){el.setAttribute('aria-valuenow',value.toFixed(3));el.setAttribute('aria-valuemin',0);el.setAttribute('aria-valuemax',total);el.disabled=locked||!total;}
  ticks.replaceChildren();for(let i=0;i<5;i++){const span=document.createElement('span');span.textContent=timeLabel(view.start+(view.end-view.start)*i/4);ticks.append(span);}
  labels.textContent=`${formatCompactTime(selection.start)} — ${formatCompactTime(selection.end)}`;
 }
 function setSelection(next,refit=false){validateRange(next.start,next.end,total);selection=next;if(refit)view=fitSelection(next.start,next.end,total);render();onSelection({...selection});}
 function refit(){track.classList.add('refitting');view=fitSelection(selection.start,selection.end,total);render();setTimeout(()=>track.classList.remove('refitting'),180);}
 function apply(x){
  if(!drag)return;
  const rect=track.getBoundingClientRect();let target;
  if(drag.type==='playhead')target=clamp(drag.view.start+(x-rect.left)/rect.width*(drag.view.end-drag.view.start),0,total);
  else{selection=dragSelection(drag,x,rect.width,selection,total);target=selection[drag.type];view={start:Math.min(view.start,selection.start),end:Math.max(view.end,selection.end)};}
  current=target;render();if(drag.type!=='playhead')onSelection({...selection});onPreview(target);
 }
 function flush(){cancelAnimationFrame(frame);frame=0;if(pending!==undefined){apply(pending);pending=undefined;}}
 track.addEventListener('pointerdown',e=>{
  if(e.button!==0||locked||!total)return;e.preventDefault();track.classList.remove('refitting');
  const type=e.target.closest('[data-handle]')?.dataset.handle||'playhead';
  drag={type,x:e.clientX,view:{...view},anchor:selection[type]};onScrubStart?.();track.setPointerCapture(e.pointerId);apply(e.clientX);
 });
 track.addEventListener('pointermove',e=>{if(!drag)return;pending=e.clientX;if(!frame)frame=requestAnimationFrame(flush);});
 function finish(e){if(!drag)return;flush();const type=drag.type;drag=null;if(track.hasPointerCapture(e.pointerId))track.releasePointerCapture(e.pointerId);if(type!=='playhead')refit();onScrubEnd?.(current);}
 track.addEventListener('pointerup',finish);track.addEventListener('pointercancel',finish);
 track.addEventListener('wheel',e=>{if(locked||!total||drag)return;e.preventDefault();const r=track.getBoundingClientRect();view=e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)?panWindow(view,total,(e.deltaX||e.deltaY)/r.width*(view.end-view.start)):zoomWindow(view,total,Math.exp(e.deltaY*.005),(e.clientX-r.left)/r.width);render();},{passive:false});
 for(const [el,type]of[[startHandle,'start'],[endHandle,'end']])el.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const step=(e.shiftKey?10:1)*(view.end-view.start)/1000;const next=dragSelection({type,x:0,view,anchor:selection[type]},e.key==='ArrowRight'?step:-step,view.end-view.start,selection,total);onScrubStart?.();setSelection(next,true);onPreview(next[type]);onScrubEnd?.(next[type]);};
 return {reset(duration,next){total=duration;view={start:0,end:total};setSelection(next);},setSelection,getSelection:()=>({...selection}),getView:()=>({...view}),setCurrent(t){if(!drag){current=t;render();}},lock(value){locked=value;render();},refit};
}
