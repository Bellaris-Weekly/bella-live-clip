import metadataText from '../header.txt';
import {readScriptMetadata,createUpdateChecker} from '../services/updates.js';
import {createVersionControl} from '../ui/version.js';
import html from '../ui/template.html';
import css from '../ui/styles.css';
import {createControls} from '../ui/controls.js';
import {createRecordCard} from '../ui/record-card.js';
import {icon} from '../ui/icons.js';
import {createTimeline} from '../ui/timeline.js';
import {DEFAULT_SHORTCUT,normalizeShortcut,formatShortcut,matchesShortcut,isEditing} from '../ui/shortcuts.js';
import {constrainRect,resizeRect} from '../ui/panel-geometry.js';
import {ScheduleService} from '../services/schedule.js';
import {createLibraryLoader} from './library-loader.js';
import {createSubmissionService} from '../services/submission.js';
import {parseSubmissionUrl} from '../domain/submission.js';
import {createSubmissionPlayer} from '../media/submission-player.js';
import {exportSubmission} from '../media/submission-export.js';
import {RecordingPlan} from '../media/recording-plan.js';
import {createPlayer} from '../media/preview-player.js';
import {createPlayback,bindVideoControls} from '../media/playback.js';
import {createThumbnails} from '../media/thumbnails.js';
import {exportSelection} from '../media/export.js';
import {estimateRecordingRate,estimateSelectionBytes,saveRecording} from '../media/recording.js';
import {fileName} from '../media/file-name.js';
import {MEMBERS,roomIdFromUrl} from '../domain/records.js';
import {clamp} from '../shared/math.js';
import {formatDuration,formatTimeRange,formatDate,formatBytes} from '../shared/format.js';

