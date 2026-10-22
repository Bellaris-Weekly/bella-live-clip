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
import {createDiagnosticReporter} from '../services/diagnostics.js';
import {createLibraryLoader} from './library-loader.js';
import {createSubmissionService} from '../services/submission.js';
import {createSubmissionStoryboard} from '../services/submission-storyboard.js';
import {bindPageProgress} from '../ui/page-progress.js';
import {parseSubmissionUrl} from '../domain/submission.js';
import {createSubmissionPlayer} from '../media/submission-player.js';
import {exportSubmission} from '../media/submission-export.js';
import {RecordingPlan} from '../media/recording-plan.js';
import {createPlayer} from '../media/preview-player.js';
import {createPlayback,bindVideoControls} from '../media/playback.js';
import {createThumbnails} from '../media/thumbnails.js';
import {exportSelection} from '../media/export.js';
import {createClipFile} from '../media/file-output.js';
import {createTemporaryMedia} from '../media/temporary-media.js';
import {estimateRecordingRate,estimateSelectionBytes,saveRecording} from '../media/recording.js';
import {renderExportProgress} from '../ui/export-progress.js';
import {fileName} from '../media/file-name.js';
import {MEMBERS,roomIdFromUrl} from '../domain/records.js';
import {clamp} from '../shared/math.js';
import {formatDuration,formatTimeRange,formatDate,formatBytes} from '../shared/format.js';

