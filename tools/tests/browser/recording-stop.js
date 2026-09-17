import {createApp} from '../../../src/app/application.js';
import {Input,BlobSource,MP4} from 'mediabunny';

export async function runRecordingStopChecks(){
 const out=document.getElementById('result'),writes=[];
 const assert=(ok,message)=>{if(!ok)throw new Error(message);};
 const until=async predicate=>{for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('等待停止保存超时');};
 const source=await(await fetch('/raw.m4s')).blob();
 const input=new Input({source:new BlobSource(source),formats:[MP4]});
 const duration=await input.computeDuration();input.dispose();
 const record={key:'stop-test',title:'停止保存验证',start:1000,end:1000+duration*4,live:false,uid:1,member:'贝拉',room:22632424};
 const manifest=['#EXTM3U','#EXT-X-VERSION:7',`#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,...Array.from({length:4},(_,i)=>`${i?'#EXT-X-DISCONTINUITY\n':''}#EXTINF:${duration},\n/raw.m4s?part=${i}`),'#EXT-X-ENDLIST'].join('\n');
 let app,stopped=false,closed=false,aborted=false,phaseLocked=false;
 const api={history:async()=>[record],current:async()=>null,clips:async()=>[{stream:location.origin+'/stop.m3u8',start_time:record.start,end_time:record.end}],async request(url,{type,signal}={}){
  signal?.throwIfAborted();
  if(url.endsWith('/stop.m3u8'))return {data:manifest,url};
  if(new URL(url).origin===location.origin)return {data:type==='arraybuffer'?await source.arrayBuffer():manifest,url};
  throw new Error('验证页不读取外部服务');
 }};
 try{
  app=createApp({api,pageUrl:location.origin,saveFilePicker:async()=>({async createWritable(){return{
   async write(chunk){
    writes.push({...chunk,data:chunk.data.slice()});
    if(!stopped){stopped=true;const button=app.root.getElementById('cancel');assert(button.textContent==='停止','停止按钮文案错误');button.click();phaseLocked=button.disabled;}
   },async close(){closed=true;},async abort(){aborted=true;},
  };}})});
  await app.open();const $=id=>app.root.getElementById(id);
  await until(()=>app.root.querySelector('.record-card')&&!$('refreshLibrary').disabled);
  app.root.querySelector('.record-card').click();
  await until(()=>!$('download').disabled);
  $('wholeRecording').click();$('download').click();
  await until(()=>closed||aborted||$('status').dataset.error==='true');
  await until(()=>!$('download').disabled);
  assert(closed&&!aborted&&phaseLocked,'停止必须锁定按钮并提交文件，不能中止写盘');
  assert($('status').textContent==='已停止。','不能把部分保存标记为整场完成');
  assert($('downloads').textContent.includes('已完成部分'),'必须显示部分保存结果');
  const data=new Uint8Array(Math.max(...writes.map(c=>c.position+c.data.length)));for(const c of writes)data.set(c.data,c.position);
  const blob=new Blob([data],{type:'video/mp4'}),saved=new Input({source:new BlobSource(blob),formats:[MP4]});
  const savedDuration=await saved.computeDuration();
  assert(await saved.getPrimaryAudioTrack()&&await saved.getPrimaryVideoTrack(),'部分文件必须保留音画');
  assert(Math.abs(savedDuration-duration)<.1,'必须完整保存正在写入的首个分片');saved.dispose();
  await fetch('/artifact/stopped-browser.mp4',{method:'POST',body:blob});
  const video=document.createElement('video'),url=URL.createObjectURL(blob);video.src=url;video.muted=true;video.playbackRate=8;document.body.append(video);
  try{await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('部分文件播放超时')),30000);
   video.onended=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(new Error(video.error?.message));};video.play().catch(reject);
  });}finally{video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}
  const result={passed:true,stopped,closed,aborted,phaseLocked,duration:savedDuration,bytes:blob.size,played:true,status:$('status').textContent};
  await fetch('/artifact/stop-results.json',{method:'POST',body:JSON.stringify(result,null,2)});out.textContent=JSON.stringify(result);
 }catch(error){out.textContent=error.message;await fetch('/artifact/stop-results.json',{method:'POST',body:JSON.stringify({passed:false,error:error.stack})});}
 finally{app?.root.getElementById('close').click();app?.root.host.remove();}
}
