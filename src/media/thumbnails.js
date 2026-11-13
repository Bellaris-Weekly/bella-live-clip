import {loadHls, makeHlsLoader} from './preview-player.js';
import {createThumbnailSource} from '../services/thumbnail-source.js';
import {drawFitted} from '../shared/fit.js';

export function thumbnailSamples(record, streams, view, count = 6) {
  return Array.from({length: count}, (_, i) => {
    const time = view.start + ((view.end - view.start) * (i + 0.5)) / count;
    if (record.kind === 'submission') return {time, stream: record, local: time};
    const stream = streams.find(s => time >= s.start_time - record.start && time < s.end_time - record.start);
    return {time, stream, local: stream ? time - (stream.start_time - record.start) : null};
  });
}

// A separate, muted decoder keeps thumbnail seeks away from the user's player.
export async function readThumbnail(request, sample, signal) {
  if (sample.stream.kind === 'submission') {
    const {readSubmissionThumbnail} = await import('./submission-thumbnail.js');
    return readSubmissionThumbnail(request, sample.stream, sample.local, signal);
  }
  const Hls = await loadHls();
  signal.throwIfAborted();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const hls = new Hls({
    loader: makeHlsLoader(request),
    enableWorker: false,
    startPosition: sample.local,
    maxBufferLength: 1,
    maxMaxBufferLength: 2,
    backBufferLength: 0,
  });
  let timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, {once: true});
      timer = setTimeout(() => reject(new Error('缩略图加载超时')), 15000);
      const ready = () => {
        if (video.readyState < 2 || video.seeking || Math.abs(video.currentTime - sample.local) > 0.15) return;
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        try {
          const context = canvas.getContext('2d');
          drawFitted(
            context,
            (x, y, width, height) => context.drawImage(video, x, y, width, height),
            video.videoWidth,
            video.videoHeight,
            canvas.width,
            canvas.height,
          );
          resolve(canvas);
        } catch (error) {
          reject(error);
        }
      };
      for (const name of ['loadeddata', 'seeked', 'canplay']) video.addEventListener(name, ready);
      video.addEventListener('error', () => reject(new Error('缩略图解码失败')), {once: true});
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) reject(new Error('缩略图加载失败'));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.currentTime = sample.local;
      });
      hls.loadSource(sample.stream.stream);
      hls.attachMedia(video);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    hls.destroy();
    video.removeAttribute('src');
    video.load();
  }
}

const DEMAND_LIMIT = 3,
  STRIP_READS = 4,
  PLAYER_READS = 2,
  // Three failures in a row mean this recording's fragments are not usable.
  FRAGMENT_FAILURES = 3,
  // A sparse pass covers the whole recording, so a drag has a picture anywhere.
  SWEEP_STEP = 600,
  DRAG_STEP = 10;

// Cells landing on shared times can be reused across zooming and live growth.
// Close up every position differs, so the exact time is worth its own picture.
function snapStep(view) {
  const cell = (view.end - view.start) / 6;
  return cell >= 300 ? 300 : cell >= 60 ? 60 : cell >= 30 ? 30 : 0;
}

const decodeFragment = (...args) => import('./fragment-still.js').then(module => module.readFragmentStill(...args));

