// Playback stays inside the selection; scrubbing preserves playback intent.
export function createPlayback(video, onError, {getRange,position,seek}) {
 let scrubbing=false,resume=false,timer;
 const clearTimer=()=>{clearTimeout(timer);timer=undefined;};
 // pause() and source reloads abort pending play requests during normal interaction.
 const playVideo=()=>video.play().catch(error=>{if(error.name!=='AbortError')onError(error.message,true);});
 function constrain(restart=false){
  const range=getRange();if(!range)return true;
  const time=position();
  if(time>=range.end&&!restart){
   clearTimer();video.pause();if(time!==range.end)seek(range.end);return false;
  }
  if(time<range.start||time>=range.end)seek(range.start);
  return true;
 }
 const play=(restart=false)=>{if(constrain(restart))void playVideo();};
 function check(){
  clearTimer();
  if(scrubbing||video.paused||video.seeking||video.readyState<2)return;
  const range=getRange();if(!range)return;
  if(position()<range.start){play();return;}
  if(!constrain())return;
  // timeupdate is sparse; schedule the stop against the remaining playback time.
  if(video.playbackRate>0)timer=setTimeout(check,(range.end-position())/video.playbackRate*1000);
 }
 video.addEventListener('play',()=>{
  if(scrubbing||video.paused||video.seeking||video.readyState<2)return;
  if(constrain(true)&&video.paused)void playVideo();
  check();
 });
 for(const event of ['playing','timeupdate','seeked','ratechange'])video.addEventListener(event,check);
 for(const event of ['pause','waiting','emptied','ended'])video.addEventListener(event,clearTimer);
 return {
  check,
  begin(){clearTimer();resume=!video.paused&&!video.ended;scrubbing=true;video.pause();},
  end(){if(!scrubbing)return;scrubbing=false;if(resume)play();resume=false;},
  cancel(){clearTimer();scrubbing=false;resume=false;video.pause();},
  toggle(){if(video.paused)play(true);else video.pause();},
 };
}

// Leave fullscreen gestures and controls to the browser.
export function bindVideoControls(video, playback, onError) {
 const fullscreen=()=>video.getRootNode().fullscreenElement===video;
 const sync=()=>{video.controls=fullscreen();};
 video.ownerDocument.addEventListener('fullscreenchange',sync);
 video.addEventListener('click',event=>{
  if(!fullscreen()&&event.detail===1)playback.toggle();
 });
 video.addEventListener('dblclick',()=>{
  if(!fullscreen())void video.requestFullscreen().catch(error=>onError(error.message,true));
 });
 sync();
}
