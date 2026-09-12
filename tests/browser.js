import { createApp } from '../src/app.js';
import { convertMp4, inspectMedia, exportSelection } from '../src/media.js';
const record={key:'987654321098765432',title:'浏览器验证 · 真实直播素材',start:1789213000,end:1789213024,live:false,uid:1,member:'贝拉',room:22632424};
const api={history:async member=>Array.from({length:6},(_,i)=>({...record,key:String(987654321000+i),member:member.name,title:['【3D】今晚一起唱歌','【突击】看看测试服！','周末的轻松时光'][i%3],start:record.start-i*86400,end:record.end-i*86400})),current:async()=>({...record,live:true}),clips:async r=>[{stream:location.origin+'/fixture.m3u8',start_time:r.start,end_time:r.start+24}],request:async(url,{type,signal}={})=>{const response=await fetch(url,{signal});return {data:type==='arraybuffer'?await response.arrayBuffer():await response.text(),url:response.url};}};
const app=createApp({api,pageUrl:new URLSearchParams(location.search).has('live')?'https://live.bilibili.com/22632424':location.href}); app.open();
document.getElementById('test').onclick=async()=>{
 const out=document.getElementById('result');out.textContent='正在验证浏览器重封装和精确裁剪…';
 try {
 const outputs=await exportSelection(api,record,await api.clips(record),{start:3.1,end:10.4},{signal:new AbortController().signal});const exported=await inspectMedia(outputs[0].blob);if(Math.abs(exported.duration-7.3)>.15)throw new Error('选区导出时长错误');await fetch('/artifact/v2-export.mp4',{method:'POST',body:outputs[0].blob});
 const blob=await (await fetch('/fixture.mp4')).blob();const normalized=await convertMp4(blob);const cases=[];
 for(const [start,end,precise] of [[3.1,10.4,false],[5.123,8.754,false],[1.25,3.75,true]]){
 const output=await convertMp4(normalized,{start,end,precise});const info=await inspectMedia(output);
 if(!info.hasAudio||!info.hasVideo||Math.abs(info.duration-(end-start))>.15)throw new Error(JSON.stringify(info));
 await fetch(`/artifact/${precise?'precise':'copy'}-${start}.mp4`,{method:'POST',body:output});cases.push({start,end,precise,...info,bytes:output.size});
 }
 await fetch('/artifact/browser-results.json',{method:'POST',body:JSON.stringify({passed:true,cases},null,2)});out.textContent='通过：浏览器内两组无损裁剪、一组精确编码，均保留声音与画面。';
 }catch(e){out.textContent='失败：'+e.message;await fetch('/artifact/browser-results.json',{method:'POST',body:JSON.stringify({passed:false,error:e.stack})});}
};