export function createApp({api,get=(_,fallback)=>fallback,set=()=>{},pageUrl=()=>location.href,saveFilePicker=typeof window.showSaveFilePicker==='function'?window.showSaveFilePicker.bind(window):null}){
 const host=document.createElement('div');host.id='bella-live-clip-host';const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>${css}</style>${html}`;document.documentElement.append(host);
 const $=id=>root.getElementById(id),video=$('fullVideo');
 const readPageUrl=typeof pageUrl==='function'?pageUrl:()=>pageUrl;
 const room=roomIdFromUrl(readPageUrl()),submissions=createSubmissionService(api.request);
 let player=null,playerKind=null,loadedRoute=null,observedRoute=parseSubmissionUrl(readPageUrl())?.key,jobKind=null,pendingRoute=false;
 const isSubmission=()=>record?.kind==='submission';
 const metadata=readScriptMetadata(metadataText);
 const versionControl=createVersionControl({root,metadata,check:createUpdateChecker({request:api.request,metadata,get,set})});
 for(const [id,name]of[['close','close'],['refreshLibrary','refresh'],['togglePlayback','play']])$(id).innerHTML=icon(name);
 $('back').innerHTML=icon('back')+'<span>选择直播</span>';
 $('download').innerHTML='<span>导出</span>'+icon('download');
 $('launcher').innerHTML=icon('scissors')+'<span>片段</span>';
 for(const m of MEMBERS){const button=document.createElement('button');button.dataset.member=m.id;const dot=document.createElement('i');dot.style.backgroundColor=m.color;button.append(dot,document.createTextNode(m.name));$('members').append(button);}
 let member=MEMBERS.find(m=>m.room===room)||MEMBERS.find(m=>m.id===get('member','bella'))||MEMBERS[0];
 let page='library',record=null,initialized=false,controller=null,ready=false,libraryScroll=0,playbackTotal=0,estimate=null,recordingController=null,recordingPlan=null,estimateState='loading',clipSelection=null;
 function setTitle(element,text){element.textContent=text;element.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(text));}
 const schedules=new ScheduleService(api.request);const libraries=createLibraryLoader({api,schedules});let scheduleController=null,exportMode='copy';
 const urls=[];let shortcut=normalizeShortcut(get('shortcut',DEFAULT_SHORTCUT))||DEFAULT_SHORTCUT;
 let fullStopController=null,fullFinishing=false;
 const status=(text,error=false)=>{$('status').textContent=text;$('status').dataset.error=error;updateFeedback();};
 function updateFeedback(){$('feedback').hidden=!controller&&$('status').dataset.error!=='true'&&!$('downloads').childElementCount;}
 const viewport=()=>({width:innerWidth,height:innerHeight});
 const defaults=()=>constrainRect({left:innerWidth-820,top:20,width:800,height:880},viewport());
 let rect=constrainRect(get('windowV2',defaults()),viewport());
 const applyRect=()=>Object.assign($('panel').style,Object.fromEntries(Object.entries(rect).map(([k,v])=>[k,`${v}px`])));applyRect();
 const playback=createPlayback(video,status,{getRange:()=>ready?timeline.getSelection():null,position:()=>player?.position()??0,seek:t=>{player?.seek(t);timeline.setCurrent(t);updateClock(t);}});
 bindVideoControls(video,playback,status);
 const thumbnails=createThumbnails({container:$('thumbnails'),request:api.request});
 const timeline=createTimeline({track:$('timeline'),startHandle:$('startHandle'),endHandle:$('endHandle'),selectionElement:$('selection'),playhead:$('playhead'),ticks:$('ticks'),labels:$('timelineLabels'),onPreview:t=>{player?.seek(t);updateClock(t);},onScrubStart:()=>playback.begin(),onScrubEnd:()=>playback.end(),onSelection:selection=>{updateExportSummary(selection);playback.check();},onView:(view,motion)=>{$('timelineZoom').textContent=$('timeline').dataset.zoom;thumbnails.update(view,motion);}});
 const updateClock=t=>{$('clock').textContent=formatTimeRange(t,playbackTotal,' / ');};
 function usePlayer(kind){
  if(playerKind===kind)return;
  player?.destroy();playerKind=kind;
  const options={video,loading:$('videoLoading'),api,request:api.request,status,onTime:t=>{timeline.setCurrent(t);updateClock(t);}};
  player=kind==='submission'?createSubmissionPlayer(options):createPlayer(options);
 }
 const syncPlayback=()=>{const paused=video.paused||video.ended;$('togglePlayback').innerHTML=icon(paused?'play':'pause');$('togglePlayback').setAttribute('aria-label',paused?'播放':'暂停');$('togglePlayback').title=paused?'播放':'暂停';};
 for(const event of ['play','pause','ended','emptied'])video.addEventListener(event,syncPlayback);
 function updateExportSummary(selection=timeline.getSelection()){
  $('selectionDuration').textContent=formatDuration(selection.end-selection.start);
  if(isSubmission()){const rate=record.media.video.bandwidth+(record.media.audio?.bandwidth||0);$('estimatedSize').textContent=rate?`约 ${formatBytes(rate*(selection.end-selection.start)/8)}`:'大小暂不可用';return;}
  $('estimatedSize').textContent=estimate ? `约 ${formatBytes(estimateSelectionBytes(estimate,record.start,selection))}` : estimateState==='error'?'大小暂不可用':'大小计算中…';
 }
 function startEstimate(plan,signal){
  void (async()=>{try{const groups=await plan.load();const result=await estimateRecordingRate(api,groups,signal);signal.throwIfAborted();estimate=result;updateExportSummary();}catch(e){if(!signal.aborted){estimateState='error';updateExportSummary();}}})();
 }
 const updateControls=createControls(root,timeline);
 function controls(){
  const route=parseSubmissionUrl(readPageUrl());
  $('currentVideo').hidden=!route||page==='edit'&&loadedRoute===route.key;
  $('wholeRecordingLabel').hidden=isSubmission();
  $('refreshEditor').textContent=isSubmission()?'重新加载视频':'刷新录像';
  updateControls({busy:Boolean(controller),ready,page,whole:$('wholeRecording').checked,submission:isSubmission(),stopping:fullFinishing||Boolean(fullStopController?.signal.aborted)});updateFeedback();}

 function showPage(next){page=next;for(const [id,value]of[['library','library'],['editPage','edit'],['offline','offline']])$(id).hidden=next!==value;$('body').scrollTop=next==='library'?libraryScroll:0;controls();}
 async function job(action,kind='load'){if(controller)return;const own=new AbortController();controller=own;jobKind=kind;controls();try{await action(own.signal);}catch(e){own.abort();status(e.name==='AbortError'?'已停止。':e.message,e.name!=='AbortError');}finally{controller=null;jobKind=null;fullStopController=null;fullFinishing=false;controls();if(pendingRoute){pendingRoute=false;if(!$('panel').hidden)void currentVideo(false);}}}
 function clearDownloads(){urls.forEach(URL.revokeObjectURL);urls.length=0;$('downloads').replaceChildren();}
 function leavePage(){
  scheduleController?.abort();scheduleController=null;$('scheduleNote').hidden=true;
  recordingController?.abort();recordingController=null;recordingPlan=null;
  estimate=null;estimateState='loading';record=null;ready=false;playbackTotal=0;clipSelection=null;
  $('wholeRecording').checked=false;timeline.stop();playback.cancel();player?.clear();thumbnails.clear();clearDownloads();updateClock(0);
 }
 function renderCards(){
  const focusedKey=root.activeElement?.dataset.recordKey,scroll=$('body').scrollTop;
  root.querySelectorAll('[data-member]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.member===member.id));
  const records=libraries.get(member)?.records||[];$('cards').replaceChildren();$('libraryEmpty').hidden=records.length>0;$('libraryEmpty').textContent='近 14 天暂无可用回放';
  for(const r of records){
   const card=createRecordCard(r,()=>{libraryScroll=$('body').scrollTop;void enterRecord(r);});card.dataset.recordKey=r.key;$('cards').append(card);
   if(r.key===focusedKey)card.focus({preventScroll:true});
  }
  $('body').scrollTop=scroll;controls();
 }
 function showScheduleResult(result){
  $('scheduleNote').hidden=!result.failed&&!result.liveFailed;
  $('scheduleNote').textContent=[result.liveFailed?'当前直播状态暂不可用，可刷新重试。':'',result.failed?'部分日程暂不可用，可刷新重试。':''].filter(Boolean).join(' ');
 }
 async function library(refresh=false){
  leavePage();showPage('library');renderCards();
  const selected=member;
  await job(async signal=>{status(refresh?'正在刷新直播场次…':'正在获取直播场次…');const result=await libraries.load(selected,{refresh,signal});
   if(signal.aborted||member!==selected)return;
   renderCards();showScheduleResult(result);status('选择想剪辑的那场直播。');
  });
 }
 function renderRecordMeta(){$('recordMeta').textContent=(isSubmission()?[record.uploader,record.partTitle?`P${record.part} · ${record.partTitle}`:'',record.qualityLabel]:[record.member,formatDate(record.start),record.schedule?.type]).filter(Boolean).join(' · ');}
 function enrichRecordType(){
  if(!record||isSubmission()||record.schedule!==undefined||$('panel').hidden)return;
  scheduleController?.abort();const own=new AbortController();scheduleController=own;const selected=record;
  void schedules.enrich([selected],{signal:own.signal}).then(result=>{
   if(own.signal.aborted||record!==selected||page!=='edit')return;
   record=result.records[0];renderRecordMeta();
  }).catch(()=>{});
 }
 async function loadRecord(next,signal){
  usePlayer('live');record=next;loadedRoute=null;showPage('edit');setTitle($('recordTitle'),record.title);renderRecordMeta();enrichRecordType();
  status('正在载入整场录像…');const {total,streams}=await player.load(record,signal);
  playbackTotal=total;updateClock(0);
  recordingController=new AbortController();recordingPlan=new RecordingPlan(api,streams,recordingController.signal);
  thumbnails.load(record,streams);timeline.reset(total);ready=true;startEstimate(recordingPlan,recordingController.signal);$('editPage').focus({preventScroll:true});
  if(record.live)player.seek(Math.max(streams[0].start_time-record.start,streams.at(-1).end_time-record.start-15));
  status('按住时间轴预览；松开选区边界后自动适配视野。');
 }
 async function enterRecord(next){await job(signal=>{leavePage();return loadRecord(next,signal);});}
 async function currentRoom(){await job(async signal=>{leavePage();$('offlineTitle').textContent='暂时无法打开本场直播';showPage('offline');$('offlineReason').textContent='正在获取当前直播间…';try{const source=MEMBERS.find(m=>m.room===room)||{room,name:'当前直播间'};const next=await api.current(source,signal);await loadRecord(next,signal);}catch(e){if(e.name==='AbortError')throw e;showPage('offline');$('offlineReason').textContent=e.message;status('可重新检查直播，或浏览历史场次。');}});}
 async function currentVideo(capturePosition=true){
  const url=readPageUrl(),route=parseSubmissionUrl(url);if(!route||controller)return;
  const pageVideo=document.querySelector('video');
  const position=capturePosition&&pageVideo?Number(pageVideo.currentTime)||0:0;
  pageVideo?.pause();
  await job(async signal=>{
   leavePage();loadedRoute=null;$('offlineTitle').textContent='暂时无法打开当前视频';showPage('offline');$('offlineReason').textContent='正在读取当前视频…';
   try{
    const next=await submissions.load(url,{signal});signal.throwIfAborted();
    usePlayer('submission');record=next;showPage('edit');setTitle($('recordTitle'),record.title);renderRecordMeta();
    const {total}=await player.load(record,signal);signal.throwIfAborted();loadedRoute=route.key;
    playbackTotal=total;thumbnails.load(record,[]);timeline.reset(total);ready=true;updateClock(0);
    if(position>0)player.seek(Math.min(position,Math.max(0,total-.001)));
    $('editPage').focus({preventScroll:true});status('设置开始和结束位置后，即可导出当前视频片段。');
   }catch(error){if(signal.aborted)throw error;ready=false;player?.clear();showPage('offline');$('offlineReason').textContent=error.message;status(error.message,true);}
  });
 }
 function checkCurrentVideo(){
  const route=parseSubmissionUrl(readPageUrl()),key=route?.key;
  if(key===observedRoute)return;observedRoute=key;controls();
  if(!route||$('panel').hidden)return;
  if(controller){if(jobKind==='load'){pendingRoute=true;controller.abort();}return;}
  void currentVideo(false);
 }
 async function download(){await job(async signal=>{const selection=timeline.getSelection();player.pause();clearDownloads();status('正在读取选中的片段…');const onProgress=p=>{$('progress').value=p.progress*100;status(`${p.reconnecting?`网络波动，自动重连中（第 ${p.attempt} 次） · `:''}${p.message?p.message+' · ':''}${isSubmission()?'':`已下载 ${p.downloaded}/${p.count} 片 · `}处理 ${Math.round((p.processing??p.progress)*100)}% · ${formatBytes(p.bytes)}`);};
  const outputs=isSubmission()?[{blob:await exportSubmission(api.request,record,selection,{signal,precise:true,onProgress}),...selection}]:await exportSelection(api,record,await recordingPlan.load(signal),selection,{signal,precise:exportMode==='precise',onProgress});
  for(const [i,output]of outputs.entries()){const a=document.createElement('a');a.href=URL.createObjectURL(output.blob);urls.push(a.href);a.download=fileName(record,output.start,output.end,outputs.length>1?`_第${i+1}段`:'');a.textContent=`保存${outputs.length>1?'第 '+(i+1)+' 段':''} MP4 · ${formatBytes(output.blob.size)}`;$('downloads').append(a);}
  if(outputs.length===1)$('downloads').firstElementChild.click();status(outputs.length===1?'MP4 已生成，可点击下方链接再次保存。':`选区跨越录像中断，已生成 ${outputs.length} 个文件，请分别保存。`);
 },'export');}
 async function downloadFull(){
  // Keep the picker inside the click activation, before playlist/network work.
  if(controller||!ready)return;
  if(!saveFilePicker){status('当前浏览器未开放文件保存接口，请在 Chrome 的 HTTPS 页面使用整场下载。',true);return;}
  await job(async signal=>{
   const handle=await saveFilePicker({suggestedName:fileName(record,0,playbackTotal,'_整场'),types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
   signal.throwIfAborted();player.pause();clearDownloads();status('正在下载整场并写入文件…');
   const groups=await recordingPlan.load(signal);signal.throwIfAborted();
   fullStopController=new AbortController();controls();
   const result=await saveRecording(api,groups,handle,{signal,stopSignal:fullStopController.signal,onProgress:p=>{
    if(p.progress!==undefined)$('progress').value=p.progress*100;
    if(p.phase==='stopping'||p.phase==='finalizing'){fullFinishing=true;controls();status('正在保存…');}
    else if(p.phase!=='saved')status(`${p.reconnecting?`网络波动，自动重连中（第 ${p.attempt} 次）`:'整场下载'} · ${formatBytes(p.speed)}/秒 · 已接收 ${formatBytes(p.bytes)} · 已写入 ${formatBytes(p.written)}`);
   }});
   if(!result.saved){status('已停止。');return;}
   status(result.stopped?'已停止。':'整场下载完成。');
   const message=document.createElement('p');message.textContent=`${result.stopped?'已完成部分':'整场'}已保存到所选位置 · ${formatDuration(result.duration)} · ${formatBytes(result.bytes)}`;$('downloads').append(message);
  },'export');
 }
 async function open(){$('panel').hidden=false;void versionControl.refresh();const route=parseSubmissionUrl(readPageUrl());observedRoute=route?.key;if(route&&(!initialized||loadedRoute!==route.key)){initialized=true;await currentVideo();return;}if(!initialized){initialized=true;await(room?currentRoom():library());}else if(page==='library'){
   renderCards();const selected=member;void libraries.load(selected).then(result=>{
    if(member!==selected||page!=='library'||$('panel').hidden)return;
    renderCards();showScheduleResult(result);
   }).catch(()=>{});
  }else if(page==='edit')enrichRecordType();}
 const close=()=>{timeline.stop();$('panel').hidden=true;scheduleController?.abort();playback.cancel();};
 $('close').onclick=close;
 $('launcher').onclick=()=>{if(!launcherMoved)$('panel').hidden?void open():close();};
 $('currentVideo').onclick=()=>void currentVideo();$('back').onclick=()=>void library();$('browseHistory').onclick=()=>void library();$('retryCurrent').onclick=()=>parseSubmissionUrl(readPageUrl())?currentVideo():currentRoom();$('refreshLibrary').onclick=()=>void library(true);$('refreshEditor').onclick=()=>isSubmission()?currentVideo(false):record.live?currentRoom():enterRecord(record);
 root.querySelectorAll('[data-member]').forEach(el=>el.onclick=()=>{member=MEMBERS.find(m=>m.id===el.dataset.member);set('member',member.id);libraryScroll=0;void library();});
 $('cancel').onclick=()=>{if(fullStopController){fullStopController.abort();controls();status('正在保存…');}else controller?.abort();};$('download').onclick=()=> $('wholeRecording').checked?downloadFull():download();
 $('wholeRecording').onchange=()=>{
  if($('wholeRecording').checked){clipSelection=timeline.getSelection();timeline.setSelection({start:0,end:playbackTotal},true);}
  else{timeline.setSelection(clipSelection,true);clipSelection=null;}
  controls();
 };
 root.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{exportMode=button.dataset.mode;root.querySelectorAll('[data-mode]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.mode===exportMode));updateExportSummary();});
 $('markStart').onclick=()=>{const s=timeline.getSelection(),t=player.position();try{timeline.setSelection({start:t,end:Math.max(s.end,t+.001)},true);$('startHandle').focus({preventScroll:true});}catch(e){status(e.message,true);}};
 $('markEnd').onclick=()=>{const s=timeline.getSelection(),t=player.position();try{timeline.setSelection({start:Math.min(s.start,t-.001),end:t},true);$('endHandle').focus({preventScroll:true});}catch(e){status(e.message,true);}};
 $('editPage').addEventListener('keydown',e=>{if(ready&&!controller&&!$('panel').hidden)timeline.handleKeyDown(e);},{capture:true});
 $('togglePlayback').onclick=()=>playback.toggle();
  $('shortcut').value=formatShortcut(shortcut);
  $('shortcut').onfocus=()=>{$('shortcut').classList.add('recording');$('shortcut').value='按下快捷键';};
  $('shortcut').onblur=()=>{$('shortcut').classList.remove('recording');$('shortcut').value=formatShortcut(shortcut);};
  $('shortcut').onkeydown=e=>{e.preventDefault();e.stopPropagation();if(e.key==='Escape')return $('shortcut').blur();const value=normalizeShortcut(e);if(value){shortcut=value;set('shortcut',value);$('shortcut').blur();}};
  document.addEventListener('keydown', e => { if (!isEditing(e) && matchesShortcut(e,shortcut)) { e.preventDefault(); $('panel').hidden ? void open() : close(); } });
  function drag(element,onMove,onEnd) {
    element.addEventListener('pointerdown',e=>{
      if(e.button!==0 || e.target.closest('button,input,select,a') && element!==$('launcher')) return;
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
 const navigationTimer=setInterval(checkCurrentVideo,500);
 window.addEventListener('popstate',checkCurrentVideo);
 window.addEventListener('pagehide',()=>{clearInterval(navigationTimer);window.removeEventListener('popstate',checkCurrentVideo);controller?.abort();libraries.abortAll();leavePage();player?.destroy();});
  controls();if(!room&&!parseSubmissionUrl(readPageUrl()))void libraries.preload(member);return {open,root};
}
