// Scrubbing temporarily pauses decoding; release restores the user's playback intent.
export function createPlayback(video, onError) {
 let scrubbing=false,resume=false;
 const play=()=>video.play().catch(error=>onError(error.message,true));
 return {
  begin(){resume=!video.paused&&!video.ended;scrubbing=true;video.pause();},
  end(){if(!scrubbing)return;scrubbing=false;if(resume)void play();resume=false;},
  cancel(){scrubbing=false;resume=false;video.pause();},
  toggle(){if(video.paused)void play();else video.pause();},
 };
}
