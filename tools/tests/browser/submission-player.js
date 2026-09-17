import {createSubmissionPlayer,readSubmissionThumbnail} from '../../../src/media/submission-player.js';

const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const wait=(predicate,timeout=15000)=>new Promise((resolve,reject)=>{
 const deadline=performance.now()+timeout;
 const check=()=>{if(predicate())resolve();else if(performance.now()>deadline)reject(new Error('预览状态等待超时'));else setTimeout(check,25);};check();
});
function nextFrame(video){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{video.cancelVideoFrameCallback(id);reject(new Error('预览画面等待超时'));},15000);
  const id=video.requestVideoFrameCallback((_,metadata)=>{clearTimeout(timer);resolve(metadata.mediaTime);});
 });
}

export async function runSubmissionPlayerChecks({video,loading,request,submission,onProgress=()=>{}}){
 const statuses=[],frames=[],controller=new AbortController();
 let holdNext=false,held=false;
 const checkedRequest=async(url,options)=>{
  assert(options.range.length<=1024*1024,'预览请求超过读取窗口');
  if(holdNext){holdNext=false;held=true;await new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}
  return request(url,options);
 };
 const player=createSubmissionPlayer({video,loading,request:checkedRequest,status:message=>statuses.push(message),onTime:()=>{}});
 const audioContext=new AudioContext(),source=audioContext.createMediaElementSource(video),analyser=audioContext.createAnalyser(),gain=audioContext.createGain();
 gain.gain=0;source.connect(analyser);analyser.connect(gain);gain.connect(audioContext.destination);await audioContext.resume();
 let peak=0;
 try{
  onProgress('加载原生音视频预览');
  const first=nextFrame(video);await player.load(submission,controller.signal);frames.push({target:0,actual:await first});
  assert(video.videoWidth>0,'没有解码出视频');assert(frames[0].actual<.1,'第一帧时间发生偏移');
  onProgress('验证定位时取消旧请求');
  holdNext=true;held=false;player.seek(23.17);await wait(()=>held);
  const replacement=nextFrame(video);player.seek(13.43);await wait(()=>!video.seeking&&video.readyState>=2&&loading.hidden);
  assert(Math.abs(await replacement-13.43)<.08,'旧定位请求覆盖了新画面');
  for(const time of [11.31,2.27,16.19]){
   onProgress(`定位 ${time} 秒`);const frame=nextFrame(video);player.seek(time);
   await wait(()=>!video.seeking&&video.readyState>=2&&loading.hidden);
   const actual=await frame;frames.push({target:time,actual});assert(Math.abs(actual-time)<.08,'定位画面的时间不一致');
  }
  onProgress('验证连续播放与音轨');
  player.seek(7.9);await wait(()=>!video.seeking&&video.readyState>=2);
  await video.play();
  const samples=new Float32Array(analyser.fftSize),start=video.currentTime;
  await new Promise((resolve,reject)=>{
   const deadline=performance.now()+10000;
   const timer=setInterval(()=>{
    analyser.getFloatTimeDomainData(samples);peak=Math.max(peak,...samples.map(Math.abs));
    if(video.currentTime>=start+3){clearInterval(timer);resolve();}else if(performance.now()>deadline){clearInterval(timer);reject(new Error('连续播放停滞'));}
   },50);
  });video.pause();assert(peak>.001,'预览没有解码出声音');
  onProgress('验证快速跳转与独立缩略图');
  const finalFrame=nextFrame(video);player.seek(3.17);player.seek(17.83);player.seek(12.43);
  await wait(()=>!video.seeking&&video.readyState>=2);await finalFrame;
  assert(Math.abs(player.position()-12.43)<.1,'快速跳转被旧请求覆盖');
  const thumbnail=await readSubmissionThumbnail(request,submission,4.5,controller.signal);assert(thumbnail.width===160,'缩略图尺寸错误');
  const buffered=Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)]);
  assert(buffered.reduce((sum,[start,end])=>sum+end-start,0)<40,'预览缓存没有限制');
  assert(!statuses.length,`预览报告错误：${statuses.join(';')}`);
  player.clear();assert(!video.getAttribute('src'),'清理未释放视频源');
  onProgress('验证取消后立即重新加载');
  holdNext=true;held=false;
  const pending=player.load(submission,controller.signal).then(()=>({canceled:false}),error=>({canceled:error.name==='AbortError'}));
  await wait(()=>held);player.clear();
  await player.load(submission,controller.signal);
  assert((await pending).canceled,'取消没有中断旧请求');assert(video.readyState>=2,'取消后重新加载失败');
  return {frames,audioPeak:peak,buffered,thumbnail:[thumbnail.width,thumbnail.height],cleared:true,cancelRetry:true};
 }finally{controller.abort();player.destroy();await audioContext.close();}
}
