import {createApp} from '../../../src/app/application.js';
import metadata from '../../../src/header.txt';
import {inspectMedia} from '../support/media-info.mjs';

const ids=['BV1SNYq6gEQh','BV1xx411c7mD'];
const route=(index,part=1)=>`https://www.bilibili.com/video/${ids[index]}/?p=${part}`;
let pageUrl=route(0),delayedView=null,mediaGate=null;
const reads=[],checks=[];
const result=document.getElementById('result');
const sheetCanvas=document.createElement('canvas');sheetCanvas.width=640;sheetCanvas.height=360;
const sheetContext=sheetCanvas.getContext('2d');
for(const [i,color]of ['#c84040','#40c840','#4040c8','#c8c840'].entries()){sheetContext.fillStyle=color;sheetContext.fillRect(i%2*320,Math.floor(i/2)*180,320,180);}
const sheetBytes=new Promise(resolve=>sheetCanvas.toBlob(async blob=>resolve(await blob.arrayBuffer())));
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<400;i++){if(check())return;await delay(50);}throw new Error(`等待超时：${label}`);}
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release,reads:[]};}
const api={
 history:async()=>[],current:async()=>null,
 request:async(url,{signal,type,range}={})=>{
  const parsed=new URL(url);signal?.throwIfAborted();
  if(parsed.hostname==='share.bellaris.fans')return {data:metadata,url};
  if(parsed.hostname==='calendar.bk0717.us.ci')return {data:'BEGIN:VCALENDAR\r\nEND:VCALENDAR',url};
  if(parsed.pathname==='/x/web-interface/view'){
   const bvid=parsed.searchParams.get('bvid'),index=ids.indexOf(bvid),entry={bvid,signal};
   reads.push(entry);
   if(delayedView?.bvid===bvid){delayedView.reads.push(entry);await delayedView.promise;}
   // Deliberately return even after abort: the application must reject late data.
   return {data:JSON.stringify({code:0,data:{bvid,aid:index+1,title:`测试投稿 ${index+1}`,owner:{name:'测试作者'},pages:[1,2].map(part=>({page:part,cid:1000+index*10+part,duration:30,part:`测试分段 ${part}`}))}}),url};
  }
  if(parsed.pathname==='/x/web-interface/nav')return {data:JSON.stringify({code:-101,data:{wbi_img:{img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'}}}),url};
  if(parsed.pathname==='/x/player/videoshot')return {data:JSON.stringify({code:0,data:{img_x_len:2,img_y_len:2,img_x_size:320,img_y_size:180,image:['https://preview.hdslb.com/sheet.jpg'],index:[0,0,8,16,24]}})};
  if(parsed.hostname==='preview.hdslb.com'){reads.push({url,signal});return {data:await sheetBytes};}
  if(parsed.pathname==='/x/player/wbi/playurl')return {data:JSON.stringify({code:0,data:{format:'mp4',quality:80,timelength:30000,accept_quality:[80],accept_description:['1080P 测试'],durl:[{url:`https://fixture.bilivideo.com/${parsed.searchParams.get('cid')}.mp4`}]}}),url};
  if(parsed.hostname==='fixture.bilivideo.com'){
   const entry={signal,url};reads.push(entry);
   if(mediaGate){const own=mediaGate;own.reads.push(entry);await own.promise;}
   signal?.throwIfAborted();
   const response=await fetch('/fixture.mp4',{signal,headers:range?{Range:`bytes=${range.offset}-${range.offset+range.length-1}`}:{}});
   return {data:type==='arraybuffer'?await response.arrayBuffer():await response.text(),headers:[...response.headers].map(([name,value])=>`${name}: ${value}`).join('\r\n'),url};
  }
  throw new Error(`测试没有定义此接口：${parsed.origin}${parsed.pathname}`);
 },
};
const pageVideo=document.createElement('video');pageVideo.src='/fixture.mp4';pageVideo.muted=true;pageVideo.controls=true;pageVideo.width=240;document.body.append(pageVideo);
const app=createApp({api,pageUrl:()=>pageUrl,get:(key,fallback)=>key==='windowV2'?{left:480,top:20,width:780,height:780}:fallback});
const $=id=>app.root.getElementById(id);
const editable=()=>!$('editPage').hidden&&!$('download').disabled;
const title=index=>$('recordTitle').textContent===`测试投稿 ${index+1}`;
const navigate=async(index,part=1)=>{pageUrl=route(index,part);window.dispatchEvent(new PopStateEvent('popstate'));};
const pass=name=>{checks.push(name);result.textContent=`已通过 ${checks.length} 项：${name}`;};

document.querySelector('h1').textContent='投稿剪辑 · 生命周期验证';
document.querySelector('h1+p').textContent='本地合成音视频素材；真实应用界面、网络和浏览器媒体管线。';
document.getElementById('test').textContent='验证投稿生命周期';
document.getElementById('test').onclick=async()=>{
 document.getElementById('test').disabled=true;
 try{
  checks.length=0;
  await until(()=>pageVideo.readyState>=2,'页面视频可播放');pageVideo.currentTime=7;await pageVideo.play();
  await navigate(0);await app.open();await until(()=>editable()&&title(0),'打开第一投稿');
  await until(()=>$('pageMirror').width>0&&$('videoLoading').hidden,'镜像首帧');
  assert(!pageVideo.paused,'打开插件中断了页面播放');
  assert(!reads.some(item=>item.url),'打开面板不应请求任何预览媒体或缩略图');
  assert(!$('pageMirror').hidden&&$('fullVideo').hidden,'投稿仍使用独立播放器');
  assert($('recordMeta').textContent.includes('P1 · 测试分段 1'),'第一投稿分 P 错误');
  assert($('wholeRecordingLabel').hidden,'投稿仍显示直播整场入口');
  assert($('exportMode').hidden,'投稿不应提供导出模式选项');
  pass('打开面板不中断页面播放，镜像无需额外媒体请求');
  $('togglePlayback').click();assert(pageVideo.paused,'插件暂停没有控制页面');
  $('togglePlayback').click();await until(()=>!pageVideo.paused,'插件继续播放');
  $('close').click();assert(!pageVideo.paused,'关闭面板中断了页面播放');
  await app.open();assert(!pageVideo.paused,'重新打开中断了页面播放');
  pass('插件播放控制与开关面板保持页面播放意图');
  const timelineRect=$('timeline').getBoundingClientRect();
  const targetX=timelineRect.left+timelineRect.width*.7;
  const beginEvent=new PointerEvent('pointerdown',{button:0,pointerId:41,clientX:targetX,bubbles:true});
  // Synthetic pointer events have no native capture; stub only that DOM mechanic.
  const capture=$('timeline').setPointerCapture;$('timeline').setPointerCapture=()=>{};
  $('timeline').dispatchEvent(beginEvent);$('timeline').setPointerCapture=capture;
  const pageBeforePreview=pageVideo.currentTime;
  await until(()=>$('videoLoading').hidden&&$('pageMirror').width===320,'图集预览绘制');
  const previewPixel=$('pageMirror').getContext('2d').getImageData(0,0,1,1).data;
  assert(previewPixel[2]>previewPixel[0],'拖动没有显示对应的蓝色预览切片');
  assert(Math.abs(pageVideo.currentTime-pageBeforePreview)<2&&!pageVideo.paused,'拖动期间改变了页面播放进度或状态');
  $('timeline').dispatchEvent(new PointerEvent('pointerup',{pointerId:41,clientX:targetX,bubbles:true}));
  await until(()=>!pageVideo.seeking&&pageVideo.currentTime>=21&&pageVideo.currentTime<22,'松开后同步到拖动位置');
  pass('插件拖动时独立显示图集预览，松开后提交进度并恢复镜像');
  pageVideo.currentTime=7;await until(()=>!pageVideo.seeking,'恢复测试起点');

  const nativeTrack=document.createElement('div');nativeTrack.className='bpx-player-progress';nativeTrack.style.cssText='width:300px;height:12px';
  const nativeImage=new Image();nativeImage.className='bpx-player-progress-preview-image';nativeImage.src=sheetCanvas.toDataURL();
  const nativeTime=document.createElement('span');nativeTime.className='bpx-player-progress-preview-time';nativeTime.textContent='00:18';
  document.body.append(nativeTrack,nativeImage,nativeTime);await nativeImage.decode();
  nativeTrack.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:42,clientX:10,bubbles:true}));
  await until(()=>$('clock').textContent.startsWith('00:18'),'原生进度预览同步到插件');
  assert(pageVideo.currentTime<10,'原生预览阶段被插件强制跳转');
  nativeTrack.dispatchEvent(new PointerEvent('pointerup',{pointerId:42,bubbles:true}));pageVideo.currentTime=19;
  await until(()=>!pageVideo.seeking&&$('clock').textContent.startsWith('00:19'),'原生提交后恢复镜像');
  nativeTrack.remove();nativeImage.remove();nativeTime.remove();
  pass('B站进度条拖动复用原生预览图，最终跳转由原播放器完成');
  pageVideo.currentTime=7;await until(()=>!pageVideo.seeking,'回到标记测试起点');
  const beforeMark=pageVideo.currentTime;$('markStart').click();
  assert(!pageVideo.paused&&Math.abs(pageVideo.currentTime-beforeMark)<.2,'标记起点打断了正常观看');
  const beforeStep=pageVideo.currentTime;
  $('timeline').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  await until(()=>!pageVideo.seeking&&!pageVideo.paused,'时间轴定位后恢复播放');
  assert(Math.abs(pageVideo.currentTime-beforeStep-5)<.5,'插件时间轴没有同步定位页面视频');
  await until(()=>reads.some(item=>item.url),'操作后按需加载缩略图');
  pass('标记不中断观看，时间轴定位页面并恢复播放，缩略图按需读取');
  await navigate(1,2);await until(()=>editable()&&title(1)&&$('recordMeta').textContent.includes('P2 · 测试分段 2'),'第二投稿第二分 P');
  pass('切换不同投稿和非首分 P');

  delayedView={...gate(),bvid:ids[0]};
  await navigate(0);await until(()=>delayedView.reads.length>0,'延迟旧视频请求');
  await navigate(1,1);assert(delayedView.reads[0].signal.aborted,'切换视频没有取消旧加载');
  delayedView.release();delayedView=null;
  await until(()=>editable()&&title(1)&&$('recordMeta').textContent.includes('P1 · 测试分段 1'),'迟到结果后新视频');
  pass('旧请求迟到不能覆盖新视频');

  delayedView={...gate(),bvid:ids[1]};const canceledGate=delayedView;
  $('refreshEditor').click();await until(()=>canceledGate.reads.length>0,'元数据加载暂停点');
  $('cancel').click();$('close').click();canceledGate.release();delayedView=null;
  await until(()=>$('launcher').dataset.busy==='false','停止加载完成');
  await app.open();await until(()=>editable()&&title(1),'取消后关闭重开恢复');
  pass('元数据取消后关闭重开能恢复');

  delayedView={...gate(),bvid:ids[1]};const hiddenLoad=delayedView;
  $('refreshEditor').click();await until(()=>hiddenLoad.reads.length>0,'关闭前的加载请求');
  $('close').click();hiddenLoad.release();delayedView=null;
  await until(()=>$('launcher').dataset.busy==='false','隐藏面板完成加载');
  const hiddenClock=$('clock').textContent;
  pageVideo.currentTime=19;await until(()=>!pageVideo.seeking,'隐藏面板时页面跳转');
  assert($('clock').textContent===hiddenClock,'隐藏面板仍在刷新镜像');
  await app.open();await until(()=>$('clock').textContent.startsWith('00:19'),'重新打开追上页面进度');
  pass('加载中关闭面板后保持休眠，重开同步最新进度');

  assert($('exportMode').hidden,'切换视频后重新显示了模式选择');
  pageVideo.pause();pageVideo.currentTime=7.13;await until(()=>!pageVideo.seeking,'选区起点');$('markStart').click();
  pageVideo.currentTime=10.47;await until(()=>!pageVideo.seeking,'选区终点');$('markEnd').click();
  const pixels=$('pageMirror').getContext('2d').getImageData(0,0,$('pageMirror').width,$('pageMirror').height).data;
  assert(pixels.some((value,index)=>index%4!==3&&value>0),'镜像画面为空');
  $('playSelection').click();await until(()=>pageVideo.paused&&Math.abs(pageVideo.currentTime-10.47)<.05,'选段自动停止');
  await pageVideo.play();
  mediaGate=gate();const exportGate=mediaGate;
  $('download').click();await until(()=>exportGate.reads.length>0,'导出媒体读取');
  assert(!pageVideo.paused,'导出中断了页面播放');
  await navigate(0,2);
  assert(title(1),'导航改变了正在导出的标题');
  assert(!$('currentVideo').hidden,'导出期间未提供新当前视频入口');
  exportGate.release();mediaGate=null;
  await until(()=>$('downloads').querySelector('a')&&!$('download').disabled,'源视频导出完成');
  const link=$('downloads').querySelector('a');
  assert(link.download.startsWith('测试投稿 2_P1_测试分段 1'),'导出文件名跟随了新页面');
  const blob=await (await fetch(link.href)).blob(),info=await inspectMedia(blob);
  assert(info.hasAudio&&info.hasVideo&&Math.abs(info.duration-3.34)<.05,'投稿没有固定精确裁剪或丢失音视频');
  await fetch('/artifact/submission-navigation-export.mp4',{method:'POST',body:blob});
  pass('投稿无模式选项且固定精确裁剪，导出期间导航保持原视频、文件名及声音');

  $('currentVideo').click();await until(()=>editable()&&title(0),'主动载入新当前视频');
  assert($('recordMeta').textContent.includes('P2 · 测试分段 2'),'导出后当前视频分 P 错误');
  $('back').click();await until(()=>!$('library').hidden&&!$('currentVideo').disabled,'返回直播列表');
  assert(!$('currentVideo').hidden,'直播列表丢失当前视频入口');
  $('currentVideo').click();await until(()=>editable()&&title(0),'从列表返回当前视频');
  pass('直播列表与当前视频入口往返');

  $('close').click();await navigate(1,2);await app.open();await until(()=>editable()&&title(1)&&$('recordMeta').textContent.includes('P2'),'关闭期间导航后重开');
  pass('关闭期间换视频，重开重新核对身份');
  const replacement=document.createElement('video');replacement.src='/fixture.mp4';replacement.muted=true;replacement.controls=true;pageVideo.replaceWith(replacement);
  await until(()=>replacement.readyState>=2,'替换播放器就绪');replacement.currentTime=18;
  await until(()=>$('clock').textContent.startsWith('00:18'),'跟随替换后的播放器');
  $('togglePlayback').click();await until(()=>!replacement.paused,'控制替换后的播放器');
  pass('页面更换播放器节点后自动重新绑定');
  result.textContent=`通过：${checks.join('；')}`;
  await fetch('/artifact/submission-lifecycle-results.json',{method:'POST',body:JSON.stringify({passed:true,checks,export:info},null,2)});
 }catch(error){
  delayedView?.release();mediaGate?.release();delayedView=null;mediaGate=null;
  result.textContent='失败：'+error.message;
  await fetch('/artifact/submission-lifecycle-results.json',{method:'POST',body:JSON.stringify({passed:false,checks,error:error.stack},null,2)});
 }finally{document.getElementById('test').disabled=false;}
};
