import {streamOrigin} from './clock.js';
import {readPartClock} from '../media/replay-clock.js';
import {createExportMetrics} from '../media/export-metrics.js';

// Video keeps its native playback path. Only the transparent comment layer is
// painted here, and asynchronous archive/emote work never holds up the video.
export function createDanmakuPreview({video, canvas, getFrame, onError = () => {}, onDiagnostic = () => null}) {
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
    source?.report?.diagnostic?.finish({status: 'canceled'});
    source?.report?.metrics.close();
    source?.metrics.close();
    source?.controller.abort();
    void source?.comments?.then(({reader}) => reader.close()).catch(() => {});
    void source?.emotes?.then(cache => cache.close()).catch(() => {});
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
        import('./preview-emotes.js'),
      ]);
      source = {...configuration, controller, modules, comments: null, clocks: new Map(), notified: false};
      const owner = source;
      owner.metrics = createExportMetrics();
      beginReport(owner, false);
      owner.emotes = modules.then(([, , , {createPreviewEmoteCache}]) => {
        controller.signal.throwIfAborted();
        return createPreviewEmoteCache(owner.record.room, {signal: controller.signal});
      });
      void owner.emotes.catch(() => {});
    }
    return source;
  }
  function beginReport(owner, resumed) {
    const metrics = resumed ? createExportMetrics() : owner.metrics;
    const diagnostic = onDiagnostic(owner.record, resumed);
    diagnostic?.observe(metrics);
    diagnostic?.stage(resumed ? 'resuming' : 'preparing');
    owner.report = {metrics, diagnostic};
  }
  function reportReady(owner) {
    if (!owner.report) return;
    owner.report.metrics.firstFrame();
    owner.report.diagnostic?.finish();
    owner.report.metrics.close();
    owner.report = null;
  }
  function warmSource() {
    if (!enabled || !configuration || destroyed || document.hidden) return;
    const owner = getSource();
    // Start independent downloads while the video is still buffering. Warmup
    // failures are observed here and retried/reported by the demanded frame.
    void commentsFor(owner).catch(() => {});
    owner.catalogWarm ??= owner.emotes
      .then(cache => {
        const finish = owner.metrics.start('emoteCatalog');
        return cache.catalog(owner.controller.signal).finally(finish);
      })
      .catch(() => {
        owner.catalogWarm = null;
      });
    if (owner.part) void clockFor(owner, owner.part).catch(() => {});
  }
  function commentsFor(owner) {
    owner.comments ??= owner.modules
      .then(async ([{prepareComments, createCommentReader}]) => {
        const signal = owner.controller.signal;
        signal.throwIfAborted();
        const finish = owner.metrics.start('archiveSetup');
        let archive;
        try {
          archive = await prepareComments(owner.record, {signal});
        } finally {
          finish();
        }
        signal.throwIfAborted();
        const initialMetadata = archive.metadata;
        const reader = createCommentReader(owner.record, {
          signal,
          prepared: archive,
          waitForCoverage: false,
          maxArchiveBytes: 32 * 1024 * 1024,
          metrics: owner.metrics,
        });
        return {
          reader,
          // Index replacement briefly clears the footer; otherwise prefer the
          // latest snapshot's measured stream clock when starting a new seek.
          get metadata() {
            return archive.metadata ?? initialMetadata;
          },
        };
      })
      .catch(error => {
        // A later seek retries preparation after a transient outage or an
        // archive that has only just become available.
        owner.comments = null;
        throw error;
      });
    return owner.comments;
  }
  function clockFor(owner, part) {
    const key = part.start_time;
    if (!owner.clocks.has(key)) {
      const clock = (async () => {
        const finishPlaylist = owner.metrics.start('playlistLoad');
        let groups;
        try {
          groups = await owner.loadGroups(owner.controller.signal, part);
        } finally {
          finishPlaylist();
        }
        const group = groups.find(group => group.part.start_time === key);
        if (!group) throw new Error('无法读取弹幕预览对应的录像分段。');
        const finishProbe = owner.metrics.start('originProbe');
        try {
          return await readPartClock(owner.request, group, owner.controller.signal);
        } finally {
          finishProbe();
        }
      })().catch(error => {
        owner.clocks.delete(key);
        throw error;
      });
      owner.clocks.set(key, clock);
    }
    return owner.clocks.get(key);
  }
  async function prepare(owner, frame, width, height, signal) {
    const [{metadata, reader}, clock, [, {streamClock}, {createStreamingCompositor}], emoteCache] = await Promise.all([
      commentsFor(owner),
      clockFor(owner, frame.part),
      owner.modules,
      owner.emotes,
    ]);
    signal.throwIfAborted();
    const origin = streamOrigin(streamClock(metadata), clock.origin) ?? clock.origin;
    const finish = owner.metrics.start('compositorInit');
    try {
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
        emoteCache,
        metrics: owner.metrics,
      });
    } finally {
      finish();
    }
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
    if (own.owner.report) {
      own.owner.report.diagnostic?.fail(error, own.signal);
      own.owner.report.metrics.close();
      own.owner.report = null;
    } else if (!own.owner.notified) {
      const diagnostic = onDiagnostic(own.owner.record, false);
      diagnostic?.observe(own.owner.metrics);
      diagnostic?.fail(error, own.signal);
    }
    closeSession(own);
    if (!own.owner.notified) {
      own.owner.notified = true;
      onError(error);
    }
  }
  async function draw(own, frame) {
    own.busy = true;
    try {
      const compositor = (own.compositor = await own.promise);
      own.signal.throwIfAborted();
      // A paused video has no continuous RAF loop. Give text a chance to paint
      // while the first visible emotes are still downloading/decoding.
      schedule();
      await compositor.prepare(frame.time);
      own.signal.throwIfAborted();
      if (document.hidden) return;
      // A slow read must never put old comments over a newer frame. Keep its
      // layout progress and catch up on the next animation tick instead.
      const current = getFrame();
      if (!current || current.generation !== own.generation || Math.abs(current.time - frame.time) > 0.1) return;
      paint(own, compositor.renderOverlay(frame.time), frame.time);
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
  function paint(own, overlay, time, complete = true) {
    const revision = own.compositor.overlayRevision;
    canvas.style.opacity = '1';
    if (canvas.width !== own.width || canvas.height !== own.height) {
      canvas.width = own.width;
      canvas.height = own.height;
      own.copiedRevision = undefined;
    }
    if (own.copiedRevision !== revision) {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建弹幕预览画布，可能内存不足。');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.save();
      context.globalAlpha = own.compositor.overlayOpacity ?? 0.65;
      context.drawImage(overlay, 0, 0);
      if (own.compositor.superChatOverlay) {
        context.globalAlpha = own.compositor.superChatOpacity;
        context.drawImage(own.compositor.superChatOverlay, 0, 0);
      }
      context.restore();
      own.copiedRevision = revision;
    }
    if (complete) own.drawn = time;
    canvas.hidden = false;
    if (complete) reportReady(own.owner);
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
        (frame.time > session.time + 1 && !(session.resuming && frame.time <= session.time + 10))
      )
        startSession(frame);
      const own = session;
      own.resuming = false;
      own.time = frame.time;
      if (own.drawn !== null && Math.abs(frame.time - own.drawn) > 0.15) canvas.hidden = true;
      if (own.busy && own.compositor && !own.failed && own.drawn !== frame.time) {
        try {
          paint(own, own.compositor.renderAvailableOverlay(frame.time), frame.time, false);
        } catch (error) {
          fail(own, error);
        }
      }
      if (!own.busy && !own.failed && (canvas.hidden || own.drawn !== frame.time)) void draw(own, frame);
      else if (!canvas.hidden && own.drawn === frame.time) reportReady(own.owner);
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
  function restored() {
    if (session) {
      session.copiedRevision = undefined;
      session.drawn = null;
    }
    schedule();
  }
  function visibility() {
    if (document.hidden) {
      // Visibility is not ownership: keep bounded archives, clocks, decoders
      // and in-flight preparation for the return to this same recording.
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null;
      source?.report?.diagnostic?.finish({status: 'canceled'});
      source?.report?.metrics.close();
      if (source) source.report = null;
    } else {
      if (source && enabled && !source.report) beginReport(source, true);
      if (session?.failed) resetSession();
      else if (session) session.resuming = true;
      warmSource();
      schedule();
    }
  }
  const events = ['play', 'playing', 'pause', 'seeked', 'loadeddata', 'resize'];
  for (const event of events) video.addEventListener(event, schedule);
  video.addEventListener('seeking', seeking);
  video.addEventListener('emptied', seeking);
  document.addEventListener('visibilitychange', visibility);
  canvas.addEventListener('contextrestored', restored);
  return {
    setSource(next) {
      release();
      configuration = next;
      warmSource();
      schedule();
    },
    setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      if (enabled) {
        warmSource();
        schedule();
      } else release();
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
      canvas.removeEventListener('contextrestored', restored);
    },
  };
}
