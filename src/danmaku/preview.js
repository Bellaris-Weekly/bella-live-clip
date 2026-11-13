import {streamOrigin} from './clock.js';
import {readPartClock} from '../media/replay-clock.js';

// Video keeps its native playback path. Only the transparent comment layer is
// painted here, and asynchronous archive/emote work never holds up the video.
export function createDanmakuPreview({video, canvas, getFrame, onError = () => {}}) {
  let enabled = false,
    scrubbing = false,
    configuration,
    source,
    session,
    animation = null,
    destroyed = false;

  function resetSession() {
    canvas.hidden = true;
    const previous = session;
    session = null;
    closeSession(previous);
  }
  function closeSession(own) {
    if (!own || own.closed) return;
    own.closed = true;
    own.controller.abort();
    // The layout and emote decoders belong to this seek; archives belong to
    // the source and remain reusable until preview is released.
    void own.promise.then(compositor => compositor.close()).catch(() => {});
  }
  function release() {
    resetSession();
    source?.controller.abort();
    void source?.comments?.then(({reader}) => reader.close()).catch(() => {});
    source = null;
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
    canvas.width = canvas.height = 1;
  }
  function getSource() {
    if (!source) {
      const controller = new AbortController();
      const modules = Promise.all([
        import('./archive.js'),
        import('./parquet.js'),
        import('./streaming-compositor.js'),
      ]);
      source = {...configuration, controller, modules, comments: null, clocks: new Map(), notified: false};
    }
    return source;
  }
  function commentsFor(owner) {
    owner.comments ??= owner.modules
      .then(async ([{prepareComments, createCommentReader}]) => {
        const signal = owner.controller.signal;
        signal.throwIfAborted();
        const archive = await prepareComments(owner.record, {signal});
        signal.throwIfAborted();
        const reader = createCommentReader(owner.record, {
          signal,
          prepared: archive,
          waitForCoverage: false,
          maxArchiveBytes: 32 * 1024 * 1024,
        });
        return {archive, reader};
      })
      .catch(error => {
        // A later seek retries preparation after a transient outage or an
        // archive that has only just become available.
        owner.comments = null;
        throw error;
      });
    return owner.comments;
  }
  async function prepare(owner, frame, width, height, signal) {
    const key = frame.part.start_time;
    if (!owner.clocks.has(key)) {
      const clock = (async () => {
        const groups = await owner.loadGroups(owner.controller.signal);
        const group = groups.find(group => group.part.start_time === key);
        if (!group) throw new Error('无法读取弹幕预览对应的录像分段。');
        return readPartClock(owner.request, group, owner.controller.signal);
      })().catch(error => {
        owner.clocks.delete(key);
        throw error;
      });
      owner.clocks.set(key, clock);
    }
    const [{archive, reader}, clock, [, {streamClock}, {createStreamingCompositor}]] = await Promise.all([
      commentsFor(owner),
      owner.clocks.get(key),
      owner.modules,
    ]);
    signal.throwIfAborted();
    const origin = streamOrigin(streamClock(archive.metadata), clock.origin) ?? clock.origin;
    return await createStreamingCompositor(owner.record, {
      reader: {
        read: window => reader.read({...window, signal}),
        close() {}, // Only release() closes the source's shared reader.
      },
      origin,
      start: frame.time,
      sourceTime: time => time,
      width,
      height,
      signal,
    });
  }
  function startSession(frame) {
    resetSession();
    const owner = getSource();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, owner.controller.signal]);
    // A preview-sized bitmap preserves proportions and type while bounding the
    // cost of overlay drawing on high-resolution recordings.
    const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale)),
      height = Math.max(1, Math.round(video.videoHeight * scale));
    const own = {
      owner,
      controller,
      signal,
      generation: frame.generation,
      part: frame.part.start_time,
      width,
      height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      time: frame.time,
      drawn: null,
      busy: false,
      failed: false,
    };
    own.promise = prepare(owner, frame, width, height, signal);
    void own.promise.catch(error => fail(own, error));
    session = own;
    return own;
  }
  function fail(own, error) {
    if (session !== own || own.signal.aborted || own.failed) return;
    own.failed = true;
    canvas.hidden = true;
    closeSession(own);
    if (!own.owner.notified) {
      own.owner.notified = true;
      onError(error);
    }
  }
  async function draw(own, frame) {
    own.busy = true;
    try {
      const compositor = await own.promise;
      own.signal.throwIfAborted();
      await compositor.prepare(frame.time);
      own.signal.throwIfAborted();
      // A slow read must never put old comments over a newer frame. Keep its
      // layout progress and catch up on the next animation tick instead.
      const current = getFrame();
      if (!current || current.generation !== own.generation || Math.abs(current.time - frame.time) > 0.1) return;
      const overlay = compositor.renderOverlay(frame.time);
      if (canvas.width !== own.width || canvas.height !== own.height) {
        canvas.width = own.width;
        canvas.height = own.height;
      }
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(overlay, 0, 0);
      own.drawn = frame.time;
      canvas.hidden = false;
    } catch (error) {
      fail(own, error);
    } finally {
      own.busy = false;
      if (session === own && !own.failed) {
        const current = getFrame();
        if (!video.paused || (current && current.time !== own.drawn)) schedule();
      }
    }
  }
  function tick() {
    animation = null;
    if (!enabled || !configuration || scrubbing || destroyed || document.hidden) return;
    const frame = getFrame();
    if (!frame || !video.videoWidth || !video.videoHeight) canvas.hidden = true;
    else {
      if (
        !session ||
        session.generation !== frame.generation ||
        session.part !== frame.part.start_time ||
        session.videoWidth !== video.videoWidth ||
        session.videoHeight !== video.videoHeight ||
        frame.time < session.time - 0.02 ||
        frame.time > session.time + 1
      )
        startSession(frame);
      const own = session;
      own.time = frame.time;
      if (own.drawn !== null && Math.abs(frame.time - own.drawn) > 0.15) canvas.hidden = true;
      if (!own.busy && !own.failed && own.drawn !== frame.time) void draw(own, frame);
    }
    if (!video.paused) schedule();
  }
  function schedule() {
    if (enabled && configuration && !scrubbing && !destroyed && !document.hidden && animation === null)
      animation = requestAnimationFrame(tick);
  }
  function seeking() {
    resetSession();
    schedule();
  }
  function visibility() {
    if (document.hidden) release();
    else schedule();
  }
  const events = ['play', 'playing', 'pause', 'seeked', 'loadeddata', 'resize'];
  for (const event of events) video.addEventListener(event, schedule);
  video.addEventListener('seeking', seeking);
  video.addEventListener('emptied', seeking);
  document.addEventListener('visibilitychange', visibility);
  return {
    setSource(next) {
      release();
      configuration = next;
      schedule();
    },
    setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      if (enabled) schedule();
      else release();
    },
    setScrubbing(next) {
      scrubbing = next;
      if (next) resetSession();
      else schedule();
    },
    clear() {
      configuration = null;
      scrubbing = false;
      release();
    },
    destroy() {
      destroyed = true;
      this.clear();
      for (const event of events) video.removeEventListener(event, schedule);
      video.removeEventListener('seeking', seeking);
      video.removeEventListener('emptied', seeking);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
