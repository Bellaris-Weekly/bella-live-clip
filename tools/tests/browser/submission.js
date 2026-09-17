import {createApp} from '../../../src/app/application.js';
import metadata from '../../../src/header.txt';
import {inspectMedia} from '../support/media-info.mjs';

const ids=['BV1SNYq6gEQh','BV1xx411c7mD'];
const route=(index,part=1)=>`https://www.bilibili.com/video/${ids[index]}/?p=${part}`;
let pageUrl=route(0),delayedView=null,mediaGate=null;
const reads=[],checks=[];
const result=document.getElementById('result');
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
  await until(()=>Math.abs($('fullVideo').currentTime-7)<1,'沿用页面播放位置');
  assert(pageVideo.paused,'进入剪辑没有暂停页面视频');
  assert($('recordMeta').textContent.includes('P1 · 测试分段 1'),'第一投稿分 P 错误');
  assert($('wholeRecordingLabel').hidden,'投稿仍显示直播整场入口');
  pass('第一投稿载入，保留播放位置并暂停页面视频');
  await navigate(1,2);await until(()=>editable()&&title(1)&&$('recordMeta').textContent.includes('P2 · 测试分段 2'),'第二投稿第二分 P');
  pass('切换不同投稿和非首分 P');

  delayedView={...gate(),bvid:ids[0]};
  await navigate(0);await until(()=>delayedView.reads.length>0,'延迟旧视频请求');
  await navigate(1,1);assert(delayedView.reads[0].signal.aborted,'切换视频没有取消旧加载');
  delayedView.release();delayedView=null;
  await until(()=>editable()&&title(1)&&$('recordMeta').textContent.includes('P1 · 测试分段 1'),'迟到结果后新视频');
  pass('旧请求迟到不能覆盖新视频');

  mediaGate=gate();const canceledGate=mediaGate;
  $('refreshEditor').click();await until(()=>canceledGate.reads.length>0,'预览加载暂停点');
  $('cancel').click();$('close').click();canceledGate.release();mediaGate=null;
  await until(()=>$('launcher').dataset.busy==='false','停止加载完成');
  await app.open();await until(()=>editable()&&title(1),'取消后关闭重开恢复');
  pass('预览取消后关闭重开能恢复');

  mediaGate=gate();const exportGate=mediaGate;
  $('download').click();await until(()=>exportGate.reads.length>0,'导出媒体读取');
  await navigate(0,2);
  assert(title(1),'导航改变了正在导出的标题');
  assert(!$('currentVideo').hidden,'导出期间未提供新当前视频入口');
  exportGate.release();mediaGate=null;
  await until(()=>$('downloads').querySelector('a')&&!$('download').disabled,'源视频导出完成');
  const link=$('downloads').querySelector('a');
  assert(link.download.startsWith('测试投稿 2_P1_测试分段 1'),'导出文件名跟随了新页面');
  const blob=await (await fetch(link.href)).blob(),info=await inspectMedia(blob);
  assert(info.hasAudio&&info.hasVideo&&info.duration>29,'导出没有保留完整音视频');
  await fetch('/artifact/submission-navigation-export.mp4',{method:'POST',body:blob});
  pass('导出期间导航保持原视频、文件名及声音');

  $('currentVideo').click();await until(()=>editable()&&title(0),'主动载入新当前视频');
  assert($('recordMeta').textContent.includes('P2 · 测试分段 2'),'导出后当前视频分 P 错误');
  $('back').click();await until(()=>!$('library').hidden&&!$('currentVideo').disabled,'返回直播列表');
  assert(!$('currentVideo').hidden,'直播列表丢失当前视频入口');
  $('currentVideo').click();await until(()=>editable()&&title(0),'从列表返回当前视频');
  pass('直播列表与当前视频入口往返');

  $('close').click();await navigate(1,2);await app.open();await until(()=>editable()&&title(1)&&$('recordMeta').textContent.includes('P2'),'关闭期间导航后重开');
  pass('关闭期间换视频，重开重新核对身份');
  result.textContent=`通过：${checks.join('；')}`;
  await fetch('/artifact/submission-lifecycle-results.json',{method:'POST',body:JSON.stringify({passed:true,checks,export:info},null,2)});
 }catch(error){
  delayedView?.release();mediaGate?.release();delayedView=null;mediaGate=null;
  result.textContent='失败：'+error.message;
  await fetch('/artifact/submission-lifecycle-results.json',{method:'POST',body:JSON.stringify({passed:false,checks,error:error.stack},null,2)});
 }finally{document.getElementById('test').disabled=false;}
};
