// Scrubbing temporarily pauses decoding; release restores the user's playback intent.
export function createPlayback(video, onError) {
 let scrubbing=false,resume=false;
 // pause() and source reloads abort pending play requests during normal interaction.
 const play=()=>video.play().catch(error=>{if(error.name!=='AbortError')onError(error.message,true);});
 return {
  begin(){resume=!video.paused&&!video.ended;scrubbing=true;video.pause();},
  end(){if(!scrubbing)return;scrubbing=false;if(resume)void play();resume=false;},
  cancel(){scrubbing=false;resume=false;video.pause();},
  toggle(){if(video.paused)void play();else video.pause();},
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
