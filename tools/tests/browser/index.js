import scriptMetadata from '../../../src/header.txt';
import { createApp } from '../../../src/app/application.js';
import {MEMBERS} from '../../../src/domain/records.js';
import {runCardChecks} from './cards.js';
import {runSessionChecks} from './session.js';
import {runExportChecks} from './export.js';
import {inspectMedia} from '../support/media-info.mjs';
import {RecordingPlan} from '../../../src/media/recording-plan.js';
import { convertMp4, exportSelection } from '../../../src/media/export.js';
const record={key:'987654321098765432',title:'浏览器验证 · 真实直播素材',start:1789213000,end:1789213024,live:false,uid:1,member:'贝拉',room:22632424};
const query=new URLSearchParams(location.search);
const mediaReads=[];
const preloadProbe={historyCalls:0,historyStartedAt:[],openCalledAt:null};
if(query.has('timeline'))record.end=record.start+4976;
const historyFor=member=>Array.from({length:6},(_,i)=>({...record,key:String(987654321000+i),uid:member.uid,room:member.room,member:member.name,title:['【3D】今晚一起唱歌','【突击】看看测试服！','周末的轻松时光','【双播】一起度过周末的夜晚','一个很长的原标题，用来确认多行显示时卡片中的日期、实际时长与头像仍然整齐','这场没有匹配日程'][i],start:record.start-i*86400,end:record.end-i*86400}));
const faces={672353429:'https://i2.hdslb.com/bfs/face/3ccbfd77f000cf3154762b78694724cd9e6719e5.jpg',672328094:'https://i2.hdslb.com/bfs/face/9ea3dfdcf336f9dee7f763d9f9b0a0b427bb0fa9.jpg',672342685:'https://i1.hdslb.com/bfs/face/d7dac0d2c7a42b1ef9b018c2186092f5cd650a97.jpg'};
const calendar='BEGIN:VCALENDAR\r\n'+MEMBERS.slice(0,3).flatMap(member=>historyFor(member).slice(0,5).map((r,i)=>{
 const kind=['团播','突击','单播','双播','单播'][i],people=i===0?'贝拉、嘉然、乃琳':i===3?'贝拉、乃琳':member.name;
 return `BEGIN:VEVENT\r\nUID:${member.id}-${i}\r\nSUMMARY:日程主题不应该替换原标题\r\nDTSTART:${new Date(r.start*1000).toISOString().replace(/[-:]/g,'').replace('.000','')}\r\nDURATION:PT1H\r\nDESCRIPTION:${kind} | ${people}\\n\\n直播间：https://live.bilibili.com/${member.room}\r\nURL:https://live.bilibili.com/${member.room}\r\nEND:VEVENT\r\n`;
})).join('')+'END:VCALENDAR';
const api={history:async member=>{preloadProbe.historyCalls++;preloadProbe.historyStartedAt.push(performance.now());return historyFor(member);},current:async(member,signal,{allowOffline=false}={})=>allowOffline?(query.has('live-library')?{...historyFor(member)[0],live:true}:null):({...record,live:true}),clips:async r=>[{stream:location.origin+'/fixture.m3u8',start_time:r.start,end_time:r.start+24}],request:async(url,{type,signal}={})=>{
 if(url.startsWith('https://share.bellaris.fans/')){
  if(query.has('update-error'))throw new Error('模拟更新源不可用');
  return {data:query.has('update-available')?scriptMetadata.replace(/@version\s+\S+/, '@version 99.0.0'):scriptMetadata,url};
 }
 if(url.startsWith('https://calendar.bk0717.us.ci/')){
  await new Promise(resolve=>setTimeout(resolve,query.has('slow-schedule')?1200:100));signal?.throwIfAborted();
  if(query.has('schedule-error'))throw new Error('模拟日程不可用');
  return {data:calendar,url};
 }
 if(url.startsWith('https://api.live.bilibili.com/live_user/')){signal?.throwIfAborted();const uid=new URL(url).searchParams.get('uid');return {data:JSON.stringify({code:0,data:{info:{face:query.has('avatar-error')&&uid==='672328094'?location.origin+'/missing-avatar.png':faces[uid]}}}),url};}
 const read=url.endsWith('/raw.m4s')?{signal,settled:false}:null;
 if(read)mediaReads.push(read);
 try{
  if(read&&query.has('slow-media'))await new Promise(resolve=>setTimeout(resolve,1200));
  signal?.throwIfAborted();
  const response=await fetch(url,{signal});return {data:type==='arraybuffer'?await response.arrayBuffer():await response.text(),url:response.url};
 }finally{if(read)read.settled=true;}
}};
const app=createApp({api,pageUrl:query.has('live')?'https://live.bilibili.com/22632424':location.href,get:(key,fallback)=>key==='windowV2'&&(query.has('narrow')||query.has('medium'))?{left:20,top:20,width:query.has('medium')?480:360,height:780}:fallback});
preloadProbe.openCalledAt=performance.now();app.open();
const cardTest=document.createElement('button');cardTest.textContent='验证场次卡片';cardTest.id='cardTest';document.getElementById('test').after(cardTest);
cardTest.onclick=()=>runCardChecks(app,query,preloadProbe);
const exportTest=document.createElement('button');exportTest.textContent='精确导出对比';cardTest.after(exportTest);
exportTest.onclick=()=>runExportChecks();
if(query.has('slow-media')){
 const sessionTest=document.createElement('button');sessionTest.textContent='验证场次清理与刷新';cardTest.after(sessionTest);
 sessionTest.onclick=()=>runSessionChecks(app,mediaReads);
}
document.getElementById('test').onclick=async()=>{
 const out=document.getElementById('result');out.textContent='正在验证浏览器重封装和精确裁剪…';
 try {
 const outputs=await exportSelection(api,record,await new RecordingPlan(api,await api.clips(record)).load(),{start:3.1,end:10.4},{signal:new AbortController().signal});const exported=await inspectMedia(outputs[0].blob);if(Math.abs(exported.duration-7.3)>.15)throw new Error('选区导出时长错误');await fetch('/artifact/v2-export.mp4',{method:'POST',body:outputs[0].blob});
 const blob=await (await fetch('/fixture.mp4')).blob();const normalized=await convertMp4(blob);const cases=[];
 for(const [start,end,precise] of [[3.1,10.4,false],[5.123,8.754,false],[1.25,3.75,true]]){
 const output=await convertMp4(normalized,{start,end,precise});const info=await inspectMedia(output);
 if(!info.hasAudio||!info.hasVideo||Math.abs(info.duration-(end-start))>.15)throw new Error(JSON.stringify(info));
 await fetch(`/artifact/${precise?'precise':'copy'}-${start}.mp4`,{method:'POST',body:output});cases.push({start,end,precise,...info,bytes:output.size});
 }
 await fetch('/artifact/browser-results.json',{method:'POST',body:JSON.stringify({passed:true,cases},null,2)});out.textContent='通过：浏览器内两组无损裁剪、一组精确编码，均保留声音与画面。';
 }catch(e){out.textContent='失败：'+e.message;await fetch('/artifact/browser-results.json',{method:'POST',body:JSON.stringify({passed:false,error:e.stack})});}
};
