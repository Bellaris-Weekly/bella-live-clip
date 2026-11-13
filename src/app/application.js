import {batch, effect} from '@preact/signals';
import {createComposer} from '../preview/compose.js';
import {createMarksSession} from '../preview/marks-session.js';
import {MarkPins, MarksPanel, MiniMarks} from '../ui/marks.jsx';
import {ComposeSheet, CoverButton, CoverPin} from '../ui/compose.jsx';
import {STUDIO} from '../preview/studio.js';
import metadataText from '../header.txt';
import {readScriptMetadata, createUpdateChecker} from '../services/updates.js';
import {createVersionControl} from '../ui/version.js';
import css from '../ui/theme.css';
import {mountApp} from '../ui/app.jsx';
import {createStore, toast} from './store.js';
import {createScreenshotControls} from '../ui/live-screenshot.js';
import {downloadScreenshot} from './live-screenshot.js';
import {createTimeline} from '../ui/timeline.js';
import {ScheduleService} from '../services/schedule.js';
import {createDiagnosticReporter} from '../services/diagnostics.js';
import {createLibraryLoader} from './library-loader.js';
import {createRecordingUpdater} from './recording-updater.js';
import {createPanelWindow} from './panel-window.js';
import {bindShortcut} from './shortcut-field.js';
import {bindEditorInput} from './editor-input.js';
import {createExportActions} from './export-actions.js';
import {createSubmissionService} from '../services/submission.js';
import {createSubmissionStoryboard} from '../services/submission-storyboard.js';
import {bindPageProgress} from '../ui/page-progress.js';
import {parseSubmissionUrl} from '../domain/submission.js';
import {createSubmissionPlayer} from '../media/submission-player.js';
import {RecordingPlan} from '../media/recording-plan.js';
import {locateSegment} from '../media/playlist.js';
import {createPlayer} from '../media/preview-player.js';
import {createDanmakuPreview} from '../danmaku/preview.js';
import {createPlayback, bindVideoControls} from '../media/playback.js';
import {createThumbnails} from '../media/thumbnails.js';
import {sharePlaylists} from '../services/shared-playlists.js';
import {estimateRecordingRate, estimateSelectionBytes} from '../media/recording-estimate.js';
import {MEMBERS, roomIdFromUrl} from '../domain/records.js';
import {clamp} from '../shared/math.js';
import {formatDuration, formatTimeRange, formatDate, formatBytes, formatTime} from '../shared/format.js';

