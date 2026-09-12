import html from './ui.html';
import {icon} from './icons.js';
import css from './ui.css';
import {createPlayer} from './full-preview.js';
import {createPlayback} from './playback.js';
import {createTimeline} from './timeline.js';
import {exportSelection} from './media.js';
import {MEMBERS,DEFAULT_SHORTCUT,clamp,formatTime,formatPlaybackTime,formatDate,formatBytes,roomIdFromUrl,normalizeShortcut,formatShortcut,matchesShortcut,isEditing,constrainRect,resizeRect,fileName} from './core.js';

export function createApp({api,get=(_,fallback)=>fallback,set=()=>{},pageUrl=location.href}){
 const host=document.createElement('div');host.id='bella-live-clip-host';const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>${css}</style>${html}`;document.documentElement.append(host);
 const $=id=>root.getElementById(id),video=$('fullVideo');const room=roomIdFromUrl(pageUrl);
 for(const [id,name]of[['close','close'],['refreshLibrary','refresh'],['togglePlayback','play']])$(id).innerHTML=icon(name);
 $('back').innerHTML=icon('back')+'<span>选择直播</span>';
 $('download').innerHTML='<span>下载选区 MP4</span>'+icon('download');
 $('launcher').innerHTML=icon('scissors')+'<span>片段</span>';
 for(const m of MEMBERS){const button=document.createElement('button');button.dataset.member=m.id;const dot=document.createElement('i');dot.style.backgroundColor=m.color;button.append(dot,document.createTextNode(m.name));$('members').append(button);}
 let member=MEMBERS.find(m=>m.room===room)||MEMBERS.find(m=>m.id===get('member','bella'))||MEMBERS[0];
 let page='library',record=null,initialized=false,controller=null,busy=false,ready=false,libraryScroll=0,playbackTotal=0;
 function setTitle(element,text){element.textContent=text;element.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(text));}
 const cache=new Map(),urls=[];let shortcut=normalizeShortcut(get('shortcut',DEFAULT_SHORTCUT))||DEFAULT_SHORTCUT;
 const status=(text,error=false)=>{$('status').textContent=text;$('status').dataset.error=error;updateFeedback();};
 function updateFeedback(){$('feedback').hidden=!busy&&$('status').dataset.error!=='true'&&!$('downloads').childElementCount;}
 const viewport=()=>({width:innerWidth,height:innerHeight});
 const defaults=()=>constrainRect({left:innerWidth-820,top:20,width:800,height:880},viewport());
 let rect=constrainRect(get('windowV2',defaults()),viewport());
 const applyRect=()=>Object.assign($('panel').style,Object.fromEntries(Object.entries(rect).map(([k,v])=>[k,`${v}px`])));applyRect();
 const playback=createPlayback(video,status);
 const timeline=createTimeline({track:$('timeline'),startHandle:$('startHandle'),endHandle:$('endHandle'),selectionElement:$('selection'),playhead:$('playhead'),ticks:$('ticks'),labels:$('timelineLabels'),onPreview:t=>{player.seek(t);updateClock(t);},onScrubStart:()=>playback.begin(),onScrubEnd:()=>playback.end()});
 const updateClock=t=>{$('clock').textContent=`${formatPlaybackTime(t)} / ${formatPlaybackTime(playbackTotal)}`;};
 const player=createPlayer({video,loading:$('videoLoading'),api,status,onTime:t=>{timeline.setCurrent(t);updateClock(t);}});
 const syncPlayback=()=>{const paused=video.paused||video.ended;$('togglePlayback').innerHTML=icon(paused?'play':'pause');$('togglePlayback').setAttribute('aria-label',paused?'播放':'暂停');$('togglePlayback').title=paused?'播放':'暂停';};
 for(const event of ['play','pause','ended','emptied'])video.addEventListener(event,syncPlayback);
 function controls(){root.querySelectorAll('#body button,#body input,#body select').forEach(el=>{el.disabled=busy;});timeline.lock(busy||!ready);for(const id of ['togglePlayback','markStart','markEnd'])$(id).disabled=busy||!ready;$('download').hidden=page!=='edit';$('download').disabled=busy||!ready;$('cancel').hidden=!busy;$('progress').hidden=!busy;$('launcher').dataset.busy=busy;$('cancel').disabled=false;updateFeedback();}
 function showPage(next){page=next;for(const [id,value]of[['library','library'],['editPage','edit'],['offline','offline']])$(id).hidden=next!==value;$('body').scrollTop=next==='library'?libraryScroll:0;controls();}
 async function job(action){if(busy)return;const own=new AbortController();controller=own;busy=true;controls();try{await action(own.signal);}catch(e){own.abort();status(e.name==='AbortError'?'已取消。':e.message,e.name!=='AbortError');}finally{busy=false;controller=null;controls();}}
 function clearDownloads(){urls.forEach(URL.revokeObjectURL);urls.length=0;$('downloads').replaceChildren();}
 function renderCards(){
  root.querySelectorAll('[data-member]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.member===member.id));
  const records=cache.get(member.id)||[];$('cards').replaceChildren();$('libraryEmpty').hidden=records.length>0;$('libraryEmpty').textContent='近 14 天暂无可用回放';
  for(const r of records){const card=document.createElement('button');card.className='record-card';card.setAttribute('aria-label',`${formatDate(r.start)} ${r.title}`);const cover=document.createElement('div');cover.className='cover';
   const placeholder=document.createElement('span');placeholder.className='cover-placeholder';placeholder.innerHTML=icon('play');cover.append(placeholder);
   if(r.cover){const image=document.createElement('img');image.src=r.cover;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';image.onload=()=>placeholder.hidden=true;image.onerror=()=>image.hidden=true;cover.append(image);}
   const duration=document.createElement('span');duration.className='duration';duration.textContent=formatTime(r.end-r.start);cover.append(duration);
   const info=document.createElement('div');info.className='card-info';const title=document.createElement('strong');setTitle(title,r.title);const date=document.createElement('p');date.textContent=`${formatDate(r.start)} · ${member.name}`;info.append(title,date);card.append(cover,info);card.onclick=()=>{libraryScroll=$('body').scrollTop;void enterRecord(r);};$('cards').append(card);
  }
 }
 async function library(refresh=false){playback.cancel();player.clear();clearDownloads();ready=false;showPage('library');renderCards();if(!refresh&&cache.has(member.id)){status('选择想剪辑的那场直播。');return;}await job(async signal=>{status('正在获取直播场次…');cache.set(member.id,await api.history(member,signal));renderCards();status('选择想剪辑的那场直播。');});}
 async function loadRecord(next,signal){
  playback.cancel();playbackTotal=0;updateClock(0);record=next;ready=false;clearDownloads();showPage('edit');setTitle($('recordTitle'),record.title);$('recordMeta').textContent=`${record.member} · ${formatDate(record.start)}${record.live?' · 本场直播':' · 历史回放'}`;
  status('正在载入整场录像…');const {total,streams}=await player.load(record,signal);
  playbackTotal=total;updateClock(0);
  const first=Math.max(0,streams[0].start_time-record.start),last=Math.min(total,streams.at(-1).end_time-record.start);
  const end=record.live?Math.max(first+.001,last-15):Math.min(last,first+60),start=record.live?Math.max(first,end-60):first;
  timeline.reset(total,{start,end});ready=true;if(record.live)player.seek(start);status('按住时间轴预览；松开选区边界后自动适配视野。');
 }
 async function enterRecord(next){await job(signal=>loadRecord(next,signal));}
 async function currentRoom(){await job(async signal=>{ready=false;showPage('offline');$('offlineReason').textContent='正在获取当前直播间…';try{const source=MEMBERS.find(m=>m.room===room)||{room,name:'当前直播间'};const next=await api.current(source,signal);await loadRecord(next,signal);}catch(e){if(e.name==='AbortError')throw e;showPage('offline');$('offlineReason').textContent=e.message;status('可重新检查直播，或浏览历史场次。');}});}
 async function download(){await job(async signal=>{const selection=timeline.getSelection();player.pause();clearDownloads();status('正在下载选中的录像…');const outputs=await exportSelection(api,record,player.getStreams(),selection,{signal,precise:$('exportMode').value==='precise',onProgress:p=>{$('progress').value=p.phase==='download'?p.done/p.count*75:75+p.progress*25;status(p.phase==='download'?`下载分片 ${p.done}/${p.count} · ${formatBytes(p.bytes)}`:'正在生成 MP4…');}});
  for(const [i,output]of outputs.entries()){const a=document.createElement('a');a.href=URL.createObjectURL(output.blob);urls.push(a.href);a.download=fileName(record,output.start,output.end,outputs.length>1?`_第${i+1}段`:'');a.textContent=`保存${outputs.length>1?'第 '+(i+1)+' 段':''} MP4 · ${formatBytes(output.blob.size)}`;$('downloads').append(a);}
  if(outputs.length===1)$('downloads').firstElementChild.click();status(outputs.length===1?'MP4 已生成，可点击下方链接再次保存。':`选区跨越录像中断，已生成 ${outputs.length} 个文件，请分别保存。`);
 });}
 async function open(){$('panel').hidden=false;if(!initialized){initialized=true;await(room?currentRoom():library());}}
 const close=()=>{$('panel').hidden=true;playback.cancel();};
 $('close').onclick=close;
 $('launcher').onclick=()=>{if(!launcherMoved)$('panel').hidden?void open():close();};
 $('back').onclick=()=>void library();$('browseHistory').onclick=()=>void library();$('retryCurrent').onclick=currentRoom;$('refreshLibrary').onclick=()=>void library(true);$('refreshEditor').onclick=()=>record.live?currentRoom():enterRecord(record);
 root.querySelectorAll('[data-member]').forEach(el=>el.onclick=()=>{member=MEMBERS.find(m=>m.id===el.dataset.member);set('member',member.id);libraryScroll=0;void library();});
 $('cancel').onclick=()=>controller?.abort();$('download').onclick=download;
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
 window.addEventListener('pagehide',()=>{controller?.abort();player.clear();clearDownloads();});controls();return {open,resetWindow,root};
}