export function createApp({api,diagnostics=createDiagnosticReporter(),submissionRequest=api.request,get=(_,fallback)=>fallback,set=()=>{},pageUrl=()=>location.href,saveFilePicker=typeof window.showSaveFilePicker==='function'?window.showSaveFilePicker.bind(window):null,directoryPicker=typeof window.showDirectoryPicker==='function'?window.showDirectoryPicker.bind(window):null,storage=globalThis.navigator?.storage}){
 const host=document.createElement('div');host.id='bella-live-clip-host';const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>${css}</style>${html}`;document.documentElement.append(host);
 const $=id=>root.getElementById(id),video=$('fullVideo');
 const readPageUrl=typeof pageUrl==='function'?pageUrl:()=>pageUrl;
 const room=roomIdFromUrl(readPageUrl()),submissions=createSubmissionService(submissionRequest);
 let player=null,playerKind=null,loadedRoute=null,observedRoute=parseSubmissionUrl(readPageUrl())?.key,jobKind=null,pendingRoute=false,submissionThumbnails=false;
 const isSubmission=()=>record?.kind==='submission';
 const metadata=readScriptMetadata(metadataText);
 const versionControl=createVersionControl({root,metadata,check:createUpdateChecker({request:api.request,metadata})});
 for(const [id,name]of[['close','close'],['refreshLibrary','refresh'],['togglePlayback','play']])$(id).innerHTML=icon(name);
 $('back').innerHTML=icon('back')+'<span>选择直播</span>';
 $('download').innerHTML='<span>导出</span>'+icon('download');
 $('launcher').innerHTML=icon('scissors')+'<span>片段</span>';
 for(const m of MEMBERS){const button=document.createElement('button');button.dataset.member=m.id;const dot=document.createElement('i');dot.style.backgroundColor=m.color;button.append(dot,document.createTextNode(m.name));$('members').append(button);}
 let member=MEMBERS.find(m=>m.room===room)||MEMBERS.find(m=>m.id===get('member','bella'))||MEMBERS[0];
 let page='library',record=null,initialized=false,controller=null,ready=false,libraryScroll=0,playbackTotal=0,estimate=null,recordingController=null,recordingPlan=null,estimateState='loading',clipSelection=null,previewDiagnostic=null;
 // Each stream is one recorded segment (a new one starts after a disconnect); the editor works on one at a time.
 let recordStreams=[],segments=[],segmentIndex=0;
 function setTitle(element,text){element.textContent=text;element.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(text));}
 const schedules=new ScheduleService(api.request);const libraries=createLibraryLoader({api,schedules});let scheduleController=null,exportMode='copy';
 let shortcut=normalizeShortcut(get('shortcut',DEFAULT_SHORTCUT))||DEFAULT_SHORTCUT;
 let fullStopController=null,fullFinishing=false;
 const status=(text,error=false)=>{$('status').textContent=text;$('status').dataset.error=error;updateFeedback();};
 function updateFeedback(){$('feedback').hidden=!controller&&$('status').dataset.error!=='true'&&!$('downloads').childElementCount;}
 const viewport=()=>({width:innerWidth,height:innerHeight});
 const defaults=()=>constrainRect({left:innerWidth-820,top:20,width:800,height:880},viewport());
 let rect=constrainRect(get('windowV2',defaults()),viewport());
 const applyRect=()=>Object.assign($('panel').style,Object.fromEntries(Object.entries(rect).map(([k,v])=>[k,`${v}px`])));applyRect();
 const seekTo=t=>{player?.seek(t);timeline.setCurrent(t);updateClock(t);};
 const playback=createPlayback(video,status,{getRange:()=>ready?timeline.getSelection():null,position:()=>player?.position()??0,seek:seekTo});
 const activePlayback=()=>playerKind==='submission'?player:playback;
 bindVideoControls(video,playback,status);
 const thumbnails=createThumbnails({container:$('thumbnails'),request:api.request});
 const timeline=createTimeline({track:$('timeline'),startHandle:$('startHandle'),endHandle:$('endHandle'),selectionElement:$('selection'),playhead:$('playhead'),ticks:$('ticks'),labels:$('timelineLabels'),onPreview:t=>{player?.seek(t);updateClock(t);},onScrubStart:()=>{activePlayback()?.begin();if(isSubmission()){submissionThumbnails=true;thumbnails.update(timeline.getView());}},onScrubEnd:(_,{canceled=false}={})=>activePlayback()?.end({commit:!canceled}),onSelection:selection=>{updateExportSummary(selection);activePlayback()?.check();},onView:(view,motion)=>{$('timelineZoom').textContent=$('timeline').dataset.zoom;if(!isSubmission()||submissionThumbnails)thumbnails.update(view,motion);}});
 const updateClock=t=>{$('clock').textContent=formatTimeRange(t,playbackTotal,' / ');};
 function usePlayer(kind){
  if(playerKind===kind)return;
  player?.destroy();playerKind=kind;
  const options={video,loading:$('videoLoading'),api,request:api.request,status,onError:error=>previewDiagnostic?.fail(error,recordingController?.signal),onTime:t=>{timeline.setCurrent(t);updateClock(t);}};
  video.hidden=kind==='submission';$('pageMirror').hidden=kind!=='submission';
  player=kind==='submission'?createSubmissionPlayer({...options,canvas:$('pageMirror'),
   getVideo:()=>document.querySelector('.bpx-player-container video, .bilibili-player-video video')??document.querySelector('video'),
   isCurrent:()=>parseSubmissionUrl(readPageUrl())?.key===loadedRoute,getRange:()=>timeline.getSelection(),onState:()=>syncPlayback(),
   createPreview:submission=>createSubmissionStoryboard({metadataRequest:submissionRequest,mediaRequest:api.request,submission})}):createPlayer(options);
 }
 let lastPlaybackPaused;
 const syncPlayback=()=>{const paused=playerKind==='submission'?player.isPaused():video.paused||video.ended;if(paused===lastPlaybackPaused)return;lastPlaybackPaused=paused;$('togglePlayback').innerHTML=icon(paused?'play':'pause');$('togglePlayback').setAttribute('aria-label',paused?'播放':'暂停');$('togglePlayback').title=paused?'播放':'暂停';};
 for(const event of ['play','pause','ended','emptied'])video.addEventListener(event,syncPlayback);
 function updateExportSummary(selection=timeline.getSelection()){
  // A whole download covers every segment, not just the one on the timeline.
  const whole=$('wholeRecording').checked&&!isSubmission()&&segments.length>1;
  const range=whole?{start:0,end:playbackTotal}:selection;
  $('selectionDuration').textContent=formatDuration(whole?segments.reduce((sum,s)=>sum+s.end-s.start,0):selection.end-selection.start);
  if(isSubmission()){const rate=record.media.video.bandwidth+(record.media.audio?.bandwidth||0);$('estimatedSize').textContent=rate?`预计成品约 ${formatBytes(rate*(selection.end-selection.start)/8)}`:'大小暂不可用';return;}
  $('estimatedSize').textContent=estimate ? `约 ${formatBytes(estimateSelectionBytes(estimate,record.start,range))}` : estimateState==='error'?'大小暂不可用':'大小计算中…';
 }
 function startEstimate(plan,signal){
  void (async()=>{try{const groups=await plan.load();const result=await estimateRecordingRate(api,groups,signal);signal.throwIfAborted();estimate=result;updateExportSummary();}catch(e){if(!signal.aborted){estimateState='error';updateExportSummary();}}})();
 }
 const updateControls=createControls(root,timeline);
 function controls(){
  const route=parseSubmissionUrl(readPageUrl());
  $('currentVideo').hidden=!route||page==='edit'&&loadedRoute===route.key;
  $('wholeRecordingLabel').hidden=isSubmission();$('playSelection').hidden=!isSubmission();
  $('refreshEditor').textContent=isSubmission()?'重新加载视频':'刷新录像';
  updateControls({busy:Boolean(controller),ready,page,whole:$('wholeRecording').checked,submission:isSubmission(),stopping:fullFinishing||Boolean(fullStopController?.signal.aborted)});updateFeedback();}

 function showPage(next){page=next;for(const [id,value]of[['library','library'],['editPage','edit'],['offline','offline']])$(id).hidden=next!==value;$('body').scrollTop=next==='library'?libraryScroll:0;controls();}
 async function job(action,kind='load',details={}){if(controller)return;const own=new AbortController();const diagnostic=diagnostics.begin(details.action||kind,{pageUrl:readPageUrl(),record,...details});controller=own;jobKind=kind;controls();try{await action(own.signal,diagnostic);}catch(e){diagnostic.fail(e,own.signal);own.abort();status(e.name==='AbortError'?'已停止。':e.message,e.name!=='AbortError');}finally{controller=null;jobKind=null;fullStopController=null;fullFinishing=false;controls();if(pendingRoute){pendingRoute=false;if(!$('panel').hidden)void currentVideo();}}}
 function clearDownloads(){$('downloads').replaceChildren();}
 function leavePage(){
  scheduleController?.abort();scheduleController=null;$('scheduleNote').hidden=true;
  recordingController?.abort();recordingController=null;recordingPlan=null;previewDiagnostic=null;
  activePlayback()?.cancel();submissionThumbnails=false;
  estimate=null;estimateState='loading';record=null;ready=false;playbackTotal=0;clipSelection=null;recordStreams=[];segments=[];segmentIndex=0;renderSegments();
  $('wholeRecording').checked=false;timeline.stop();player?.clear();thumbnails.clear();clearDownloads();updateClock(0);
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
  },'load',{action:'library_load',record:{room:selected.room}});
 }
 function renderRecordMeta(){$('recordMeta').textContent=(isSubmission()?[record.uploader,record.partTitle?`P${record.part} · ${record.partTitle}`:'','画面与 B 站同步',`导出 ${record.qualityLabel}`]:[record.member,formatDate(record.start),record.schedule?.type]).filter(Boolean).join(' · ');}
 function enrichRecordType(){
  if(!record||isSubmission()||record.schedule!==undefined||$('panel').hidden)return;
  scheduleController?.abort();const own=new AbortController();scheduleController=own;const selected=record;
  void schedules.enrich([selected],{signal:own.signal}).then(result=>{
   if(own.signal.aborted||record!==selected||page!=='edit')return;
   record=result.records[0];renderRecordMeta();
  }).catch(()=>{});
 }
 async function loadRecord(next,signal){
  usePlayer('live');record=next;previewDiagnostic=diagnostics.begin('preview',{pageUrl:readPageUrl(),record:next});loadedRoute=null;showPage('edit');setTitle($('recordTitle'),record.title);renderRecordMeta();enrichRecordType();
  status('正在载入整场录像…');const {total,streams}=await player.load(record,signal);
  playbackTotal=total;updateClock(0);
  recordingController=new AbortController();recordingPlan=new RecordingPlan(api,streams,recordingController.signal);
  recordStreams=streams;segments=segmentBounds(record,streams,total);
  thumbnails.load(record,streams);ready=true;selectSegment(record.live?segments.length-1:0);startEstimate(recordingPlan,recordingController.signal);$('editPage').focus({preventScroll:true});
  status('按住时间轴预览；松开选区边界后自动适配视野。');
 }
 function segmentBounds(owner,streams,total){
  // A live recording keeps growing past the last reported end.
  return streams.map((stream,i)=>({start:clamp(stream.start_time-owner.start,0,total),end:owner.live&&i===streams.length-1?total:clamp(stream.end_time-owner.start,0,total)}));
 }
 function renderSegments(){
  const container=$('segments');container.hidden=segments.length<2;
  container.replaceChildren(...(segments.length<2?[]:segments.map((bounds,i)=>{
   const button=document.createElement('button');button.type='button';button.setAttribute('aria-pressed',i===segmentIndex);
   const range=document.createElement('span');range.textContent=formatTimeRange(bounds.start,bounds.end,'–');
   button.append(`第 ${i+1} 段`,range);button.onclick=()=>{if(i!==segmentIndex)selectSegment(i);};
   return button;
  })));
  controls();
 }
 function selectSegment(index){
  const bounds=segments[index],stream=recordStreams[index];
  segmentIndex=index;player.pause();timeline.reset(bounds);
  // Live recordings open near the newest picture; replays open at the segment start.
  seekTo(record.live&&index===segments.length-1?Math.max(bounds.start,stream.end_time-record.start-15):bounds.start);
  renderSegments();
 }
 async function enterRecord(next){await job(signal=>{leavePage();return loadRecord(next,signal);},'load',{action:'record_load',record:next});}
 async function currentRoom(){await job(async (signal,diagnostic)=>{leavePage();$('offlineTitle').textContent='暂时无法打开本场直播';showPage('offline');$('offlineReason').textContent='正在获取当前直播间…';try{const source=MEMBERS.find(m=>m.room===room)||{room,name:'当前直播间'};const next=await api.current(source,signal,{allowOffline:true});if(!next){$('offlineReason').textContent='当前没有直播。可以切换到历史回放，选择已结束的场次。';status('可重新检查直播，或浏览历史场次。');return;}await loadRecord(next,signal);}catch(e){if(e.name==='AbortError')throw e;diagnostic.fail(e,signal);showPage('offline');$('offlineReason').textContent=e.message;status('可重新检查直播，或浏览历史场次。');}},'load',{action:'room_load',record:{room}});}
 async function currentVideo(){
  const url=readPageUrl(),route=parseSubmissionUrl(url);if(!route||controller)return;
  await job(async (signal,diagnostic)=>{
   leavePage();loadedRoute=null;$('offlineTitle').textContent='暂时无法打开当前视频';showPage('offline');$('offlineReason').textContent='正在读取当前视频…';
   try{
    const next=await submissions.load(url,{signal});signal.throwIfAborted();
    usePlayer('submission');record=next;showPage('edit');setTitle($('recordTitle'),record.title);renderRecordMeta();
    loadedRoute=route.key;const {total}=await player.load(record,signal);signal.throwIfAborted();
    playbackTotal=total;thumbnails.load(record,[]);timeline.reset(total);ready=true;timeline.setCurrent(player.position());updateClock(player.position());
    if($('panel').hidden)player.suspend();
    $('editPage').focus({preventScroll:true});status('设置开始和结束位置后，即可导出当前视频片段。');
   }catch(error){if(signal.aborted)throw error;diagnostic.fail(error,signal);loadedRoute=null;ready=false;player?.clear();showPage('offline');$('offlineReason').textContent=error.message;status(error.message,true);}
  },'load',{action:'video_load',record:null});
 }
 function checkCurrentVideo(){
  const route=parseSubmissionUrl(readPageUrl()),key=route?.key;
  if(key===observedRoute){if(playerKind==='submission'&&!$('panel').hidden)player.refresh();return;}observedRoute=key;controls();
  if(!route||$('panel').hidden)return;
  if(controller){if(jobKind==='load'){pendingRoute=true;controller.abort();}return;}
  void currentVideo();
 }
 async function download(){
  if(controller||!ready)return;
  const submission=isSubmission();
  const selection=timeline.getSelection();
  await job(async (signal,diagnostic)=>{
   diagnostic.stage('select_destination');
   if(submission?!saveFilePicker:!directoryPicker||!storage?.getDirectory)throw new Error('当前浏览器未开放文件保存接口，请在 Chrome 或 Edge 的 HTTPS 页面导出。');
   // Pick the destination before the first network await, while click activation
   // is still live. A directory also covers an unknown number of discontinuities.
   const destination=submission
    ?await saveFilePicker({suggestedName:fileName(record,selection.start,selection.end),types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]})
    :await directoryPicker({mode:'readwrite'});
   signal.throwIfAborted();if(submission)player.cancel();else player.pause();clearDownloads();status('正在读取选中的片段…');
   diagnostic.stage('preparing');
   const onProgress=p=>{diagnostic.progress(p);renderExportProgress($('progress'),status,p,submission);if(submission&&p.estimatedBytes!==null)$('estimatedSize').textContent=`预计成品约 ${formatBytes(p.estimatedBytes)}`;};
   const showSaved=output=>{const line=document.createElement('p');line.textContent=`已保存 ${output.name} · ${formatBytes(output.bytes)}`;$('downloads').append(line);};
   if(submission){
    const output=await exportSubmission(api.request,record,selection,{signal,precise:true,onProgress,fileHandle:destination});
    showSaved({...output,name:destination.name});
   }else{
    await exportSelection(api,record,await recordingPlan.load(signal),selection,{signal,precise:exportMode==='precise',onProgress,
     createTemporary:options=>createTemporaryMedia({...options,storage}),
     createFile:({start,end,index,count})=>createClipFile(destination,fileName(record,start,end,count>1?`_第${index+1}段`:'')),
     onSaved:showSaved,
    });
   }
   status('导出完成，MP4 已保存到所选位置。');
  },'export',{selection,mode:submission?'precise':exportMode,estimatedBytes:submission?(record.media.video.bandwidth+(record.media.audio?.bandwidth||0))*(selection.end-selection.start)/8:estimate?estimateSelectionBytes(estimate,record.start,selection):undefined});
 }
 async function downloadFull(){
  // Keep the picker inside the click activation, before playlist/network work.
  if(controller||!ready)return;
  // Segments are separate recordings: save each to its own MP4 instead of splicing them.
  const split=segments.length>1;
  await job(async (signal,diagnostic)=>{
   diagnostic.stage('select_destination');
   if(split?!directoryPicker:!saveFilePicker)throw new Error('当前浏览器未开放文件保存接口，请在 Chrome 的 HTTPS 页面使用整场下载。');
   const destination=split?await directoryPicker({mode:'readwrite'}):await saveFilePicker({suggestedName:fileName(record,0,playbackTotal,'_整场'),types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
   signal.throwIfAborted();player.pause();clearDownloads();status('正在下载整场并写入文件…');
   diagnostic.stage('preparing');const groups=await recordingPlan.load(signal);signal.throwIfAborted();
   fullStopController=new AbortController();controls();
   const stopSignal=fullStopController.signal;
   const parts=split?segments.map((bounds,index)=>({bounds,index,groups:groups.filter(group=>group.streamIndex===index)})).filter(part=>part.groups.length):[{groups}];
   let saved=0,stopped=false;
   for(const [i,part]of parts.entries()){
    if(stopSignal.aborted){stopped=true;break;}
    const label=split?`第 ${part.index+1} 段`:'整场';
    const file=split?await createClipFile(destination,fileName(record,part.bounds.start,part.bounds.end,`_整场_第${part.index+1}段`)):null;
    let result;
    try{
     result=await saveRecording(api,part.groups,file?.handle??destination,{signal,stopSignal,onProgress:p=>{
      diagnostic.progress(p);
      if(p.progress!==undefined)$('progress').value=(i+p.progress)/parts.length*100;
      if(p.phase==='stopping'||p.phase==='finalizing'){fullFinishing=true;controls();status('正在保存…');}
      else if(p.phase!=='saved')status(`${p.reconnecting?`网络波动，自动重连中（第 ${p.attempt} 次）`:split?`整场下载 · 第 ${i+1}/${parts.length} 段`:'整场下载'} · ${formatBytes(p.speed)}/秒 · 已接收 ${formatBytes(p.bytes)} · 已写入 ${formatBytes(p.written)}`);
     }});
    }catch(error){await file?.remove().catch(()=>{});throw error;}
    if(!result.saved){await file?.remove().catch(()=>{});stopped=true;break;}
    saved++;
    const message=document.createElement('p');message.textContent=`${split?`${label}${result.stopped?'（部分）':''}`:result.stopped?'已完成部分':'整场'}已保存到所选位置${file?` · ${file.name}`:''} · ${formatDuration(result.duration)} · ${formatBytes(result.bytes)}`;$('downloads').append(message);
    if(result.stopped){stopped=true;break;}
    fullFinishing=false;controls();
   }
   status(stopped||!saved?'已停止。':'整场下载完成。');
  },'export',{action:'recording_download',selection:{start:0,end:playbackTotal},mode:'whole'});
 }
 async function open(){$('panel').hidden=false;if(playerKind==='submission')player.resume();void versionControl.refresh();const route=parseSubmissionUrl(readPageUrl());observedRoute=route?.key;if(route&&(!initialized||loadedRoute!==route.key)){initialized=true;await currentVideo();return;}if(!initialized){initialized=true;await(room?currentRoom():library());}else if(page==='library'){
   renderCards();const selected=member;void libraries.load(selected).then(result=>{
    if(member!==selected||page!=='library'||$('panel').hidden)return;
    renderCards();showScheduleResult(result);
   }).catch(()=>{});
  }else if(page==='edit')enrichRecordType();}
 const close=()=>{timeline.stop();$('panel').hidden=true;scheduleController?.abort();if(playerKind==='submission'){player.suspend();thumbnails.clear();if(record)thumbnails.load(record,[]);submissionThumbnails=false;}else playback.cancel();};
 $('close').onclick=close;
 $('launcher').onclick=()=>{if(!launcherMoved)$('panel').hidden?void open():close();};
 $('currentVideo').onclick=()=>void currentVideo();$('back').onclick=()=>void library();$('browseHistory').onclick=()=>void library();$('retryCurrent').onclick=()=>parseSubmissionUrl(readPageUrl())?currentVideo():currentRoom();$('refreshLibrary').onclick=()=>void library(true);$('refreshEditor').onclick=()=>isSubmission()?currentVideo():record.live?currentRoom():enterRecord(record);
 root.querySelectorAll('[data-member]').forEach(el=>el.onclick=()=>{member=MEMBERS.find(m=>m.id===el.dataset.member);set('member',member.id);libraryScroll=0;void library();});
 $('cancel').onclick=()=>{if(fullStopController){fullStopController.abort();controls();status('正在保存…');}else controller?.abort();};$('download').onclick=()=> $('wholeRecording').checked?downloadFull():download();
 $('wholeRecording').onchange=()=>{
  if($('wholeRecording').checked){clipSelection=timeline.getSelection();timeline.setSelection({...segments[segmentIndex]},true);if(segments.length>1)status(`整场共 ${segments.length} 段，将分别保存为 ${segments.length} 个文件。`);}
  else{timeline.setSelection(clipSelection,true);clipSelection=null;}
  controls();
 };
 root.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{exportMode=button.dataset.mode;root.querySelectorAll('[data-mode]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.mode===exportMode));updateExportSummary();});
 $('markStart').onclick=()=>{const s=timeline.getSelection(),t=player.position();try{timeline.setSelection({start:t,end:Math.max(s.end,t+.001)},true);$('startHandle').focus({preventScroll:true});}catch(e){status(e.message,true);}};
 $('markEnd').onclick=()=>{const s=timeline.getSelection(),t=player.position();try{timeline.setSelection({start:Math.min(s.start,t-.001),end:t},true);$('endHandle').focus({preventScroll:true});}catch(e){status(e.message,true);}};
 $('editPage').addEventListener('keydown',e=>{if(ready&&!controller&&!$('panel').hidden)timeline.handleKeyDown(e);},{capture:true});
 $('togglePlayback').onclick=()=>activePlayback()?.toggle();
 $('playSelection').onclick=()=>player.playSelection();
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
      const finish=()=>{ element.removeEventListener('pointermove',move); for(const name of ['pointerup','pointercancel','lostpointercapture']) element.removeEventListener(name,finish); onEnd?.(); };
      element.addEventListener('pointermove',move); for(const name of ['pointerup','pointercancel','lostpointercapture']) element.addEventListener(name,finish);
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
 const unbindPageProgress=bindPageProgress({document,getPlayer:()=>player,isActive:()=>playerKind==='submission'&&ready&&(!controller||jobKind==='export')&&!$('panel').hidden&&parseSubmissionUrl(readPageUrl())?.key===loadedRoute});
 const navigationTimer=setInterval(checkCurrentVideo,500);
 window.addEventListener('popstate',checkCurrentVideo);
 window.addEventListener('pagehide',()=>{unbindPageProgress();clearInterval(navigationTimer);window.removeEventListener('popstate',checkCurrentVideo);controller?.abort();libraries.abortAll();leavePage();player?.destroy();});
  controls();if(!room&&!parseSubmissionUrl(readPageUrl()))void libraries.preload(member);return {open,root};
}
