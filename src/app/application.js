import metadataText from '../header.txt';
import {readScriptMetadata,createUpdateChecker} from '../services/updates.js';
import {createVersionControl} from '../ui/version.js';
import html from '../ui/template.html';
import css from '../ui/styles.css';
import {createControls} from '../ui/controls.js';
import {createRecordCard} from '../ui/record-card.js';
import {icon} from '../ui/icons.js';
import {createScreenshotControls} from '../ui/live-screenshot.js';
import {downloadScreenshot} from './live-screenshot.js';
import {createTimeline} from '../ui/timeline.js';
import {DEFAULT_SHORTCUT,normalizeShortcut,formatShortcut,matchesShortcut,isEditing} from '../ui/shortcuts.js';
import {constrainRect,resizeRect} from '../ui/panel-geometry.js';
import {ScheduleService} from '../services/schedule.js';
import {createDiagnosticReporter} from '../services/diagnostics.js';
import {createLibraryLoader} from './library-loader.js';
import {createRecordingUpdater} from './recording-updater.js';
import {createSubmissionService} from '../services/submission.js';
import {createSubmissionStoryboard} from '../services/submission-storyboard.js';
import {bindPageProgress} from '../ui/page-progress.js';
import {parseSubmissionUrl} from '../domain/submission.js';
import {createSubmissionPlayer} from '../media/submission-player.js';
import {RecordingPlan} from '../media/recording-plan.js';
import {locateSegment} from '../media/playlist.js';
import {createPlayer} from '../media/preview-player.js';
import {createPlayback,bindVideoControls} from '../media/playback.js';
import {createThumbnails} from '../media/thumbnails.js';
import {createTemporaryMedia,ensureTemporarySpace} from '../media/temporary-media.js';
import {estimateRecordingRate,estimateSelectionBytes} from '../media/recording-estimate.js';
import {renderExportProgress} from '../ui/export-progress.js';
import {fileName} from '../media/file-name.js';
import {MEMBERS,roomIdFromUrl} from '../domain/records.js';
import {clamp} from '../shared/math.js';
import {formatDuration,formatTimeRange,formatDate,formatBytes,parseTime} from '../shared/format.js';

const NO_FILE_SAVING='当前浏览器不支持保存文件，请使用 Chrome 或 Edge。';

