// Inline playback stays inside the selection; fullscreen plays the whole video.
// Seeks can land slightly short of a cut point (stream ends are clamped), so
// positions within EDGE of a cut count as being on it.
const EDGE = 0.05;
const isVideoFullscreen = video => {
  const element = video.getRootNode?.().fullscreenElement;
  return element === video || Boolean(element?.contains?.(video));
};
export function createPlayback(video, onError, {getRange, position, seek}) {
  let scrubbing = false,
    resume = false,
    timer;
  const playbackRange = () => (isVideoFullscreen(video) ? null : getRange());
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  // pause() and source reloads abort pending play requests during normal interaction.
  const playVideo = () =>
    video.play().catch(error => {
      if (error.name !== 'AbortError') onError(error.message, true);
    });
  function constrain(restart = false) {
    const range = playbackRange();
    if (!range) return true;
    const time = position();
    const atEnd = time >= range.end - EDGE;
    if (atEnd && !restart) {
      clearTimer();
      video.pause();
      if (time !== range.end) seek(range.end);
      return false;
    }
    if (time < range.start - EDGE || atEnd) seek(range.start);
    return true;
  }
  const play = (restart = false) => {
    if (constrain(restart)) void playVideo();
  };
  function check() {
    clearTimer();
    if (scrubbing || video.paused || video.seeking || video.readyState < 2) return;
    const range = playbackRange();
    if (!range) return;
    if (position() < range.start - EDGE) {
      play();
      return;
    }
    if (!constrain()) return;
    // timeupdate is sparse; schedule the stop against the remaining playback time.
    if (video.playbackRate > 0) timer = setTimeout(check, ((range.end - position()) / video.playbackRate) * 1000);
  }
  video.addEventListener('play', () => {
    if (scrubbing || video.paused || video.seeking || video.readyState < 2) return;
    if (constrain(true) && video.paused) void playVideo();
    check();
  });
  for (const event of ['playing', 'timeupdate', 'seeked', 'ratechange']) video.addEventListener(event, check);
  for (const event of ['pause', 'waiting', 'emptied', 'ended']) video.addEventListener(event, clearTimer);
  video.ownerDocument?.addEventListener('fullscreenchange', check);
  return {
    check,
    begin() {
      clearTimer();
      resume = !video.paused && !video.ended;
      scrubbing = true;
      video.pause();
    },
    end() {
      if (!scrubbing) return;
      scrubbing = false;
      if (resume) play();
      resume = false;
    },
    cancel() {
      clearTimer();
      scrubbing = false;
      resume = false;
      video.pause();
    },
    toggle() {
      if (video.paused) play(true);
      else video.pause();
    },
  };
}

// Keep native media controls, but include the overlay in the fullscreen tree.
export function bindVideoControls(video, playback, onError, {fullscreenTarget = video, exitButton} = {}) {
  const fullscreen = () => isVideoFullscreen(video);
  const sync = () => {
    video.controls = fullscreen();
    // The native fullscreen button targets only <video>, excluding siblings.
    if (fullscreenTarget !== video) video.controlsList?.add('nofullscreen');
  };
  exitButton?.addEventListener('click', () => {
    if (fullscreen()) void video.ownerDocument.exitFullscreen().catch(error => onError(error.message, true));
  });
  video.ownerDocument.addEventListener('fullscreenchange', sync);
  video.addEventListener('click', event => {
    if (!fullscreen() && event.detail === 1) playback.toggle();
  });
  video.addEventListener('dblclick', () => {
    if (!fullscreen()) void fullscreenTarget.requestFullscreen().catch(error => onError(error.message, true));
  });
  sync();
}
