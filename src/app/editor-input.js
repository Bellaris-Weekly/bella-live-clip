import {isEditing} from '../ui/shortcuts.js';
import {formatTimeRange,parseTime} from '../shared/format.js';

// Setting the selection by button, typed time or key.
export function bindEditorInput({root,timeline,status,getPlayer,togglePlayback,isActive}){
 const $=id=>root.getElementById(id);
 function applySelection(next,handle){try{timeline.setSelection(next,true);handle?.focus({preventScroll:true});status('');}catch(e){status(e.message,true);}}
 // Crossing the other end opens the range to the recording's edge instead of collapsing it.
 function markStart(){const s=timeline.getSelection(),t=getPlayer().position();applySelection({start:t,end:t<s.end?s.end:timeline.getBounds().end},$('startHandle'));}
 function markEnd(){const s=timeline.getSelection(),t=getPlayer().position();applySelection({start:t>s.start?s.start:timeline.getBounds().start,end:t},$('endHandle'));}
 $('markStart').onclick=markStart;$('markEnd').onclick=markEnd;
 for(const [id,edge]of[['selectionStart','start'],['selectionEnd','end']]){
  $(id).onchange=()=>{const time=parseTime($(id).value),current=timeline.getSelection();
   if(time===null)status('时间格式不对，例如 1:02:03 或 62.5。',true);else applySelection({...current,[edge]:time});
   renderRange(timeline.getSelection());};
  $(id).onkeydown=event=>{if(event.key==='Enter')$(id).blur();event.stopPropagation();};
 }
 const editorKeys={' ':()=>togglePlayback(),i:markStart,o:markEnd};
 $('editPage').addEventListener('keydown',e=>{
  if(!isActive())return;
  timeline.handleKeyDown(e);
  const action=editorKeys[e.key.toLowerCase()];
  if(!action||e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||isEditing(e)||$('wholeRecording').checked||e.key===' '&&e.target.closest?.('button'))return;
  e.preventDefault();e.stopPropagation();action();
 },{capture:true});
 function renderRange({start,end}){
  const [from,to]=formatTimeRange(start,end).split(' — ');
  if(root.activeElement!==$('selectionStart'))$('selectionStart').value=from;
  if(root.activeElement!==$('selectionEnd'))$('selectionEnd').value=to;
 }
 return {renderRange};
}