export function createApp({
  api,
  studio,
  storageKeys,
  diagnostics = createDiagnosticReporter(),
  submissionRequest = api.request,
  mediaRequest = api.request,
  get = (_, fallback) => fallback,
  set = () => {},
  pageUrl = () => location.href,
  saveFilePicker = typeof window.showSaveFilePicker === 'function' ? window.showSaveFilePicker.bind(window) : null,
  storage = globalThis.navigator?.storage,
}) {
  const preview = typeof __PREVIEW__ !== 'undefined' && __PREVIEW__;
  const host = document.createElement('div');
  host.id = 'bella-live-clip-host';
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = `<style>${css}</style>`;
  document.documentElement.append(host);
  const syncTheme = () => {
    const page = document.documentElement;
    host.dataset.theme = page.classList?.contains?.('bili_dark') || page.dataset?.theme === 'dark' ? 'dark' : 'light';
  };
  syncTheme();
  const readPageUrl = typeof pageUrl === 'function' ? pageUrl : () => pageUrl;
  const room = roomIdFromUrl(readPageUrl()),
    submissions = createSubmissionService(submissionRequest);
  let marks, composer;
  const allowed = () => !preview || Boolean(studio?.identity());
  // Live clips default to lossless; video clips keep their exact cut, as they always have.
  const exportModes = {live: get('exportMode.live', 'copy'), submission: get('exportMode.submission', 'precise')};
  if (get('danmaku.enabled', false)) {
    exportModes.live = 'danmaku';
    set('exportMode.live', 'danmaku');
    set('danmaku.enabled', false);
  }
  const store = createStore({
    member: MEMBERS.find(m => m.room === room) || MEMBERS.find(m => m.id === get('member', 'bella')) || MEMBERS[0],
    exportMode: exportModes.live,
  });
  if (preview) {
    store.identity.value = studio.identity();
    studio.subscribe(() => (store.identity.value = studio.identity()));
  }
  const isOpen = () => store.open.value;
  // The open record's member (or the chosen one in the list) tints the brand mark and dates.
  effect(() => {
    const owner = MEMBERS.find(m => m.room === Number(store.record.value?.room)) || store.member.value;
    host.style.setProperty('--member', owner.color);
  });
  let player = null,
    playerKind = null,
    loadedRoute = null,
    observedRoute = parseSubmissionUrl(readPageUrl())?.key,
    jobKind = null,
    pendingRoute = false,
    submissionThumbnails = false;
  let record = null,
    initialized = false,
    controller = null,
    ready = false,
    libraryScroll = 0,
    playbackTotal = 0,
    estimate = null,
    recordingController = null,
    recordingPlan = null,
    estimateState = 'loading',
    clipSelection = null,
    previewDiagnostic = null;
  // Each stream is one recorded segment (a new one starts after a disconnect); the editor works on one at a time.
  let recordStreams = [],
    segments = [],
    segmentIndex = 0;
  const isSubmission = () => record?.kind === 'submission';
  const member = () => store.member.value;
  const metadata = readScriptMetadata(metadataText);
  const versionControl = createVersionControl({
    state: store.version,
    metadata,
    check: createUpdateChecker({request: api.request, metadata}),
  });
  const actions = {
    launch: () => {
      if (!panelWindow.launcherDragged()) isOpen() ? close() : void open();
    },
    close: () => close(),
    back: () => void library(),
    library: () => void library(),
    retryCurrent: () => void (parseSubmissionUrl(readPageUrl()) ? currentVideo() : currentRoom()),
    refreshLibrary: () => void library(true),
    refreshEditor: () => void (isSubmission() ? currentVideo() : refreshRecording()),
    currentVideo: () => void currentVideo(),
    selectMember(next) {
      store.member.value = next;
      set('member', next.id);
      libraryScroll = 0;
      void library();
    },
    openRecord(next) {
      libraryScroll = $('body').scrollTop;
      void enterRecord(next);
    },
    cancel() {
      if (exporter.stopWhole()) {
        controls();
        status('正在保存…');
      } else controller?.abort();
    },
    download: () => (store.whole.value ? exporter.exportWhole() : exporter.exportSelected()),
    setWhole(whole) {
      store.whole.value = whole;
      if (whole) {
        clipSelection = timeline.getSelection();
        timeline.setSelection({...segments[segmentIndex]}, true);
      } else {
        timeline.setSelection(clipSelection, true);
        clipSelection = null;
      }
      controls();
    },
    setExportMode(mode) {
      const kind = modeKind();
      exportModes[kind] = mode;
      set(`exportMode.${kind}`, mode);
      store.exportMode.value = mode;
      updateExportSummary();
    },
    selectSegment: index => {
      if (index !== segmentIndex) selectSegment(index);
    },
    togglePlayback: () => activePlayback()?.toggle(),
    playSelection: () => player.playSelection(),
    markStart: () => editorInput.markStart(),
    markEnd: () => editorInput.markEnd(),
    stepFrame: direction => void stepFrame(direction),
    setCover: () => void setCover(),
    typeTime: (edge, value) => editorInput.typeTime(edge, value),
    versionClick: event => versionControl.click(event),
    versionKey: event => versionControl.key(event),
    logout: () => studio.logout(),
    sendFeedback: (kind, message) =>
      diagnostics.feedback(kind, message, {
        pageUrl: readPageUrl(),
        mode: record ? exportMode() : undefined,
        record,
        selection: record ? timeline.getSelection() : undefined,
        user: store.identity.value?.name,
      }),
  };
  mountApp(root, {store, actions, preview, members: MEMBERS, studioUrl: STUDIO, feedback: diagnostics.canFeedback});
  const $ = id => root.getElementById(id),
    video = $('fullVideo');
  const modeKind = () => (isSubmission() ? 'submission' : 'live'),
    exportMode = () => exportModes[modeKind()];
  const schedules = new ScheduleService(api.request);
  const libraries = createLibraryLoader({
    api,
    schedules,
    backgroundEnrichment: true,
    store: {read: id => get(`library.${id}`, null), write: (id, value) => set(`library.${id}`, value)},
    onUpdate(selected, result) {
      if (member().id === selected.id && store.page.value === 'library' && isOpen()) {
        renderCards();
        showScheduleResult(result);
      }
    },
  });
  let scheduleController = null,
    backgroundStarted = false;
  const panelWindow = createPanelWindow({root, get, set});
  let exporter = null,
    editorInput = null;
  const status = (text, error = false) => (store.status.value = {text, error});
  createScreenshotControls({
    rootDocument: document,
    getVideo: () => (ready ? player.getScreenshotVideo() : null),
    getIdentity: () => ({
      streamerName: isSubmission() ? record.uploader || record.title : record?.member,
      roomId: record?.room,
    }),
    download: (blob, name) => downloadScreenshot(document, blob, name),
  })($('previewScreenshot'));
  const seekTo = t => {
    player?.seek(t);
    timeline.setCurrent(t);
    updateClock(t);
  };
  // Frame-exact tools work on recordings; the submission player has no frame clock.
  const framesReady = () => ready && !controller && playerKind === 'live';
  async function stepFrame(direction) {
    if (!framesReady()) return;
    try {
      const time = await player.stepFrame(direction);
      timeline.setCurrent(time);
      updateClock(time);
    } catch (error) {
      status(error.message, true);
    }
  }
  // The frame on screen; with a clip given, one inside it (its start if the playhead is outside).
  async function captureCover(selection = null) {
    if (!framesReady()) throw new Error('录像还没有加载好');
    const position = player.position();
    if (selection && (position < selection.start || position > selection.end)) seekTo(selection.start);
    const frame = await player.captureFrame();
    timeline.setCurrent(frame.time);
    updateClock(frame.time);
    return {...frame, key: record.key};
  }
  async function setCover() {
    if (!preview || !framesReady()) return;
    try {
      const frame = await captureCover();
      composer.setFrame(frame);
      toast(store, `已设为封面：${formatTime(frame.time, true)}`);
    } catch (error) {
      toast(store, error.message, {error: true});
    }
  }
  const playback = createPlayback(video, status, {
    getRange: () => (ready ? timeline.getSelection() : null),
    position: () => player?.position() ?? 0,
    seek: seekTo,
  });
  const activePlayback = () => (playerKind === 'submission' ? player : playback);
  bindVideoControls(video, playback, status, {fullscreenTarget: $('playerWrap'), exitButton: $('exitVideoFullscreen')});
  // The player and the timeline strip read the same stills; one video needs one copy.
  let storyboard = null;
  function storyboardFor(submission) {
    if (storyboard?.key !== submission.key) {
      storyboard?.reader.dispose?.();
      storyboard = {
        key: submission.key,
        reader: createSubmissionStoryboard({metadataRequest: submissionRequest, mediaRequest, submission}),
      };
    }
    return {...storyboard.reader, dispose() {}};
  }
  const playlists = sharePlaylists(mediaRequest);
  const mediaApi = {request: playlists.request};
  const danmakuPreview = createDanmakuPreview({
    video,
    canvas: $('danmakuPreview'),
    getFrame: () => (playerKind === 'live' ? player?.danmakuFrame() : null),
    onError: error => toast(store, `弹幕预览暂不可用：${error.message}`, {error: true}),
    onDiagnostic: (record, resumed) =>
      diagnostics.begin(resumed ? 'danmaku_preview_resume' : 'danmaku_preview', {
        pageUrl: readPageUrl(),
        record,
        mode: 'danmaku',
      }),
  });
  effect(() => {
    danmakuPreview.setEnabled(
      store.open.value &&
        store.page.value === 'edit' &&
        store.record.value?.kind !== 'submission' &&
        store.exportMode.value === 'danmaku' &&
        !store.whole.value,
    );
  });
  const thumbnails = createThumbnails({
    container: $('thumbnails'),
    request: mediaApi.request,
    metadataRequest: submissionRequest,
    createStoryboard: ({submission}) => storyboardFor(submission),
    locate: async (time, signal) => {
      const plan = recordingPlan;
      if (!plan) return null;
      const at = record.start + time;
      const index = plan.streams.findIndex(part => at >= part.start_time && at < part.end_time);
      return index < 0 ? null : locateSegment(await plan.loadPart(index, signal), at);
    },
  });
  let scrubReturnTime = null;
  const timeline = createTimeline({
    track: $('timeline'),
    startHandle: $('startHandle'),
    endHandle: $('endHandle'),
    selectionElement: $('selection'),
    playhead: $('playhead'),
    ticks: $('ticks'),
    onRange: range => editorInput?.renderRange(range),
    onFrameStep: direction => {
      if (playerKind !== 'live') return false;
      void stepFrame(direction);
      return true;
    },
    onPreview: t => {
      if (playerKind === 'live') player.scrub(t);
      else player?.seek(t);
      updateClock(t);
    },
    onScrubStart: ({type}) => {
      danmakuPreview.setScrubbing(true);
      scrubReturnTime = type === 'playhead' ? null : (player?.position() ?? null);
      activePlayback()?.begin();
      if (playerKind === 'live') player.beginScrub();
      if (isSubmission()) {
        submissionThumbnails = true;
        thumbnails.update(timeline.getView());
      }
    },
    onScrubEnd: (time, {canceled = false, commitPosition = false} = {}) => {
      if (canceled) scrubReturnTime ??= time;
      if (commitPosition && !canceled) scrubReturnTime = null;
      if (playerKind === 'live') player.endScrub(scrubReturnTime ?? undefined);
      activePlayback()?.end({commit: !canceled, time: scrubReturnTime ?? undefined});
      if (scrubReturnTime !== null) {
        const time = player.position();
        timeline.setCurrent(time);
        updateClock(time);
      }
      scrubReturnTime = null;
      danmakuPreview.setScrubbing(false);
    },
    onSelection: selection => {
      if (preview) composer?.clearMark();
      updateExportSummary(selection);
      activePlayback()?.check();
    },
    onView: (view, motion) => {
      batch(() => {
        store.view.value = {start: view.start, end: view.end};
        store.zoom.value = $('timeline').dataset.zoom;
      });
      if (!isSubmission() || submissionThumbnails) thumbnails.update(view, motion);
    },
  });
  const updater = createRecordingUpdater({
    api,
    onUpdate: applyStreams,
    canRefresh: () =>
      ready &&
      record?.live &&
      store.page.value === 'edit' &&
      !controller &&
      isOpen() &&
      !document.hidden &&
      !timeline.isInteracting(),
  });
  const updateClock = t => (store.clock.value = formatTimeRange(t, playbackTotal, ' / '));
  function usePlayer(kind) {
    if (playerKind === kind) return;
    player?.destroy();
    playerKind = kind;
    const options = {
      video,
      loading: $('videoLoading'),
      still: $('videoStill'),
      frameUrl: t => thumbnails.frameUrl(t),
      api: {...mediaApi, clips: (...args) => api.clips(...args)},
      request: mediaRequest,
      status,
      onStreams: applyStreams,
      onReady: owner => {
        if (owner.key === record?.key) startBackgroundPreview();
      },
      onError: error => {
        previewDiagnostic?.fail(error, recordingController?.signal);
        startBackgroundPreview();
      },
      onTime: t => {
        timeline.setCurrent(t);
        updateClock(t);
      },
    };
    video.hidden = kind === 'submission';
    $('pageMirror').hidden = kind !== 'submission';
    player =
      kind === 'submission'
        ? createSubmissionPlayer({
            ...options,
            canvas: $('pageMirror'),
            getVideo: () =>
              document.querySelector('.bpx-player-container video, .bilibili-player-video video') ??
              document.querySelector('video'),
            isCurrent: () => parseSubmissionUrl(readPageUrl())?.key === loadedRoute,
            getRange: () => timeline.getSelection(),
            onState: () => syncPlayback(),
            createPreview: storyboardFor,
          })
        : createPlayer(options);
  }
  const syncPlayback = () =>
    (store.paused.value = playerKind === 'submission' ? player.isPaused() : video.paused || video.ended);
  for (const event of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(event, syncPlayback);
  function updateExportSummary(selection = timeline.getSelection()) {
    // Both the timeline and the whole-download action refer to the active segment.
    const whole = store.whole.value && !isSubmission();
    const range = whole && segments.length ? segments[segmentIndex] : selection;
    store.duration.value = formatDuration(range.end - range.start);
    if (isSubmission()) {
      const rate = record.media.video.bandwidth + (record.media.audio?.bandwidth || 0);
      store.estimate.value = rate
        ? `约 ${formatBytes((rate * (selection.end - selection.start)) / 8)}`
        : '大小暂不可用';
      return;
    }
    store.estimate.value = estimate
      ? `约 ${formatBytes(estimateSelectionBytes(estimate, record.start, range))}`
      : estimateState === 'error'
        ? '大小暂不可用'
        : '大小计算中…';
  }
  function startEstimate(plan, signal, previous) {
    void (async () => {
      try {
        const groups = await plan.load();
        const result = await estimateRecordingRate(mediaApi, groups, signal, previous);
        signal.throwIfAborted();
        estimate = result;
        updateExportSummary();
      } catch (e) {
        if (!signal.aborted) {
          estimateState = 'error';
          updateExportSummary();
        }
      }
    })();
  }
  function startBackgroundPreview() {
    if (backgroundStarted || !ready || isSubmission() || !recordingPlan) return;
    backgroundStarted = true;
    thumbnails.resume();
    thumbnails.sweep(player.position());
    startEstimate(recordingPlan, recordingController.signal);
  }
  function applyStreams(parts) {
    const next = player.extend(parts);
    if (!next) return;
    if (!next.changed) {
      recordStreams = next.streams;
      recordingPlan = new RecordingPlan(mediaApi, recordStreams, recordingController.signal);
      return;
    }
    const previousEstimate = estimate;
    recordingController?.abort();
    recordingController = new AbortController();
    recordStreams = next.streams;
    playbackTotal = next.total;
    segments = segmentBounds(record, recordStreams, playbackTotal);
    recordingPlan = new RecordingPlan(mediaApi, recordStreams, recordingController.signal);
    estimate = null;
    estimateState = 'loading';
    thumbnails.setStreams(recordStreams);
    timeline.extend(segments[segmentIndex].end, {whole: store.whole.value});
    renderSegments();
    if (preview) void marks?.refresh();
    updateClock(player.position());
    updateExportSummary();
    if (backgroundStarted) startEstimate(recordingPlan, recordingController.signal, previousEstimate);
  }
  // The timeline is locked whenever its range cannot change.
  effect(() => timeline.lock(store.busy.value || !store.ready.value || store.whole.value));
  function controls() {
    const route = parseSubmissionUrl(readPageUrl());
    batch(() => {
      store.currentVideo.value = Boolean(route) && !(store.page.value === 'edit' && loadedRoute === route.key);
      store.busy.value = Boolean(controller);
      store.ready.value = ready;
      store.stopping.value = exporter.stopping();
    });
    if (preview) composer?.refresh();
  }

  function showPage(next) {
    store.page.value = next;
    $('body').scrollTop = next === 'library' ? libraryScroll : 0;
    controls();
  }
  async function job(action, kind = 'load', details = {}) {
    if (!allowed() || controller) return;
    const own = new AbortController();
    const diagnostic = diagnostics.begin(details.action || kind, {pageUrl: readPageUrl(), record, ...details});
    controller = own;
    jobKind = kind;
    store.progress.value = kind === 'export' ? NaN : null;
    if (kind === 'export') {
      updater.stop();
      window.addEventListener('beforeunload', holdPage);
    }
    controls();
    try {
      await action(own.signal, diagnostic);
      diagnostic.finish?.();
    } catch (e) {
      diagnostic.fail(e, own.signal);
      own.abort();
      status(e.name === 'AbortError' ? '已停止。' : e.message, e.name !== 'AbortError');
    } finally {
      window.removeEventListener('beforeunload', holdPage);
      controller = null;
      jobKind = null;
      exporter.reset();
      controls();
      if (preview) void marks?.refresh(true);
      if (kind === 'export' && record?.live && ready && isOpen()) updater.start(record);
      if (pendingRoute) {
        pendingRoute = false;
        if (isOpen()) void currentVideo();
      }
    }
  }
  // Refreshing or closing the page cannot resume an export.
  function holdPage(event) {
    event.preventDefault();
    event.returnValue = '';
  }
  const clearDownloads = () => (store.downloads.value = []);
  function leavePage() {
    danmakuPreview.clear();
    updater.stop();
    scheduleController?.abort();
    scheduleController = null;
    store.libraryNote.value = '';
    recordingController?.abort();
    recordingController = null;
    recordingPlan = null;
    previewDiagnostic = null;
    activePlayback()?.cancel();
    submissionThumbnails = false;
    estimate = null;
    estimateState = 'loading';
    backgroundStarted = false;
    record = null;
    store.record.value = null;
    ready = false;
    playbackTotal = 0;
    clipSelection = null;
    recordStreams = [];
    segments = [];
    segmentIndex = 0;
    renderSegments();
    store.whole.value = false;
    timeline.stop();
    player?.clear();
    thumbnails.clear();
    playlists.clear();
    storyboard?.reader.dispose?.();
    storyboard = null;
    clearDownloads();
    updateClock(0);
  }
  function renderCards() {
    const loaded = libraries.get(member());
    batch(() => {
      store.records.value = loaded?.records || [];
      store.libraryLoaded.value = Boolean(loaded);
    });
    controls();
  }
  function showScheduleResult(result) {
    store.libraryNote.value = [
      result.liveFailed ? '当前直播状态暂不可用，可刷新重试。' : '',
      result.failed ? '部分日程暂不可用，可刷新重试。' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  async function library(refresh = false) {
    leavePage();
    showPage('library');
    renderCards();
    const selected = member();
    await job(
      async signal => {
        status('正在加载场次…');
        const result = await libraries.load(selected, {refresh, signal});
        if (signal.aborted || member() !== selected) return;
        renderCards();
        showScheduleResult(libraries.get(selected) || result);
      },
      'load',
      {action: 'library_load', record: {room: selected.room}},
    );
  }
  function showRecord() {
    batch(() => {
      store.record.value = record;
      store.recordMeta.value = (
        isSubmission()
          ? [
              record.uploader,
              record.partTitle ? `P${record.part} · ${record.partTitle}` : '',
              `导出 ${record.qualityLabel}`,
            ]
          : [record.member, formatDate(record.start), record.schedule?.type]
      )
        .filter(Boolean)
        .join(' · ');
      store.exportMode.value = exportMode();
    });
  }
  function enrichRecordType() {
    if (!record || isSubmission() || record.schedule !== undefined || !isOpen()) return;
    scheduleController?.abort();
    const own = new AbortController();
    scheduleController = own;
    const selected = record;
    void schedules
      .enrich([selected], {signal: own.signal})
      .then(result => {
        if (own.signal.aborted || record !== selected || store.page.value !== 'edit') return;
        record = result.records[0];
        showRecord();
      })
      .catch(() => {});
  }
  async function loadRecord(next, signal) {
    usePlayer('live');
    record = next;
    previewDiagnostic = diagnostics.begin('preview', {pageUrl: readPageUrl(), record: next});
    loadedRoute = null;
    showPage('edit');
    showRecord();
    enrichRecordType();
    status('正在加载录像…');
    const {total, streams} = await player.load(record, signal);
    if (preview) signal.throwIfAborted();
    playbackTotal = total;
    updateClock(0);
    recordingController = new AbortController();
    recordingPlan = new RecordingPlan(mediaApi, streams, recordingController.signal);
    danmakuPreview.setSource({
      record,
      part: record.live ? streams.at(-1) : streams[0],
      loadGroups: (signal, part) => {
        const plan = recordingPlan;
        return plan.loadPart(
          plan.streams.findIndex(item => item.start_time === part.start_time),
          signal,
        );
      },
      request: mediaApi.request,
    });
    // Warm only the current part alongside the player. Full-recording work
    // (such as size estimates) starts after the first video frame.
    void recordingPlan.loadPart(record.live ? streams.length - 1 : 0).catch(() => {});
    recordStreams = streams;
    segments = segmentBounds(record, streams, total);
    thumbnails.load(record, streams, {defer: true, onFrames: () => player.refreshStill?.()});
    ready = true;
    selectSegment(record.live ? segments.length - 1 : 0);
    player.refreshStill?.();
    $('editPage').focus({preventScroll: true});
    updater.start(record);
    if (preview) void marks?.refresh();
  }
  function segmentBounds(owner, streams, total) {
    // Only advertise generated footage, including when the last live segment
    // lags behind wall time or a disconnect creates a new segment.
    return streams.map(stream => ({
      start: clamp(stream.start_time - owner.start, 0, total),
      end: clamp(stream.end_time - owner.start, 0, total),
    }));
  }
  function renderSegments() {
    batch(() => {
      store.segments.value = segments.map(bounds => ({
        ...bounds,
        label: formatTimeRange(bounds.start, bounds.end, '–'),
      }));
      store.segmentIndex.value = segmentIndex;
    });
    controls();
  }
  function selectSegment(index) {
    const bounds = segments[index],
      stream = recordStreams[index];
    segmentIndex = index;
    player.pause();
    timeline.reset(bounds);
    clipSelection = store.whole.value ? {...bounds} : null;
    // Live recordings open near the newest picture; replays open at the segment start.
    seekTo(
      record.live && index === segments.length - 1
        ? Math.max(bounds.start, stream.end_time - record.start - 15)
        : bounds.start,
    );
    renderSegments();
  }
  // Keeps the selection and position. Only a recording that never opened starts over.
  async function refreshRecording() {
    if (!allowed() || !record) return;
    if (!ready) {
      await enterRecord(record);
      return;
    }
    await job(
      async signal => {
        status('正在刷新录像…');
        await updater.refresh(record, signal);
        player.reload();
      },
      'load',
      {action: 'record_refresh', record},
    );
  }
  async function enterRecord(next) {
    await job(
      signal => {
        leavePage();
        return loadRecord(next, signal);
      },
      'load',
      {action: 'record_load', record: next},
    );
  }
  const offline = (title, reason) => (store.offline.value = {title, reason});
  async function currentRoom() {
    await job(
      async (signal, diagnostic) => {
        leavePage();
        offline('暂时无法打开本场直播', '正在加载…');
        showPage('offline');
        try {
          const source = MEMBERS.find(m => m.room === room) || {room, name: '当前直播间'};
          const next = await api.current(source, signal, {allowOffline: true});
          if (!next) {
            offline('当前没有直播', '可以看看历史回放。');
            return;
          }
          await loadRecord(next, signal);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          diagnostic.fail(e, signal);
          showPage('offline');
          offline('暂时无法打开本场直播', e.message);
        }
      },
      'load',
      {action: 'room_load', record: {room}},
    );
  }
  async function currentVideo() {
    const url = readPageUrl(),
      route = parseSubmissionUrl(url);
    if (!route || controller) return;
    await job(
      async (signal, diagnostic) => {
        leavePage();
        loadedRoute = null;
        offline('暂时无法打开当前视频', '正在加载…');
        showPage('offline');
        try {
          const next = await submissions.load(url, {signal});
          signal.throwIfAborted();
          usePlayer('submission');
          record = next;
          showPage('edit');
          showRecord();
          loadedRoute = route.key;
          const {total} = await player.load(record, signal);
          signal.throwIfAborted();
          playbackTotal = total;
          thumbnails.load(record, []);
          timeline.reset(total);
          ready = true;
          timeline.setCurrent(player.position());
          updateClock(player.position());
          if (!isOpen()) player.suspend();
          $('editPage').focus({preventScroll: true});
        } catch (error) {
          if (signal.aborted) throw error;
          diagnostic.fail(error, signal);
          loadedRoute = null;
          ready = false;
          player?.clear();
          showPage('offline');
          offline('暂时无法打开当前视频', error.message);
          status(error.message, true);
        }
      },
      'load',
      {action: 'video_load', record: null},
    );
  }
  function checkCurrentVideo() {
    if (!allowed()) return;
    const route = parseSubmissionUrl(readPageUrl()),
      key = route?.key;
    if (key === observedRoute) {
      if (playerKind === 'submission' && isOpen()) player.refresh();
      return;
    }
    observedRoute = key;
    controls();
    if (!route || !isOpen()) return;
    if (controller) {
      if (jobKind === 'load') {
        pendingRoute = true;
        controller.abort();
      }
      return;
    }
    void currentVideo();
  }
  async function open() {
    syncTheme();
    store.open.value = true;
    if (!allowed()) return;
    if (preview) void marks?.opened();
    if (playerKind === 'submission') player.resume();
    void versionControl.refresh();
    const route = parseSubmissionUrl(readPageUrl());
    observedRoute = route?.key;
    if (route && (!initialized || loadedRoute !== route.key)) {
      initialized = true;
      await currentVideo();
      return;
    }
    if (!initialized) {
      initialized = true;
      await (room ? currentRoom() : library());
    } else if (store.page.value === 'library') {
      renderCards();
      const selected = member();
      void libraries
        .load(selected)
        .then(result => {
          if (member() !== selected || store.page.value !== 'library' || !isOpen()) return;
          renderCards();
          showScheduleResult(libraries.get(selected) || result);
        })
        .catch(() => {});
    } else if (store.page.value === 'edit') {
      enrichRecordType();
      if (ready && record?.live) updater.start(record);
    }
  }
  function close() {
    updater.stop();
    timeline.stop();
    batch(() => {
      store.open.value = false;
      store.settingsOpen.value = false;
      store.feedbackOpen.value = false;
    });
    scheduleController?.abort();
    if (playerKind === 'submission') {
      player.suspend();
      thumbnails.clear();
      if (record) thumbnails.load(record, []);
      submissionThumbnails = false;
    } else playback.cancel();
  }
  exporter = createExportActions({
    job,
    status,
    saveFilePicker,
    storage,
    mediaRequest,
    mediaApi,
    timeline,
    clearDownloads,
    refreshControls: controls,
    view: {
      progress: value => (store.progress.value = value),
      estimate: text => (store.estimate.value = text),
      saved: text => (store.downloads.value = [...store.downloads.value, text]),
    },
    session: {
      busy: () => Boolean(controller),
      ready: () => ready,
      record: () => record,
      isSubmission,
      player: () => player,
      plan: () => recordingPlan,
      estimate: () => estimate,
      exportMode,
      danmaku: () => (!isSubmission() && !store.whole.value && exportMode() === 'danmaku' ? {adjustment: 0} : null),
      segments: () => segments,
      segmentIndex: () => segmentIndex,
      total: () => playbackTotal,
    },
  });
  editorInput = bindEditorInput({
    root,
    timeline,
    status,
    getPlayer: () => player,
    togglePlayback: () => activePlayback()?.toggle(),
    // While submitting, the editor underneath takes no keys.
    isActive: () => ready && !controller && isOpen() && !composer?.view.value.open,
    isWhole: () => store.whole.value,
    keys: preview ? {c: () => void setCover()} : {},
  });
  bindShortcut({
    root,
    get,
    set,
    onPress: () => (isOpen() ? close() : void open()),
    ...(preview ? {accepts: value => marks?.acceptsPanelShortcut(value) ?? true} : {}),
  });
  const unbindPageProgress = bindPageProgress({
    document,
    getPlayer: () => player,
    isActive: () =>
      playerKind === 'submission' &&
      ready &&
      (!controller || jobKind === 'export') &&
      isOpen() &&
      parseSubmissionUrl(readPageUrl())?.key === loadedRoute,
  });
  const navigationTimer = setInterval(checkCurrentVideo, 500);
  window.addEventListener('popstate', checkCurrentVideo);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    if (preview) {
      marks?.dispose();
      composer?.dispose();
    }
    unbindPageProgress();
    clearInterval(navigationTimer);
    window.removeEventListener('popstate', checkCurrentVideo);
    controller?.abort();
    libraries.abortAll();
    leavePage();
    player?.destroy();
    danmakuPreview.destroy();
  });
  // Only prepare the list once someone reaches for the panel: this runs on every
  // Bilibili page, and account-bound requests there would add up across tabs.
  let preloaded = Boolean(room || parseSubmissionUrl(readPageUrl()));
  const preload = () => {
    if (allowed() && !preloaded) {
      preloaded = true;
      void libraries.preload(member());
    }
  };
  $('launcher').addEventListener('pointerenter', preload);
  $('launcher').addEventListener('focusin', preload);
  if (preview) {
    // The compose sheet renders the hosts its form and cover editor are built into.
    const ui = {MarkPins, MarksPanel, MiniMarks, ComposeSheet, CoverButton, CoverPin};
    store.extras.value = {ui};
    composer = createComposer({
      root,
      client: studio,
      gmRequest: options => GM_xmlhttpRequest(options),
      mediaApi,
      storage,
      schedules,
      session: {
        ready: () => allowed() && ready && !controller && !isSubmission(),
        pause: () => player?.pause(),
        captureFrame: selection => captureCover(selection),
        isSubmission,
        whole: () => store.whole.value,
        snapshot: () => ({
          record: {...record},
          selection: {...timeline.getSelection()},
          mode: exportMode(),
          streams: [...recordingPlan.streams],
          segmentIndex,
          estimate,
        }),
      },
    });
    marks = createMarksSession({
      root,
      client: studio,
      get,
      set,
      keys: storageKeys,
      api,
      mediaRequest,
      pageUrl: readPageUrl,
      notify: (text, options) => toast(store, text, options),
      report: (error, details) => diagnostics.begin('mark_sync', {pageUrl: readPageUrl(), ...details}).fail(error),
      onLogout() {
        composer.logout();
        controller?.abort();
        libraries.abortAll();
        leavePage();
        initialized = false;
        store.settingsOpen.value = false;
        showPage('library');
      },
      session: {
        isOpen,
        open,
        record: () => record,
        ready: () => ready && !controller,
        view: () => timeline.getView(),
        groups: () => recordingPlan.load(),
        signal: () => recordingController.signal,
        refresh: async () => {
          if (!ready || controller || !record?.live) return;
          await updater.refresh(record, recordingController.signal);
        },
        select(selection, mark) {
          if (!allowed() || !ready || controller) return;
          store.whole.value = false;
          selectSegment(selection.part.index);
          const offset = selection.part.start_time - record.start;
          timeline.setSelection({start: offset + selection.start, end: offset + selection.end}, true);
          composer.markSelected(mark);
          seekTo(offset + selection.start);
          controls();
        },
      },
    });
    store.extras.value = {
      ui,
      marks,
      composer,
      // From a mark row: select its clip, then start the submission with that mark linked.
      composeMark: async mark => {
        if (await marks.actions.jump(mark)) composer.actions.start();
      },
      expand: () => void open(),
      bindMiniWindow: panelWindow.bindMiniWindow,
    };
    // Block stale controls and synthetic UI events immediately on logout.
    for (const type of ['click', 'keydown', 'change', 'submit'])
      root.addEventListener(
        type,
        event => {
          if (allowed() || event.target.closest('#studioLogin, #launcher, #close, #miniMarks')) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
  }
  controls();
  return {open, root};
}
