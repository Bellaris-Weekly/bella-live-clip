import {clamp} from '../shared/math.js';

// Named here so the player can be created before hls.js has loaded.
const EVENT = {
  ERROR: 'hlsError',
  MANIFEST_PARSED: 'hlsManifestParsed',
  LEVEL_LOADED: 'hlsLevelLoaded',
  FRAG_LOADED: 'hlsFragLoaded',
};
const NETWORK_ERROR = 'networkError';

// Parsing is cheap but initializing the library is not, and this script runs on
// every Bilibili page, so it starts the first time a recording opens.
export const loadHls = () => import('hls.js/light').then(module => module.default);

const CODEC_ERRORS = new Set(['bufferAddCodecError', 'bufferIncompatibleCodecsError']);

function isCodecError(data) {
  return data?.type === 'mediaError' && CODEC_ERRORS.has(data.details);
}

// The codec and the browser's own reason are what tell an unsupported stream
// apart from a broken one; the bare hls.js detail names do not.
export function previewError(data, mediaSource = globalThis.MediaSource) {
  const error = new Error(`录像预览失败：${data?.type} / ${data?.details}`);
  const facts = {
    hlsType: data?.type,
    hlsDetails: data?.details,
    reason: typeof data?.reason === 'string' ? data.reason : undefined,
    sourceBuffer: data?.sourceBufferName,
    mimeType: data?.mimeType,
  };
  if (typeof data?.mimeType === 'string') {
    try {
      facts.typeSupported = mediaSource?.isTypeSupported?.(data.mimeType);
    } catch {
      /* Diagnostics only. */
    }
  }
  error.diagnostic = Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
  if (data?.error instanceof Error) error.cause = data.error;
  return error;
}

export function makeHlsLoader(request) {
  return class {
    constructor() {
      this.context = null;
      this.stats = {
        aborted: false,
        loaded: 0,
        total: 0,
        retry: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: {start: 0, first: 0, end: 0},
        parsing: {start: 0, end: 0},
        buffering: {start: 0, first: 0, end: 0},
      };
    }
    load(context, config, callbacks) {
      this.context = context;
      this.controller = new AbortController();
      this.stats.loading.start = performance.now();
      request(context.url, {
        type: context.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
        signal: this.controller.signal,
        range:
          context.rangeEnd > context.rangeStart
            ? {offset: context.rangeStart, length: context.rangeEnd - context.rangeStart}
            : null,
      })
        .then(response => {
          if (this.stats.aborted) return;
          const now = performance.now();
          this.stats.loading.first = this.stats.loading.end = now;
          this.stats.loaded = this.stats.total =
            typeof response.data === 'string'
              ? new TextEncoder().encode(response.data).length
              : response.data.byteLength;
          this.stats.chunkCount = 1;
          callbacks.onSuccess({url: response.url, data: response.data}, this.stats, context, null);
        })
        .catch(error => {
          if (!this.stats.aborted) callbacks.onError({code: 0, text: error.message}, context, null, this.stats);
        });
    }
    abort() {
      this.stats.aborted = true;
      this.controller?.abort();
    }
    destroy() {
      this.abort();
    }
  };
}

// Only the settled position is decoded. Every seek restarts sequential fragment
// loading, so a drag shows stills and seeks when the pointer rests.
const SETTLE_MS = 160,
  UNSTILLED_SEEK_MS = 250;
// A fragment's first frame sits slightly after its nominal start, and most
// fragments begin mid-GOP. Positioned inside that gap, hls.js appends the
// fragment again; the browser then drops the following frames until the next
// keyframe, so the same fragments reload forever with no picture.
const BOUNDARY_GAP = 0.1,
  RELOAD_LIMIT = 3,
  RECOVERY_LIMIT = 2;
// Replay fragments are several megabytes. A paused preview only needs the one
// holding its frame, while playback buffers ahead as usual.
const PAUSED_BUFFER = 2,
  PLAYING_BUFFER = 12;