export function createApp({api,diagnostics=createDiagnosticReporter(),submissionRequest=api.request,mediaRequest=api.request,get=(_,fallback)=>fallback,set=()=>{},pageUrl=()=>location.href,saveFilePicker=typeof window.showSaveFilePicker==='function'?window.showSaveFilePicker.bind(window):null,storage=globalThis.navigator?.storage}){
 const host=document.createElement('div');host.id='bella-live-clip-host';const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>${css}</style>${html}`;document.documentElement.append(host);
 const syncTheme=()=>{const page=document.documentElement;host.dataset.theme=page.classList?.contains?.('bili_dark')||page.dataset?.theme==='dark'?'dark':'light';};syncTheme();
 const $=id=>root.getElementById(id),video=$('fullVideo');
 const readPageUrl=typeof pageUrl==='function'?pageUrl:()=>pageUrl;
 const room=roomIdFromUrl(readPageUrl()),submissions=createSubmissionService(submissionRequest);
 let player=null,playerKind=null,loadedRoute=null,observedRoute=parseSubmissionUrl(readPageUrl())?.key,jobKind=null,pendingRoute=false,submissionThumbnails=false;
 const isSubmission=()=>record?.kind==='submission';
 const metadata=readScriptMetadata(metadataText);
 const versionControl=createVersionControl({root,metadata,check:createUpdateChecker({request:api.request,metadata})});
 for(const [id,name]of[['close','close'],['refreshLibrary','refresh'],['refreshEditor','refresh'],['togglePlayback','play']])$(id).innerHTML=icon(name);
 $('back').innerHTML=icon('back')+'<span>选择直播</span>';
 $('download').innerHTML='<span>导出</span>'+icon('download');
 $('launcher').innerHTML=icon('scissors')+'<span>切片</span>';
 for(const m of MEMBERS){const button=document.createElement('button');button.dataset.member=m.id;const dot=document.createElement('i');dot.style.backgroundColor=m.color;button.append(dot,document.createTextNode(m.name));$('members').append(button);}
 let member=MEMBERS.find(m=>m.room===room)||MEMBERS.find(m=>m.id===get('member','bella'))||MEMBERS[0];
 let page='library',record=null,initialized=false,controller=null,ready=false,libraryScroll=0,playbackTotal=0,estimate=null,recordingController=null,recordingPlan=null,estimateState='loading',clipSelection=null,previewDiagnostic=null;
 // Each stream is one recorded segment (a new one starts after a disconnect); the editor works on one at a time.
 let recordStreams=[],segments=[],segmentIndex=0;
 function setTitle(element,text){element.textContent=text;element.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(text));}
 const schedules=new ScheduleService(api.request);const libraries=createLibraryLoader({api,schedules,backgroundEnrichment:true,store:{read:id=>get(`library.${id}`,null),write:(id,value)=>set(`library.${id}`,value)},onUpdate(selected,result){
  if(member.id===selected.id&&page==='library'&&!$('panel').hidden){renderCards();showScheduleResult(result);}
 }});let scheduleController=null,backgroundStarted=false;
 // Live clips default to lossless; video clips keep their exact cut, as they always have.
 const exportModes={live:get('exportMode.live','copy'),submission:get('exportMode.submission','precise')};
 const modeKind=()=>isSubmission()?'submission':'live',exportMode=()=>exportModes[modeKind()];
 function renderExportMode(){root.querySelectorAll('[data-mode]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.mode===exportMode()));}
 let shortcut=normalizeShortcut(get('shortcut',DEFAULT_SHORTCUT))||DEFAULT_SHORTCUT;
 let fullStopController=null,fullFinishing=false;
 const status=(text,error=false)=>{$('status').textContent=text;$('status').dataset.error=error;updateFeedback();};
 function updateFeedback(){$('feedback').hidden=!controller&&$('status').dataset.error!=='true'&&!$('downloads').childElementCount;}
 const viewport=()=>({width:innerWidth,height:innerHeight});
 const defaults=()=>constrainRect({left:innerWidth-820,top:20,width:800,height:880},viewport());
 let rect=constrainRect(get('windowV2',defaults()),viewport());
 const applyRect=()=>Object.assign($('panel').style,Object.fromEntries(Object.entries(rect).map(([k,v])=>[k,`${v}px`])));applyRect();
 createScreenshotControls({rootDocument:document,
  getVideo:()=>ready?player.getScreenshotVideo():null,
  getIdentity:()=>({streamerName:isSubmission()?record.uploader||record.title:record?.member,roomId:record?.room}),
  download:(blob,name)=>downloadScreenshot(document,blob,name),
 })($('previewScreenshot'));
 const seekTo=t=>{player?.seek(t);timeline.setCurrent(t);updateClock(t);};
 const playback=createPlayback(video,status,{getRange:()=>ready?timeline.getSelection():null,position:()=>player?.position()??0,seek:seekTo});
 const activePlayback=()=>playerKind==='submission'?player:playback;
 bindVideoControls(video,playback,status);
 // The player and the timeline strip read the same stills; one video needs one copy.
 let storyboard=null;
 function storyboardFor(submission){
  if(storyboard?.key!==submission.key){storyboard?.reader.dispose?.();storyboard={key:submission.key,reader:createSubmissionStoryboard({metadataRequest:submissionRequest,mediaRequest,submission})};}
  return {...storyboard.reader,dispose(){}};
 }
 const thumbnails=createThumbnails({container:$('thumbnails'),request:mediaRequest,api,metadataRequest:submissionRequest,createStoryboard:({submission})=>storyboardFor(submission),
  locate:async(time,signal)=>recordingPlan?locateSegment(await recordingPlan.load(signal),record.start+time):null});
 const mediaApi={request:mediaRequest};
 const timeline=createTimeline({track:$('timeline'),startHandle:$('startHandle'),endHandle:$('endHandle'),selectionElement:$('selection'),playhead:$('playhead'),ticks:$('ticks'),onRange:renderRange,onPreview:t=>{if(playerKind==='live')player.scrub(t);else player?.seek(t);updateClock(t);},onScrubStart:()=>{activePlayback()?.begin();if(playerKind==='live')player.beginScrub();if(isSubmission()){submissionThumbnails=true;thumbnails.update(timeline.getView());}},onScrubEnd:(_,{canceled=false}={})=>{if(playerKind==='live')player.endScrub();activePlayback()?.end({commit:!canceled});},onSelection:selection=>{updateExportSummary(selection);activePlayback()?.check();},onView:(view,motion)=>{$('timelineZoom').textContent=$('timeline').dataset.zoom;if(!isSubmission()||submissionThumbnails)thumbnails.update(view,motion);}});
 const updater=createRecordingUpdater({api,onUpdate:applyStreams,
  canRefresh:()=>ready&&record?.live&&page==='edit'&&!controller&&!$('panel').hidden&&!document.hidden&&!timeline.isInteracting()});
 const updateClock=t=>{$('clock').textContent=formatTimeRange(t,playbackTotal,' / ');};
 function usePlayer(kind){
  if(playerKind===kind)return;
  player?.destroy();playerKind=kind;
  const options={video,loading:$('videoLoading'),still:$('videoStill'),frameUrl:t=>thumbnails.frameUrl(t),api:{...mediaApi,clips:(...args)=>api.clips(...args)},request:mediaRequest,status,onStreams:applyStreams,onReady:owner=>{if(owner.key===record?.key)startBackgroundPreview();},onError:error=>{previewDiagnostic?.fail(error,recordingController?.signal);startBackgroundPreview();},onTime:t=>{timeline.setCurrent(t);updateClock(t);}};
  video.hidden=kind==='submission';$('pageMirror').hidden=kind!=='submission';
  player=kind==='submission'?createSubmissionPlayer({...options,canvas:$('pageMirror'),
   getVideo:()=>document.querySelector('.bpx-player-container video, .bilibili-player-video video')??document.querySelector('video'),
   isCurrent:()=>parseSubmissionUrl(readPageUrl())?.key===loadedRoute,getRange:()=>timeline.getSelection(),onState:()=>syncPlayback(),
   createPreview:storyboardFor}):createPlayer(options);
 }
 let lastPlaybackPaused;
 const syncPlayback=()=>{const paused=playerKind==='submission'?player.isPaused():video.paused||video.ended;if(paused===lastPlaybackPaused)return;lastPlaybackPaused=paused;$('togglePlayback').innerHTML=icon(paused?'play':'pause');$('togglePlayback').setAttribute('aria-label',paused?'播放':'暂停');$('togglePlayback').title=paused?'播放':'暂停';};
 for(const event of ['play','pause','ended','emptied'])video.addEventListener(event,syncPlayback);
 function updateExportSummary(selection=timeline.getSelection()){
  // Both the timeline and the whole-download action refer to the active segment.
  const whole=$('wholeRecording').checked&&!isSubmission();
  const range=whole&&segments.length?segments[segmentIndex]:selection;
  $('selectionDuration').textContent=formatDuration(range.end-range.start);
  if(isSubmission()){const rate=record.media.video.bandwidth+(record.media.audio?.bandwidth||0);$('estimatedSize').textContent=rate?`约 ${formatBytes(rate*(selection.end-selection.start)/8)}`:'大小暂不可用';return;}
  $('estimatedSize').textContent=estimate ? `约 ${formatBytes(estimateSelectionBytes(estimate,record.start,range))}` : estimateState==='error'?'大小暂不可用':'大小计算中…';
 }
 function startEstimate(plan,signal,previous){
  void (async()=>{try{const groups=await plan.load();const result=await estimateRecordingRate(mediaApi,groups,signal,previous);signal.throwIfAborted();estimate=result;updateExportSummary();}catch(e){if(!signal.aborted){estimateState='error';updateExportSummary();}}})();
 }
 function startBackgroundPreview(){
  if(backgroundStarted||!ready||isSubmission()||!recordingPlan)return;
  backgroundStarted=true;thumbnails.resume();startEstimate(recordingPlan,recordingController.signal);
 }
 function applyStreams(parts){
  const next=player.extend(parts);if(!next)return;
  if(!next.changed){recordStreams=next.streams;recordingPlan=new RecordingPlan(mediaApi,recordStreams,recordingController.signal);return;}
  const previousEstimate=estimate;
  recordingController?.abort();recordingController=new AbortController();
  recordStreams=next.streams;playbackTotal=next.total;segments=segmentBounds(record,recordStreams,playbackTotal);
  recordingPlan=new RecordingPlan(mediaApi,recordStreams,recordingController.signal);
  estimate=null;estimateState='loading';
  thumbnails.setStreams(recordStreams,player.position());
  timeline.extend(segments[segmentIndex].end,{whole:$('wholeRecording').checked});
  renderSegments();updateClock(player.position());updateExportSummary();
  if(backgroundStarted)startEstimate(recordingPlan,recordingController.signal,previousEstimate);
 }
 const updateControls=createControls(root,timeline);
 function renderRange({start,end}){
  const [from,to]=formatTimeRange(start,end).split(' — ');
  if(root.activeElement!==$('selectionStart'))$('selectionStart').value=from;
  if(root.activeElement!==$('selectionEnd'))$('selectionEnd').value=to;
 }
 function controls(){
  const route=parseSubmissionUrl(readPageUrl());
  $('currentVideo').hidden=!route||page==='edit'&&loadedRoute===route.key;
  $('wholeRecordingLabel').hidden=isSubmission();$('playSelection').hidden=!isSubmission();
  const refreshLabel=isSubmission()?'重新加载视频':'刷新录像';
  $('refreshEditor').setAttribute('aria-label',refreshLabel);$('refreshEditor').title=refreshLabel;
  updateControls({busy:Boolean(controller),ready,page,whole:$('wholeRecording').checked,stopping:fullFinishing||Boolean(fullStopController?.signal.aborted)});updateFeedback();}

 function showPage(next){page=next;for(const [id,value]of[['library','library'],['editPage','edit'],['offline','offline']])$(id).hidden=next!==value;$('body').scrollTop=next==='library'?libraryScroll:0;controls();}
 async function job(action,kind='load',details={}){if(controller)return;const own=new AbortController();const diagnostic=diagnostics.begin(details.action||kind,{pageUrl:readPageUrl(),record,...details});controller=own;jobKind=kind;if(kind==='export'){updater.stop();window.addEventListener('beforeunload',holdPage);}controls();try{await action(own.signal,diagnostic);}catch(e){diagnostic.fail(e,own.signal);own.abort();status(e.name==='AbortError'?'已停止。':e.message,e.name!=='AbortError');}finally{window.removeEventListener('beforeunload',holdPage);controller=null;jobKind=null;fullStopController=null;fullFinishing=false;controls();if(kind==='export'&&record?.live&&ready&&!$('panel').hidden)updater.start(record);if(pendingRoute){pendingRoute=false;if(!$('panel').hidden)void currentVideo();}}}
 // Refreshing or closing the page cannot resume an export.
 function holdPage(event){event.preventDefault();event.returnValue='';}
 function clearDownloads(){$('downloads').replaceChildren();}
 function leavePage(){
  updater.stop();
  scheduleController?.abort();scheduleController=null;$('scheduleNote').hidden=true;
  recordingController?.abort();recordingController=null;recordingPlan=null;previewDiagnostic=null;
  activePlayback()?.cancel();submissionThumbnails=false;
  estimate=null;estimateState='loading';backgroundStarted=false;record=null;ready=false;playbackTotal=0;clipSelection=null;recordStreams=[];segments=[];segmentIndex=0;renderSegments();
  $('wholeRecording').checked=false;timeline.stop();player?.clear();thumbnails.clear();storyboard?.reader.dispose?.();storyboard=null;clearDownloads();updateClock(0);
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
  await job(async signal=>{status('正在加载场次…');const result=await libraries.load(selected,{refresh,signal});
   if(signal.aborted||member!==selected)return;
   renderCards();showScheduleResult(libraries.get(selected)||result);
  },'load',{action:'library_load',record:{room:selected.room}});
 }
 function renderRecordMeta(){$('recordMeta').textContent=(isSubmission()?[record.uploader,record.partTitle?`P${record.part} · ${record.partTitle}`:'',`导出 ${record.qualityLabel}`]:[record.member,formatDate(record.start),record.schedule?.type]).filter(Boolean).join(' · ');}
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
  renderExportMode();status('正在加载录像…');const {total,streams}=await player.load(record,signal);
  playbackTotal=total;updateClock(0);
  recordingController=new AbortController();recordingPlan=new RecordingPlan(mediaApi,streams,recordingController.signal);
  recordStreams=streams;segments=segmentBounds(record,streams,total);
  thumbnails.load(record,streams,{defer:true,center:record.live?total:0,onFrames:()=>player.refreshStill?.()});ready=true;selectSegment(record.live?segments.length-1:0);$('editPage').focus({preventScroll:true});
  updater.start(record);
 }
 function segmentBounds(owner,streams,total){
  // Only advertise generated footage, including when the last live segment
  // lags behind wall time or a disconnect creates a new segment.
  return streams.map(stream=>({start:clamp(stream.start_time-owner.start,0,total),end:clamp(stream.end_time-owner.start,0,total)}));
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
  clipSelection=$('wholeRecording').checked?{...bounds}:null;
  // Live recordings open near the newest picture; replays open at the segment start.
  seekTo(record.live&&index===segments.length-1?Math.max(bounds.start,stream.end_time-record.start-15):bounds.start);
  renderSegments();
 }
 // Keeps the selection and position. Only a recording that never opened starts over.
 async function refreshRecording(){
  if(!record)return;
  if(!ready){await enterRecord(record);return;}
  await job(async signal=>{status('正在刷新录像…');await updater.refresh(record,signal);player.reload();},'load',{action:'record_refresh',record});
 }
 async function enterRecord(next){await job(signal=>{leavePage();return loadRecord(next,signal);},'load',{action:'record_load',record:next});}
 async function currentRoom(){await job(async (signal,diagnostic)=>{leavePage();$('offlineTitle').textContent='暂时无法打开本场直播';showPage('offline');$('offlineReason').textContent='正在加载…';try{const source=MEMBERS.find(m=>m.room===room)||{room,name:'当前直播间'};const next=await api.current(source,signal,{allowOffline:true});if(!next){$('offlineReason').textContent='当前没有直播，可以看看历史回放。';return;}await loadRecord(next,signal);}catch(e){if(e.name==='AbortError')throw e;diagnostic.fail(e,signal);showPage('offline');$('offlineReason').textContent=e.message;}},'load',{action:'room_load',record:{room}});}
 async function currentVideo(){
  const url=readPageUrl(),route=parseSubmissionUrl(url);if(!route||controller)return;
  await job(async (signal,diagnostic)=>{
   leavePage();loadedRoute=null;$('offlineTitle').textContent='暂时无法打开当前视频';showPage('offline');$('offlineReason').textContent='正在加载…';
   try{
    const next=await submissions.load(url,{signal});signal.throwIfAborted();
    usePlayer('submission');record=next;showPage('edit');setTitle($('recordTitle'),record.title);renderRecordMeta();renderExportMode();
    loadedRoute=route.key;const {total}=await player.load(record,signal);signal.throwIfAborted();
    playbackTotal=total;thumbnails.load(record,[]);timeline.reset(total);ready=true;timeline.setCurrent(player.position());updateClock(player.position());
    if($('panel').hidden)player.suspend();
    $('editPage').focus({preventScroll:true});
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
   if(!saveFilePicker||!submission&&!storage?.getDirectory)throw new Error(NO_FILE_SAVING);
   // Pick the destination before the first network await, while click activation
   // is still live. A clip stays inside one segment, so it is always one file; a
   // file picker also works in Downloads/Desktop, which Chrome refuses as directories.
   const destination=await saveFilePicker({suggestedName:fileName(record,selection.start,selection.end),types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
   signal.throwIfAborted();if(submission)player.cancel();else player.pause();clearDownloads();status('正在导出…');
   diagnostic.stage('preparing');
   const onProgress=p=>{diagnostic.progress(p);renderExportProgress($('progress'),status,p,submission);if(submission&&p.estimatedBytes!==null)$('estimatedSize').textContent=`约 ${formatBytes(p.estimatedBytes)}`;};
   const showSaved=output=>{const line=document.createElement('p');line.textContent=`已保存 ${output.name} · ${formatBytes(output.bytes)}`;$('downloads').append(line);};
   if(submission){
    const {exportSubmission}=await import('../media/submission-export.js');
    const output=await exportSubmission(mediaRequest,record,selection,{signal,precise:exportMode()==='precise',onProgress,fileHandle:destination});
    showSaved({...output,name:destination.name});
   }else{
    await ensureTemporarySpace(storage,estimate?estimateSelectionBytes(estimate,record.start,selection):0);
    const groups=(await recordingPlan.load(signal)).filter(group=>group.streamIndex===segmentIndex);
    const {exportSelection}=await import('../media/export.js');
    await exportSelection(mediaApi,record,groups,selection,{signal,precise:exportMode()==='precise',onProgress,
     createTemporary:options=>createTemporaryMedia({...options,storage}),
     createFile:()=>({handle:destination,name:destination.name,remove:async()=>{}}),
     onSaved:showSaved,
    });
   }
   status('导出完成。');
  },'export',{selection,mode:exportMode(),estimatedBytes:submission?(record.media.video.bandwidth+(record.media.audio?.bandwidth||0))*(selection.end-selection.start)/8:estimate?estimateSelectionBytes(estimate,record.start,selection):undefined});
 }
 async function downloadFull(){
  // Keep the picker inside the click activation, before playlist/network work.
  if(controller||!ready)return;
  // Segments are separate recordings: only the selected one is saved, never spliced.
  const bounds=segments[segmentIndex]??{start:0,end:playbackTotal},index=segmentIndex;
  await job(async (signal,diagnostic)=>{
   diagnostic.stage('select_destination');
   if(!saveFilePicker)throw new Error(NO_FILE_SAVING);
   const handle=await saveFilePicker({suggestedName:fileName(record,bounds.start,bounds.end,segments.length>1?`_整场_第${index+1}段`:'_整场'),types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
   signal.throwIfAborted();player.pause();clearDownloads();status('正在导出整场…');
   diagnostic.stage('preparing');const groups=(await recordingPlan.load(signal)).filter(group=>group.streamIndex===index);signal.throwIfAborted();
   fullStopController=new AbortController();controls();
   const {saveRecording}=await import('../media/recording.js');
   const result=await saveRecording(mediaApi,groups,handle,{signal,stopSignal:fullStopController.signal,onProgress:p=>{
    diagnostic.progress(p);
    if(p.progress!==undefined)$('progress').value=p.progress*100;
    if(p.phase==='stopping'||p.phase==='finalizing'){fullFinishing=true;controls();status('正在保存…');}
    else if(p.phase!=='saved')status(`${p.reconnecting?`网络波动，正在重连（第 ${p.attempt} 次）`:'导出整场'} · ${formatBytes(p.speed)}/秒 · 已写入 ${formatBytes(p.written)}`);
   }});
   if(!result.saved){status('已停止。');return;}
   status(result.stopped?'已停止。':'导出完成。');
   const message=document.createElement('p');message.textContent=`已保存${result.stopped?'已完成部分':'整场'} · ${formatDuration(result.duration)} · ${formatBytes(result.bytes)}`;$('downloads').append(message);
  },'export',{action:'recording_download',selection:{...bounds},mode:'whole'});
 }
 async function open(){syncTheme();$('panel').hidden=false;if(playerKind==='submission')player.resume();void versionControl.refresh();const route=parseSubmissionUrl(readPageUrl());observedRoute=route?.key;if(route&&(!initialized||loadedRoute!==route.key)){initialized=true;await currentVideo();return;}if(!initialized){initialized=true;await(room?currentRoom():library());}else if(page==='library'){
   renderCards();const selected=member;void libraries.load(selected).then(result=>{
    if(member!==selected||page!=='library'||$('panel').hidden)return;
    renderCards();showScheduleResult(libraries.get(selected)||result);
   }).catch(()=>{});
  }else if(page==='edit'){enrichRecordType();if(ready&&record?.live)updater.start(record);}}
 const close=()=>{updater.stop();timeline.stop();$('panel').hidden=true;scheduleController?.abort();if(playerKind==='submission'){player.suspend();thumbnails.clear();if(record)thumbnails.load(record,[]);submissionThumbnails=false;}else playback.cancel();};
 $('close').onclick=close;
 $('launcher').onclick=()=>{if(!launcherMoved)$('panel').hidden?void open():close();};
 $('currentVideo').onclick=()=>void currentVideo();$('back').onclick=()=>void library();$('browseHistory').onclick=()=>void library();$('retryCurrent').onclick=()=>parseSubmissionUrl(readPageUrl())?currentVideo():currentRoom();$('refreshLibrary').onclick=()=>void library(true);$('refreshEditor').onclick=()=>isSubmission()?currentVideo():refreshRecording();
 root.querySelectorAll('[data-member]').forEach(el=>el.onclick=()=>{member=MEMBERS.find(m=>m.id===el.dataset.member);set('member',member.id);libraryScroll=0;void library();});
 $('cancel').onclick=()=>{if(fullStopController){fullStopController.abort();controls();status('正在保存…');}else controller?.abort();};$('download').onclick=()=> $('wholeRecording').checked?downloadFull():download();
 $('wholeRecording').onchange=()=>{
  if($('wholeRecording').checked){clipSelection=timeline.getSelection();timeline.setSelection({...segments[segmentIndex]},true);}
  else{timeline.setSelection(clipSelection,true);clipSelection=null;}
  controls();
 };
 root.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{const kind=modeKind();exportModes[kind]=button.dataset.mode;set(`exportMode.${kind}`,button.dataset.mode);renderExportMode();updateExportSummary();});
 function applySelection(next,handle){try{timeline.setSelection(next,true);handle?.focus({preventScroll:true});status('');}catch(e){status(e.message,true);}}
 // Crossing the other end opens the range to the recording's edge instead of collapsing it.
 function markStart(){const s=timeline.getSelection(),t=player.position();applySelection({start:t,end:t<s.end?s.end:timeline.getBounds().end},$('startHandle'));}
 function markEnd(){const s=timeline.getSelection(),t=player.position();applySelection({start:t>s.start?s.start:timeline.getBounds().start,end:t},$('endHandle'));}
 $('markStart').onclick=markStart;$('markEnd').onclick=markEnd;
 for(const [id,edge]of[['selectionStart','start'],['selectionEnd','end']]){
  $(id).onchange=()=>{const time=parseTime($(id).value),current=timeline.getSelection();
   if(time===null)status('时间格式不对，例如 1:02:03 或 62.5。',true);else applySelection({...current,[edge]:time});
   renderRange(timeline.getSelection());};
  $(id).onkeydown=event=>{if(event.key==='Enter')$(id).blur();event.stopPropagation();};
 }
 const editorKeys={' ':()=>activePlayback()?.toggle(),i:markStart,o:markEnd};
 $('editPage').addEventListener('keydown',e=>{
  if(!ready||controller||$('panel').hidden)return;
  timeline.handleKeyDown(e);
  const action=editorKeys[e.key.toLowerCase()];
  if(!action||e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||isEditing(e)||$('wholeRecording').checked||e.key===' '&&e.target.closest?.('button'))return;
  e.preventDefault();e.stopPropagation();action();
 },{capture:true});
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
 window.addEventListener('pagehide',event=>{if(event.persisted)return;unbindPageProgress();clearInterval(navigationTimer);window.removeEventListener('popstate',checkCurrentVideo);controller?.abort();libraries.abortAll();leavePage();player?.destroy();});
  // Only prepare the list once someone reaches for the panel: this runs on every
  // Bilibili page, and account-bound requests there would add up across tabs.
  let preloaded=Boolean(room||parseSubmissionUrl(readPageUrl()));
  const preload=()=>{if(!preloaded){preloaded=true;void libraries.preload(member);}};
  $('launcher').addEventListener('pointerenter',preload);$('launcher').addEventListener('focus',preload);
  controls();return {open,root};
}