export function createThumbnails({
  container,
  request,
  metadataRequest,
  createStoryboard,
  locate,
  readStill = decodeFragment,
  readFrame = readThumbnail,
}) {
  let record,
    source,
    streams = [],
    viewKey = '',
    controller,
    timer,
    displayView,
    currentView,
    moving = false,
    ready,
    decoding = Promise.resolve(),
    release = () => {},
    fragmentFailures = 0;
  function cancel() {
    clearTimeout(timer);
    ready = null;
    controller?.abort();
    controller = null;
  }
  function clear() {
    cancel();
    demands.abort();
    demands = new AbortController();
    wanted = null;
    pendingFrames = new Set();
    fragmentFailures = 0;
    source?.dispose();
    source = null;
    record = null;
    streams = [];
    viewKey = '';
    displayView = null;
    currentView = null;
    moving = false;
    release();
    container.replaceChildren();
  }
  const fragmentsWork = () => locate && fragmentFailures < FRAGMENT_FAILURES;
  function sampleAt(time) {
    const stream = streams.find(part => time >= part.start_time - record.start && time < part.end_time - record.start);
    return stream ? {time, stream, local: time - (stream.start_time - record.start)} : null;
  }
  async function readFragment(reader, sample, signal) {
    const place = await Promise.resolve(locate(sample.time, signal)).catch(() => null);
    if (!place) return null;
    try {
      const canvas = await readStill(reader, place, {signal});
      fragmentFailures = 0;
      return canvas;
    } catch (error) {
      signal.throwIfAborted();
      fragmentFailures++;
      return null;
    }
  }
  async function afterFirstFrame(signal) {
    let abort;
    try {
      await Promise.race([
        decoding,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, {once: true});
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
  }
  // A fragment's opening is cheap enough to fetch alongside the main picture.
  // Starting a second player is not, so that waits for the first frame.
  async function decode(reader, sample, signal) {
    if (sample.stream.kind !== 'submission' && fragmentsWork()) {
      const canvas = await readFragment(reader, sample, signal);
      if (canvas) return canvas;
    }
    if (sample.fragmentOnly) throw new Error('这个位置无法快速生成预览图。');
    await afterFirstFrame(signal);
    return readFrame(reader, sample, signal);
  }
  // A drag decodes the position under the pointer. Newer positions replace older
  // ones so a fast drag does not queue up its whole path.
  let wanted = null,
    demanding = 0,
    demands = new AbortController();
  let pendingFrames = new Set();
  function pump() {
    while (demanding < DEMAND_LIMIT && wanted !== null) {
      const time = wanted,
        reader = source,
        frames = pendingFrames,
        {signal} = demands,
        sample = sampleAt(time);
      wanted = null;
      if (frames.has(time) || !sample || reader.hasFrame(time)) continue;
      frames.add(time);
      demanding++;
      void reader
        .read({...sample, fragmentOnly: true}, signal)
        .catch(() => {})
        .finally(() => {
          frames.delete(time);
          demanding--;
          pump();
        });
    }
  }
  function frameUrl(time) {
    if (!source) return null;
    const url = source.frameUrl(time);
    if (fragmentsWork()) {
      const step = (currentView && snapStep(currentView)) || DRAG_STEP,
        nearby = Math.round(time / step) * step,
        // A recording can start after the grid point closest to its first frame.
        position = sampleAt(nearby) ? nearby : time;
      if (!source.hasFrame(position)) {
        wanted = position;
        pump();
      }
    }
    return url;
  }
  async function sweep(center) {
    const reader = source,
      frames = pendingFrames,
      {signal} = demands;
    const times = streams
      .flatMap(part => {
        const first = Math.ceil((part.start_time - record.start) / SWEEP_STEP),
          last = Math.floor((part.end_time - record.start) / SWEEP_STEP);
        return Array.from({length: Math.max(0, last - first + 1)}, (_, i) => (first + i) * SWEEP_STEP);
      })
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    for (const time of times) {
      if (signal.aborted || !fragmentsWork()) return;
      const sample = sampleAt(time);
      if (!sample || frames.has(time) || reader.hasFrame(time)) continue;
      frames.add(time);
      await reader
        .read({...sample, fragmentOnly: true}, signal)
        .catch(() => {})
        .finally(() => frames.delete(time));
    }
  }
  function snapped(sample, step) {
    if (!step || !sample.stream || sample.stream.kind === 'submission') return sample;
    return sampleAt(Math.round(sample.time / step) * step) ?? sample;
  }
  async function render(samples, own, cells, step) {
    const reader = source;
    let cursor = 0;
    await Promise.all(
      Array.from({length: fragmentsWork() ? STRIP_READS : PLAYER_READS}, async () => {
        while (cursor < samples.length && !own.signal.aborted) {
          const i = cursor++,
            sample = samples[i];
          if (!sample.stream) {
            cells[i].textContent = '无录像';
            continue;
          }
          try {
            const canvas = await reader.read(snapped(sample, step), own.signal);
            if (own.signal.aborted) return;
            cells[i].replaceChildren(canvas);
          } catch (error) {
            if (own.signal.aborted) return;
            cells[i].textContent = '暂无预览';
          }
          publish();
        }
      }),
    );
  }
  function project() {
    if (!displayView) return;
    const width = currentView.end - currentView.start;
    const cells = Array.from(container.children);
    cells.forEach((cell, i) => {
      const start = displayView.start + ((displayView.end - displayView.start) * i) / cells.length;
      cell.style.left = `${((start - currentView.start) / width) * 100}%`;
      cell.style.width = `${((displayView.end - displayView.start) / cells.length / width) * 100}%`;
    });
  }
  function publish() {
    if (moving || !ready) return;
    container.replaceChildren(...ready.cells);
    displayView = ready.view;
    ready = null;
    project();
  }
  function update(view, {animating = false, target = view} = {}) {
    if (!record) return;
    currentView = {...view};
    moving = animating;
    project();
    const key = `${target.start}:${target.end}`;
    if (key === viewKey) {
      publish();
      return;
    }
    viewKey = key;
    cancel();
    const own = new AbortController();
    controller = own;
    const samples = thumbnailSamples(record, streams, target);
    const cells = samples.map(() => {
      const cell = container.ownerDocument.createElement('div');
      cell.className = 'thumbnail';
      cell.textContent = '…';
      return cell;
    });
    if (!displayView) {
      container.replaceChildren(...cells);
      displayView = {...target};
      project();
    }
    timer = setTimeout(async () => {
      ready = {cells, view: {...target}};
      try {
        await render(samples, own, cells, snapStep(target));
      } catch (error) {
        if (own.signal.aborted) return;
      }
      if (!own.signal.aborted) publish();
    }, 80);
  }
  return {
    load(next, parts, {defer = false, onFrames} = {}) {
      clear();
      record = next;
      streams = parts;
      decoding = defer
        ? new Promise(resolve => {
            release = resolve;
          })
        : Promise.resolve();
      source = createThumbnailSource({
        record,
        request,
        metadataRequest,
        createStoryboard,
        readFrame: decode,
        onFrames,
      });
    },
    setStreams(parts) {
      streams = parts;
      viewKey = '';
      if (currentView) update(currentView);
    },
    sweep(center = 0) {
      if (source) void sweep(center);
    },
    frameUrl,
    resume() {
      release();
    },
    update,
    clear,
  };
}
