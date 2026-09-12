import html from './ui.html';
import {ScheduleService} from './schedule.js';
import {createControls} from './controls.js';
import {RecordingPlan} from './recording-plan.js';
import {createRecordCard} from './record-card.js';
import {icon} from './icons.js';
import css from './ui.css';
import {createPlayer} from './full-preview.js';
import {createPlayback,bindVideoControls} from './playback.js';
import {createTimeline} from './timeline.js';
import {exportSelection} from './media.js';
import {estimateRecordingRate,estimateSelectionBytes,saveRecording} from './recording.js';
import {MEMBERS,DEFAULT_SHORTCUT,clamp,formatDuration,formatPlaybackTime,formatDate,formatBytes,roomIdFromUrl,normalizeShortcut,formatShortcut,matchesShortcut,isEditing,constrainRect,resizeRect,fileName} from './core.js';

export function createApp({api,get=(_,fallback)=>fallback,set=()=>{},pageUrl=location.href}){
 const host=document.createElement('div');host.id='bella-live-clip-host';const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>${css}</style>${html}`;document.documentElement.append(host);
 const $=id=>root.getElementById(id),video=$('fullVideo');const room=roomIdFromUrl(pageUrl);
 for(const [id,name]of[['close','close'],['refreshLibrary','refresh'],['togglePlayback','play']])$(id).innerHTML=icon(name);
 $('back').innerHTML=icon('back')+'<span>选择直播</span>';
 $('download').innerHTML='<span>导出</span>'+icon('download');
 $('launcher').innerHTML=icon('scissors')+'<span>片段</span>';
 for(const m of MEMBERS){const button=document.createElement('button');button.dataset.member=m.id;const dot=document.createElement('i');dot.style.backgroundColor=m.color;button.append(dot,document.createTextNode(m.name));$('members').append(button);}
 let member=MEMBERS.find(m=>m.room===room)||MEMBERS.find(m=>m.id===get('member','bella'))||MEMBERS[0];
 let page='library',record=null,initialized=false,controller=null,ready=false,libraryScroll=0,playbackTotal=0,estimate=null,recordingController=null,recordingPlan=null,estimateState='loading',clipSelection=null;
 function setTitle(element,text){element.textContent=text;element.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(text));}
 const schedules=new ScheduleService(api.request);let scheduleController=null,exportMode='copy';
 const cache=new Map(),urls=[];let shortcut=normalizeShortcut(get('shortcut',DEFAULT_SHORTCUT))||DEFAULT_SHORTCUT;
 const status=(text,error=false)=>{$('status').textContent=text;$('status').dataset.error=error;updateFeedback();};
 function updateFeedback(){$('feedback').hidden=!controller&&$('status').dataset.error!=='true'&&!$('downloads').childElementCount;}
 const viewport=()=>({width:innerWidth,height:innerHeight});
 const defaults=()=>constrainRect({left:innerWidth-820,top:20,width:800,height:880},viewport());
 let rect=constrainRect(get('windowV2',defaults()),viewport());
 const applyRect=()=>Object.assign($('panel').style,Object.fromEntries(Object.entries(rect).map(([k,v])=>[k,`${v}px`])));applyRect();
 const playback=createPlayback(video,status);
 bindVideoControls(video,playback,status);
 const timeline=createTimeline({track:$('timeline'),startHandle:$('startHandle'),endHandle:$('endHandle'),selectionElement:$('selection'),playhead:$('playhead'),ticks:$('ticks'),labels:$('timelineLabels'),onPreview:t=>{player.seek(t);updateClock(t);},onScrubStart:()=>playback.begin(),onScrubEnd:()=>playback.end(),onSelection:updateExportSummary});
 const updateClock=t=>{$('clock').textContent=`${formatPlaybackTime(t)} / ${formatPlaybackTime(playbackTotal)}`;};
 const player=createPlayer({video,loading:$('videoLoading'),api,status,onTime:t=>{timeline.setCurrent(t);updateClock(t);}});
 const syncPlayback=()=>{const paused=video.paused||video.ended;$('togglePlayback').innerHTML=icon(paused?'play':'pause');$('togglePlayback').setAttribute('aria-label',paused?'播放':'暂停');$('togglePlayback').title=paused?'播放':'暂停';};
 for(const event of ['play','pause','ended','emptied'])video.addEventListener(event,syncPlayback);
 function updateExportSummary(selection=timeline.getSelection()){
  $('selectionDuration').textContent=formatDuration(selection.end-selection.start);
  $('estimatedSize').textContent=estimate ? `约 ${formatBytes(estimateSelectionBytes(estimate,record.start,selection))}${!$('wholeRecording').checked&&exportMode==='precise'?'（原画参考）':''}` : estimateState==='error'?'大小暂不可用':'大小计算中…';
 }
 function startEstimate(plan,signal){
  void (async()=>{try{const groups=await plan.load();const result=await estimateRecordingRate(api,groups,signal);signal.throwIfAborted();estimate=result;updateExportSummary();}catch(e){if(!signal.aborted){estimateState='error';updateExportSummary();}}})();
 }
 const updateControls=createControls(root,timeline);
 function controls(){updateControls({busy:Boolean(controller),ready,page,whole:$('wholeRecording').checked});updateFeedback();}

 function showPage(next){page=next;for(const [id,value]of[['library','library'],['editPage','edit'],['offline','offline']])$(id).hidden=next!==value;$('body').scrollTop=next==='library'?libraryScroll:0;controls();}
 async function job(action){if(controller)return;const own=new AbortController();controller=own;controls();try{await action(own.signal);}catch(e){own.abort();status(e.name==='AbortError'?'已取消。':e.message,e.name!=='AbortError');}finally{controller=null;controls();}}
 function clearDownloads(){urls.forEach(URL.revokeObjectURL);urls.length=0;$('downloads').replaceChildren();}
 function leavePage(){
  scheduleController?.abort();scheduleController=null;$('scheduleNote').hidden=true;
  recordingController?.abort();recordingController=null;recordingPlan=null;
  estimate=null;estimateState='loading';record=null;ready=false;playbackTotal=0;clipSelection=null;
  $('wholeRecording').checked=false;playback.cancel();player.clear();clearDownloads();updateClock(0);
 }
 function renderCards(){
  const focusedKey=root.activeElement?.dataset.recordKey,scroll=$('body').scrollTop;
  root.querySelectorAll('[data-member]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.member===member.id));
  const records=cache.get(member.id)||[];$('cards').replaceChildren();$('libraryEmpty').hidden=records.length>0;$('libraryEmpty').textContent='近 14 天暂无可用回放';
  for(const r of records){
   const card=createRecordCard(r,()=>{libraryScroll=$('body').scrollTop;void enterRecord(r);});card.dataset.recordKey=r.key;$('cards').append(card);
   if(r.key===focusedKey)card.focus({preventScroll:true});
  }
  $('body').scrollTop=scroll;controls();
 }
 function enrichCards(refresh){
  if($('panel').hidden)return;
  scheduleController?.abort();const own=new AbortController();scheduleController=own;
  const selected=member.id,records=cache.get(selected)||[];
  $('scheduleNote').textContent='正在补充直播日程…';$('scheduleNote').hidden=!records.length;
  void (async()=>{
   try{
    const result=await schedules.enrich(records,{signal:own.signal,refresh});
    if(own.signal.aborted||member.id!==selected||page!=='library')return;
    cache.set(selected,result.records);renderCards();
    $('scheduleNote').hidden=!result.failed;$('scheduleNote').textContent=result.failed?'部分日程暂不可用，可刷新重试。':'';
   }catch(e){if(!own.signal.aborted){$('scheduleNote').hidden=false;$('scheduleNote').textContent='日程暂不可用，可刷新重试。';}}
  })();
 }
 async function library(refresh=false){
  leavePage();showPage('library');renderCards();
  if(!refresh&&cache.has(member.id)){status('选择想剪辑的那场直播。');enrichCards(false);return;}
  await job(async signal=>{status('正在获取直播场次…');cache.set(member.id,await api.history(member,signal));renderCards();status('选择想剪辑的那场直播。');enrichCards(refresh);});
 }
 function renderRecordMeta(){$('recordMeta').textContent=[record.member,formatDate(record.start),record.schedule?.type].filter(Boolean).join(' · ');}
 function enrichRecordType(){
  if(record.schedule||$('panel').hidden)return;
  scheduleController?.abort();const own=new AbortController();scheduleController=own;const selected=record;
  void schedules.enrich([selected],{signal:own.signal}).then(result=>{
   if(own.signal.aborted||record!==selected||page!=='edit')return;
   record=result.records[0];renderRecordMeta();
  }).catch(()=>{});
 }
 async function loadRecord(next,signal){
  record=next;showPage('edit');setTitle($('recordTitle'),record.title);renderRecordMeta();enrichRecordType();
  status('正在载入整场录像…');const {total,streams}=await player.load(record,signal);
  playbackTotal=total;updateClock(0);
  recordingController=new AbortController();recordingPlan=new RecordingPlan(api,streams,recordingController.signal);
  timeline.reset(total);ready=true;startEstimate(recordingPlan,recordingController.signal);
  if(record.live)player.seek(Math.max(streams[0].start_time-record.start,streams.at(-1).end_time-record.start-15));
  status('按住时间轴预览；松开选区边界后自动适配视野。');
 }
 async function enterRecord(next){await job(signal=>{leavePage();return loadRecord(next,signal);});}
 async function currentRoom(){await job(async signal=>{leavePage();showPage('offline');$('offlineReason').textContent='正在获取当前直播间…';try{const source=MEMBERS.find(m=>m.room===room)||{room,name:'当前直播间'};const next=await api.current(source,signal);await loadRecord(next,signal);}catch(e){if(e.name==='AbortError')throw e;showPage('offline');$('offlineReason').textContent=e.message;status('可重新检查直播，或浏览历史场次。');}});}
 async function download(){await job(async signal=>{const selection=timeline.getSelection();player.pause();clearDownloads();status('正在下载选中的录像…');const outputs=await exportSelection(api,record,await recordingPlan.load(signal),selection,{signal,precise:exportMode==='precise',onProgress:p=>{$('progress').value=p.phase==='download'?p.done/p.count*75:75+p.progress*25;status(p.phase==='download'?`下载分片 ${p.done}/${p.count} · ${formatBytes(p.bytes)}`:'正在生成 MP4…');}});
  for(const [i,output]of outputs.entries()){const a=document.createElement('a');a.href=URL.createObjectURL(output.blob);urls.push(a.href);a.download=fileName(record,output.start,output.end,outputs.length>1?`_第${i+1}段`:'');a.textContent=`保存${outputs.length>1?'第 '+(i+1)+' 段':''} MP4 · ${formatBytes(output.blob.size)}`;$('downloads').append(a);}
  if(outputs.length===1)$('downloads').firstElementChild.click();status(outputs.length===1?'MP4 已生成，可点击下方链接再次保存。':`选区跨越录像中断，已生成 ${outputs.length} 个文件，请分别保存。`);
 });}
 async function downloadFull(){
  // Keep the picker inside the click activation, before playlist/network work.
  if(controller||!ready)return;
  if(typeof window.showSaveFilePicker!=='function'){status('当前浏览器未开放文件保存接口，请在 Chrome 的 HTTPS 页面使用整场下载。',true);return;}
  await job(async signal=>{
   const handle=await window.showSaveFilePicker({suggestedName:fileName(record,0,playbackTotal,'_整场'),types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
   signal.throwIfAborted();player.pause();clearDownloads();status('正在下载整场并写入文件…');
   const result=await saveRecording(api,await recordingPlan.load(signal),handle,{signal,onProgress:p=>{if(p.progress!==undefined)$('progress').value=p.progress*100;status(`整场下载 · 已接收 ${formatBytes(p.bytes)} · 已写入 ${formatBytes(p.written)}`);}});
   status('整场下载完成。');
   const message=document.createElement('p');message.textContent=`整场已保存到所选位置 · ${formatBytes(result.bytes)}`;$('downloads').append(message);
  });
 }
 async function open(){$('panel').hidden=false;if(!initialized){initialized=true;await(room?currentRoom():library());}else if(page==='library')enrichCards(false);else if(page==='edit')enrichRecordType();}
 const close=()=>{$('panel').hidden=true;scheduleController?.abort();playback.cancel();};
 $('close').onclick=close;
 $('launcher').onclick=()=>{if(!launcherMoved)$('panel').hidden?void open():close();};
 $('back').onclick=()=>void library();$('browseHistory').onclick=()=>void library();$('retryCurrent').onclick=currentRoom;$('refreshLibrary').onclick=()=>void library(true);$('refreshEditor').onclick=()=>record.live?currentRoom():enterRecord(record);
 root.querySelectorAll('[data-member]').forEach(el=>el.onclick=()=>{member=MEMBERS.find(m=>m.id===el.dataset.member);set('member',member.id);libraryScroll=0;void library();});
 $('cancel').onclick=()=>controller?.abort();$('download').onclick=()=> $('wholeRecording').checked?downloadFull():download();
 $('wholeRecording').onchange=()=>{
  if($('wholeRecording').checked){clipSelection=timeline.getSelection();timeline.setSelection({start:0,end:playbackTotal},true);}
  else{timeline.setSelection(clipSelection,true);clipSelection=null;}
  controls();
 };
 root.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{exportMode=button.dataset.mode;root.querySelectorAll('[data-mode]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.mode===exportMode));updateExportSummary();});
 $('markStart').onclick=()=>{const s=timeline.getSelection(),t=player.position();try{timeline.setSelection({start:t,end:Math.max(s.end,t+.001)},true);}catch(e){status(e.message,true);}};
 $('markEnd').onclick=()=>{const s=timeline.getSelection(),t=player.position();try{timeline.setSelection({start:Math.min(s.start,t-.001),end:t},true);}catch(e){status(e.message,true);}};
 $('togglePlayback').onclick=()=>playback.toggle();
  $('shortcut').value=formatShortcut(shortcut);
  $('shortcut').onfocus=()=>{$('shortcut').classList.add('recording');$('shortcut').value='按下快捷键';};
  $('shortcut').onblur=()=>{$('shortcut').classList.remove('recording');$('shortcut').value=formatShortcut(shortcut);};
  $('shortcut').onkeydown=e=>{e.preventDefault();e.stopPropagation();if(e.key==='Escape')return $('shortcut').blur();const value=normalizeShortcut(e);if(value){shortcut=value;set('shortcut',value);$('shortcut').blur();}};
  document.addEventListener('keydown', e => { if (!isEditing(e) && matchesShortcut(e,shortcut)) { e.preventDefault(); $('panel').hidden ? void open() : close(); } });
  const resetWindow = () => { rect=defaults(); applyRect(); set('windowV2',rect); $('launcher').style.cssText=''; set('launcher',null); };
  function drag(element,onMove,onEnd) {
    element.addEventListener('pointerdown',e=>{
      if(e.button!==0 || e.target.closest('button,input,select') && element!==$('launcher')) return;
      const x=e.clientX,y=e.clientY, initial={...rect}; element.setPointerCapture(e.pointerId); e.preventDefault();
      const move=ev=>onMove(ev.clientX-x,ev.clientY-y,initial);
      const finish=()=>{ element.removeEventListener('pointermove',move); element.removeEventListener('pointerup',finish); element.removeEventListener('pointercancel',finish); onEnd?.(); };
      element.addEventListener('pointermove',move); element.addEventListener('pointerup',finish); element.addEventListener('pointercancel',finish);
    });
  }
  drag($('header'),(dx,dy,r)=>{rect=constrainRect({...r,left:r.left+dx,top:r.top+dy},viewport()); applyRect();},()=>set('windowV2',rect));
  root.querySelectorAll('[data-edge]').forEach(el=>drag(el,(dx,dy,r)=>{rect=resizeRect(r,el.dataset.edge,dx,dy,viewport()); applyRect();},()=>set('windowV2',rect)));
  let launcherMoved=false, launcherStart;
  const savedLauncher=get('launcher',null);
  function moveLauncher(left,top) { Object.assign($('launcher').style,{left:`${clamp(left,0,innerWidth-58)}px`,top:`${clamp(top,0,innerHeight-62)}px`,right:'auto',bottom:'auto'}); }
  if(savedLauncher) moveLauncher(savedLauncher.left,savedLauncher.top);
  $('launcher').addEventListener('pointerdown',()=>{launcherMoved=false; launcherStart=$('launcher').getBoundingClientRect();});
  drag($('launcher'),(dx,dy)=>{if(Math.abs(dx)+Math.abs(dy)>4) launcherMoved=true; if(launcherMoved) moveLauncher(launcherStart.left+dx,launcherStart.top+dy);},()=>{if(launcherMoved){const b=$('launcher').getBoundingClientRect();set('launcher',{left:b.left,top:b.top});}});
  window.addEventListener('resize',()=>{rect=constrainRect(rect,viewport());applyRect();const b=$('launcher').getBoundingClientRect();if(b.right>innerWidth||b.bottom>innerHeight)moveLauncher(b.left,b.top);});
 window.addEventListener('pagehide',()=>{controller?.abort();leavePage();});controls();return {open,resetWindow,root};
}