export function createPlayer({
  video,
  loading,
  api,
  status,
  onTime,
  still,
  frameUrl = () => null,
  onError = () => {},
  onReady = () => {},
  onStreams,
  HlsClass,
}) {
  let hls,
    record,
    streams = [],
    index = -1,
    generation = 0,
    target = null,
    notified = false,
    attachedEnd = 0;
  let scrubbing = false,
    scrubTime = null,
    settle = null,
    lastSeek = 0;
  let fragments = [],
    reloads = new Map(),
    recoveries = 0,
    renewed = false,
    failed = false,
    renewal = null;
  const offset = () => (streams[index] ? streams[index].start_time - record.start : 0);
  function showStill(url) {
    if (!still || !url) return false;
    if (still.getAttribute('src') !== url) still.setAttribute('src', url);
    still.hidden = false;
    return true;
  }
  function hideStill() {
    if (still && !still.hidden) still.hidden = true;
  }
  function waiting(text) {
    loading.textContent = text;
    loading.hidden = false;
  }
  function clearBoundary(local) {
    const frag = fragments.find(({start, duration}) => local >= start && local < start + duration);
    return frag && frag.start > 0 && local - frag.start < BOUNDARY_GAP
      ? frag.start + Math.min(BOUNDARY_GAP, frag.duration / 2)
      : local;
  }
  function recover() {
    if (recoveries++ >= RECOVERY_LIMIT) {
      hls.stopLoad();
      waiting('这个位置暂时无法预览，请换个位置');
      return;
    }
    attach(index, (Number.isFinite(target) ? target : video.currentTime) + BOUNDARY_GAP);
  }
  const requestedEnd = () => (record.live ? Math.floor(Date.now() / 1000) : record.end) - record.start;
  function fail(data) {
    failed = true;
    onError(previewError(data));
    // Refreshing cannot make the browser play a codec it lacks; copy export
    // does not decode, so it still works.
    const text = isCodecError(data)
      ? '当前浏览器无法播放这场录像的视频编码，暂时不能预览；仍可用原画方式导出'
      : '预览暂不可用，请点右上角刷新';
    loading.textContent = text;
    status(`${text}。`, true);
  }
  // A failed read usually means the signed address expired. Fetch a new one once
  // per position and continue from the same place.
  async function renew(data) {
    const token = generation,
      own = new AbortController();
    renewal = own;
    const time = Number.isFinite(target) ? target : video.currentTime;
    waiting('正在加载…');
    try {
      const parts = await api.clips(record, 0, requestedEnd(), own.signal);
      if (token !== generation) return;
      (onStreams ?? extend)(parts);
      attach(index, time);
    } catch (error) {
      if (token === generation && !own.signal.aborted) fail(data);
    }
  }
  function attach(part, time = 0) {
    renewal?.abort();
    renewal = null;
    failed = false;
    const token = ++generation;
    hls?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
    index = part;
    fragments = [];
    reloads = new Map();
    target = time;
    attachedEnd = streams[part].end_time;
    loading.hidden = false;
    hls = new HlsClass({
      loader: makeHlsLoader(api.request),
      enableWorker: false,
      maxBufferLength: PAUSED_BUFFER,
      maxMaxBufferLength: 24,
      maxBufferHole: 1,
      backBufferLength: 15,
      startPosition: time,
    });
    hls.on(EVENT.ERROR, (_, data) => {
      if (token !== generation || !data.fatal) return;
      if (data.type === NETWORK_ERROR && !renewed) {
        renewed = true;
        void renew(data);
      } else fail(data);
    });
    hls.on(EVENT.MANIFEST_PARSED, () => {
      if (token === generation && target !== null) video.currentTime = target;
    });
    hls.on(EVENT.LEVEL_LOADED, (_, {details}) => {
      if (token !== generation) return;
      fragments = details.fragments;
      const safe = Number.isFinite(target) ? clearBoundary(target) : target;
      if (safe !== target) {
        target = safe;
        video.currentTime = safe;
        hls.startLoad(safe);
      }
    });
    hls.on(EVENT.FRAG_LOADED, (_, {frag}) => {
      if (token !== generation || typeof frag.sn !== 'number') return;
      const count = (reloads.get(frag.sn) || 0) + 1;
      reloads.set(frag.sn, count);
      if (count > RELOAD_LIMIT) recover();
    });
    hls.loadSource(streams[index].stream);
    hls.attachMedia(video);
  }
  function seek(time) {
    video.pause();
    lastSeek = performance.now();
    reloads.clear();
    recoveries = 0;
    renewed = false;
    // Prefer the loaded stream so a time on a shared boundary does not reload the previous one.
    const contains = p => time >= p.start_time - record.start && time <= p.end_time - record.start;
    const found = streams[index] && contains(streams[index]) ? index : streams.findIndex(contains);
    if (found < 0) {
      target = NaN;
      hideStill();
      waiting('该位置没有录像');
      return;
    }
    const local = clearBoundary(
      clamp(
        time - (streams[found].start_time - record.start),
        0,
        Math.max(0, streams[found].end_time - streams[found].start_time - 0.001),
      ),
    );
    waiting('正在加载…');
    // Keep buffered playback untouched during a background update. Only replace
    // its old snapshot when the user seeks into newly available footage.
    if (!hls || found !== index || (time + record.start >= attachedEnd && streams[found].end_time > attachedEnd))
      attach(found, local);
    else {
      target = local;
      video.currentTime = local;
    }
  }
  function ready() {
    if (
      hls &&
      (target === null || Math.abs(video.currentTime - target) < 0.12) &&
      video.readyState >= 2 &&
      !video.seeking
    ) {
      target = null;
      loading.hidden = true;
      if (settle === null) hideStill();
      if (!notified) {
        notified = true;
        onReady(record);
      }
    }
  }
  function commit() {
    clearTimeout(settle);
    settle = null;
    if (scrubTime === null) return;
    const time = scrubTime;
    scrubTime = null;
    seek(time);
    if (!scrubbing) ready();
  }
  function scrub(time) {
    scrubTime = time;
    const shown = showStill(frameUrl(time));
    if (shown) loading.hidden = true;
    clearTimeout(settle);
    settle = null;
    if (!shown && performance.now() - lastSeek >= UNSTILLED_SEEK_MS) {
      commit();
      return;
    }
    settle = setTimeout(commit, shown ? SETTLE_MS : UNSTILLED_SEEK_MS);
  }
  const bufferFor = length => () => {
    if (hls?.config) hls.config.maxBufferLength = length;
  };
  const bufferAhead = bufferFor(PLAYING_BUFFER),
    bufferOne = bufferFor(PAUSED_BUFFER);
  video.addEventListener('seeked', ready);
  video.addEventListener('loadeddata', ready);
  video.addEventListener('canplay', ready);
  video.addEventListener('play', bufferAhead);
  video.addEventListener('pause', bufferOne);
  video.ontimeupdate = () => {
    ready();
    onTime(offset() + video.currentTime);
  };
  video.onwaiting = () => waiting('正在加载…');
  video.onplaying = () => {
    loading.hidden = true;
  };
  function clear() {
    generation++;
    renewal?.abort();
    renewal = null;
    failed = false;
    renewed = false;
    hls?.destroy();
    hls = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    streams = [];
    index = -1;
    target = null;
    notified = false;
    scrubbing = false;
    scrubTime = null;
    clearTimeout(settle);
    settle = null;
    hideStill();
  }
  function destroy() {
    clear();
    for (const event of ['seeked', 'loadeddata', 'canplay']) video.removeEventListener(event, ready);
    video.removeEventListener('play', bufferAhead);
    video.removeEventListener('pause', bufferOne);
    video.ontimeupdate = video.onwaiting = video.onplaying = null;
  }
  function availableTotal() {
    return (record.live ? streams.at(-1).end_time : record.end) - record.start;
  }
  function extend(next) {
    // Ignore partial/regressing responses. Stable segment indices also keep the
    // active HLS player and an existing selection attached to the same segment.
    if (!record || next.length < streams.length || !next.length || (!record.live && next.length !== streams.length))
      return null;
    if (
      next.some(
        (part, i) =>
          !Number.isFinite(part.start_time) ||
          !Number.isFinite(part.end_time) ||
          part.end_time <= part.start_time ||
          typeof part.stream !== 'string' ||
          !part.stream ||
          (i > 0 && part.start_time < next[i - 1].end_time) ||
          (i < streams.length && (part.start_time !== streams[i].start_time || part.end_time < streams[i].end_time)),
      )
    )
      return null;
    const changed =
      record.live && (next.length !== streams.length || next.some((part, i) => part.end_time !== streams[i].end_time));
    streams = next;
    return {streams, total: availableTotal(), changed};
  }
  // A real still replaces the room cover as soon as the frame index reaches it.
  function refreshStill() {
    if (scrubTime !== null) {
      if (showStill(frameUrl(scrubTime))) loading.hidden = true;
    } else if (!notified && record) showStill(frameUrl(target === null ? 0 : offset() + target));
  }
  return {
    getScreenshotVideo: () => video,
    async load(nextRecord, signal) {
      clear();
      const token = generation;
      record = nextRecord;
      loading.hidden = false;
      loading.textContent = '正在加载…';
      showStill(record.poster);
      const [library, nextStreams] = await Promise.all([
        HlsClass ?? loadHls(),
        api.clips(record, 0, requestedEnd(), signal),
      ]);
      HlsClass = library;
      signal.throwIfAborted();
      if (token !== generation) throw new DOMException('已切换场次', 'AbortError');
      streams = nextStreams;
      return {streams, total: availableTotal()};
    },
    extend,
    seek,
    clear,
    destroy,
    refreshStill,
    reload() {
      if (failed) attach(index, Number.isFinite(target) ? target : video.currentTime);
    },
    beginScrub() {
      scrubbing = true;
    },
    scrub,
    endScrub(restoreTime) {
      scrubbing = false;
      if (Number.isFinite(restoreTime)) scrubTime = restoreTime;
      if (scrubTime !== null) commit();
      else ready();
    },
    pause: () => video.pause(),
    position: () => scrubTime ?? offset() + video.currentTime,
  };
}
