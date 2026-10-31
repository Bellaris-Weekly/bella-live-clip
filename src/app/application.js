import metadataText from '../header.txt';
import {readScriptMetadata, createUpdateChecker} from '../services/updates.js';
import {createVersionControl} from '../ui/version.js';
import html from '../ui/template.html';
import css from '../ui/styles.css';
import {createControls} from '../ui/controls.js';
import {createRecordCard} from '../ui/record-card.js';
import {icon} from '../ui/icons.js';
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
import {createPlayback, bindVideoControls} from '../media/playback.js';
import {createThumbnails} from '../media/thumbnails.js';
import {sharePlaylists} from '../services/shared-playlists.js';
import {estimateRecordingRate, estimateSelectionBytes} from '../media/recording-estimate.js';
import {MEMBERS, roomIdFromUrl} from '../domain/records.js';
import {clamp} from '../shared/math.js';
import {formatDuration, formatTimeRange, formatDate, formatBytes} from '../shared/format.js';

export function createApp({
  api,
  diagnostics = createDiagnosticReporter(),
  submissionRequest = api.request,
  mediaRequest = api.request,
  get = (_, fallback) => fallback,
  set = () => {},
  pageUrl = () => location.href,
  saveFilePicker = typeof window.showSaveFilePicker === 'function' ? window.showSaveFilePicker.bind(window) : null,
  storage = globalThis.navigator?.storage,
}) {
  const host = document.createElement('div');
  host.id = 'bella-live-clip-host';
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = `<style>${css}</style>${html}`;
  document.documentElement.append(host);
  const syncTheme = () => {
    const page = document.documentElement;
    host.dataset.theme = page.classList?.contains?.('bili_dark') || page.dataset?.theme === 'dark' ? 'dark' : 'light';
  };
  syncTheme();
  const $ = id => root.getElementById(id),
    video = $('fullVideo');
  const readPageUrl = typeof pageUrl === 'function' ? pageUrl : () => pageUrl;
  const room = roomIdFromUrl(readPageUrl()),
    submissions = createSubmissionService(submissionRequest);
  let player = null,
    playerKind = null,
    loadedRoute = null,
    observedRoute = parseSubmissionUrl(readPageUrl())?.key,
    jobKind = null,
    pendingRoute = false,
    submissionThumbnails = false;
  const isSubmission = () => record?.kind === 'submission';
  const metadata = readScriptMetadata(metadataText);
  const versionControl = createVersionControl({
    root,
    metadata,
    check: createUpdateChecker({request: api.request, metadata}),
  });
  for (const [id, name] of [
    ['close', 'close'],
    ['refreshLibrary', 'refresh'],
    ['refreshEditor', 'refresh'],
    ['togglePlayback', 'play'],
  ])
    $(id).innerHTML = icon(name);
  $('back').innerHTML = icon('back') + '<span>选择直播</span>';
  $('download').innerHTML = '<span>导出</span>' + icon('download');
  $('launcher').innerHTML = icon('scissors') + '<span>切片</span>';
  for (const m of MEMBERS) {
    const button = document.createElement('button');
    button.dataset.member = m.id;
    const dot = document.createElement('i');
    dot.style.backgroundColor = m.color;
    button.append(dot, document.createTextNode(m.name));
    $('members').append(button);
  }
  let member = MEMBERS.find(m => m.room === room) || MEMBERS.find(m => m.id === get('member', 'bella')) || MEMBERS[0];
  let page = 'library',
    record = null,
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
  function setTitle(element, text) {
    element.textContent = text;
    element.classList.toggle('hanging-title', /^[\p{Ps}\p{Pi}]/u.test(text));
  }
  const schedules = new ScheduleService(api.request);
  const libraries = createLibraryLoader({
    api,
    schedules,
    backgroundEnrichment: true,
    store: {read: id => get(`library.${id}`, null), write: (id, value) => set(`library.${id}`, value)},
    onUpdate(selected, result) {
      if (member.id === selected.id && page === 'library' && !$('panel').hidden) {
        renderCards();
        showScheduleResult(result);
      }
    },
  });
  let scheduleController = null,
    backgroundStarted = false;
  // Live clips default to lossless; video clips keep their exact cut, as they always have.
  const exportModes = {live: get('exportMode.live', 'copy'), submission: get('exportMode.submission', 'precise')};
  const modeKind = () => (isSubmission() ? 'submission' : 'live'),
    exportMode = () => exportModes[modeKind()];
  function renderExportMode() {
    root
      .querySelectorAll('[data-mode]')
      .forEach(el => el.setAttribute('aria-pressed', el.dataset.mode === exportMode()));
  }
  const panelWindow = createPanelWindow({root, get, set});
  let exporter = null,
    editorInput = null;
  const status = (text, error = false) => {
    $('status').textContent = text;
    $('status').dataset.error = error;
    updateFeedback();
  };
  function updateFeedback() {
    $('feedback').hidden = !controller && $('status').dataset.error !== 'true' && !$('downloads').childElementCount;
  }
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
  const playback = createPlayback(video, status, {
    getRange: () => (ready ? timeline.getSelection() : null),
    position: () => player?.position() ?? 0,
    seek: seekTo,
  });
  const activePlayback = () => (playerKind === 'submission' ? player : playback);
  bindVideoControls(video, playback, status);
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
  const thumbnails = createThumbnails({
    container: $('thumbnails'),
    request: mediaApi.request,
    metadataRequest: submissionRequest,
    createStoryboard: ({submission}) => storyboardFor(submission),
    locate: async (time, signal) =>
      recordingPlan ? locateSegment(await recordingPlan.load(signal), record.start + time) : null,
  });
  const timeline = createTimeline({
    track: $('timeline'),
    startHandle: $('startHandle'),
    endHandle: $('endHandle'),
    selectionElement: $('selection'),
    playhead: $('playhead'),
    ticks: $('ticks'),
    onRange: range => editorInput?.renderRange(range),
    onPreview: t => {
      if (playerKind === 'live') player.scrub(t);
      else player?.seek(t);
      updateClock(t);
    },
    onScrubStart: () => {
      activePlayback()?.begin();
      if (playerKind === 'live') player.beginScrub();
      if (isSubmission()) {
        submissionThumbnails = true;
        thumbnails.update(timeline.getView());
      }
    },
    onScrubEnd: (_, {canceled = false} = {}) => {
      if (playerKind === 'live') player.endScrub();
      activePlayback()?.end({commit: !canceled});
    },
    onSelection: selection => {
      updateExportSummary(selection);
      activePlayback()?.check();
    },
    onView: (view, motion) => {
      $('timelineZoom').textContent = $('timeline').dataset.zoom;
      if (!isSubmission() || submissionThumbnails) thumbnails.update(view, motion);
    },
  });
  const updater = createRecordingUpdater({
    api,
    onUpdate: applyStreams,
    canRefresh: () =>
      ready &&
      record?.live &&
      page === 'edit' &&
      !controller &&
      !$('panel').hidden &&
      !document.hidden &&
      !timeline.isInteracting(),
  });
  const updateClock = t => {
    $('clock').textContent = formatTimeRange(t, playbackTotal, ' / ');
  };
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
  let lastPlaybackPaused;
  const syncPlayback = () => {
    const paused = playerKind === 'submission' ? player.isPaused() : video.paused || video.ended;
    if (paused === lastPlaybackPaused) return;
    lastPlaybackPaused = paused;
    $('togglePlayback').innerHTML = icon(paused ? 'play' : 'pause');
    $('togglePlayback').setAttribute('aria-label', paused ? '播放' : '暂停');
    $('togglePlayback').title = paused ? '播放' : '暂停';
  };
  for (const event of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(event, syncPlayback);
  function updateExportSummary(selection = timeline.getSelection()) {
    // Both the timeline and the whole-download action refer to the active segment.
    const whole = $('wholeRecording').checked && !isSubmission();
    const range = whole && segments.length ? segments[segmentIndex] : selection;
    $('selectionDuration').textContent = formatDuration(range.end - range.start);
    if (isSubmission()) {
      const rate = record.media.video.bandwidth + (record.media.audio?.bandwidth || 0);
      $('estimatedSize').textContent = rate
        ? `约 ${formatBytes((rate * (selection.end - selection.start)) / 8)}`
        : '大小暂不可用';
      return;
    }
    $('estimatedSize').textContent = estimate
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
    timeline.extend(segments[segmentIndex].end, {whole: $('wholeRecording').checked});
    renderSegments();
    updateClock(player.position());
    updateExportSummary();
    if (backgroundStarted) startEstimate(recordingPlan, recordingController.signal, previousEstimate);
  }
  const updateControls = createControls(root, timeline);
  function controls() {
    const route = parseSubmissionUrl(readPageUrl());
    $('currentVideo').hidden = !route || (page === 'edit' && loadedRoute === route.key);
    $('wholeRecordingLabel').hidden = isSubmission();
    $('playSelection').hidden = !isSubmission();
    const refreshLabel = isSubmission() ? '重新加载视频' : '刷新录像';
    $('refreshEditor').setAttribute('aria-label', refreshLabel);
    $('refreshEditor').title = refreshLabel;
    updateControls({
      busy: Boolean(controller),
      ready,
      page,
      whole: $('wholeRecording').checked,
      stopping: exporter.stopping(),
    });
    updateFeedback();
  }

  function showPage(next) {
    page = next;
    for (const [id, value] of [
      ['library', 'library'],
      ['editPage', 'edit'],
      ['offline', 'offline'],
    ])
      $(id).hidden = next !== value;
    $('body').scrollTop = next === 'library' ? libraryScroll : 0;
    controls();
  }
  async function job(action, kind = 'load', details = {}) {
    if (controller) return;
    const own = new AbortController();
    const diagnostic = diagnostics.begin(details.action || kind, {pageUrl: readPageUrl(), record, ...details});
    controller = own;
    jobKind = kind;
    if (kind === 'export') {
      updater.stop();
      window.addEventListener('beforeunload', holdPage);
    }
    controls();
    try {
      await action(own.signal, diagnostic);
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
      if (kind === 'export' && record?.live && ready && !$('panel').hidden) updater.start(record);
      if (pendingRoute) {
        pendingRoute = false;
        if (!$('panel').hidden) void currentVideo();
      }
    }
  }
  // Refreshing or closing the page cannot resume an export.
  function holdPage(event) {
    event.preventDefault();
    event.returnValue = '';
  }
  function clearDownloads() {
    $('downloads').replaceChildren();
  }
  function leavePage() {
    updater.stop();
    scheduleController?.abort();
    scheduleController = null;
    $('scheduleNote').hidden = true;
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
    ready = false;
    playbackTotal = 0;
    clipSelection = null;
    recordStreams = [];
    segments = [];
    segmentIndex = 0;
    renderSegments();
    $('wholeRecording').checked = false;
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
    const focusedKey = root.activeElement?.dataset.recordKey,
      scroll = $('body').scrollTop;
    root
      .querySelectorAll('[data-member]')
      .forEach(el => el.setAttribute('aria-pressed', el.dataset.member === member.id));
    const records = libraries.get(member)?.records || [];
    $('cards').replaceChildren();
    $('libraryEmpty').hidden = records.length > 0;
    $('libraryEmpty').textContent = '近 14 天暂无可用回放';
    for (const r of records) {
      const card = createRecordCard(r, () => {
        libraryScroll = $('body').scrollTop;
        void enterRecord(r);
      });
      card.dataset.recordKey = r.key;
      $('cards').append(card);
      if (r.key === focusedKey) card.focus({preventScroll: true});
    }
    $('body').scrollTop = scroll;
    controls();
  }
  function showScheduleResult(result) {
    $('scheduleNote').hidden = !result.failed && !result.liveFailed;
    $('scheduleNote').textContent = [
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
    const selected = member;
    await job(
      async signal => {
        status('正在加载场次…');
        const result = await libraries.load(selected, {refresh, signal});
        if (signal.aborted || member !== selected) return;
        renderCards();
        showScheduleResult(libraries.get(selected) || result);
      },
      'load',
      {action: 'library_load', record: {room: selected.room}},
    );
  }
  function renderRecordMeta() {
    $('recordMeta').textContent = (
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
  }
  function enrichRecordType() {
    if (!record || isSubmission() || record.schedule !== undefined || $('panel').hidden) return;
    scheduleController?.abort();
    const own = new AbortController();
    scheduleController = own;
    const selected = record;
    void schedules
      .enrich([selected], {signal: own.signal})
      .then(result => {
        if (own.signal.aborted || record !== selected || page !== 'edit') return;
        record = result.records[0];
        renderRecordMeta();
      })
      .catch(() => {});
  }
  async function loadRecord(next, signal) {
    usePlayer('live');
    record = next;
    previewDiagnostic = diagnostics.begin('preview', {pageUrl: readPageUrl(), record: next});
    loadedRoute = null;
    showPage('edit');
    setTitle($('recordTitle'), record.title);
    renderRecordMeta();
    enrichRecordType();
    renderExportMode();
    status('正在加载录像…');
    const {total, streams} = await player.load(record, signal);
    playbackTotal = total;
    updateClock(0);
    recordingController = new AbortController();
    recordingPlan = new RecordingPlan(mediaApi, streams, recordingController.signal);
    // Stills need the playlist as soon as the player does; they share one copy.
    void recordingPlan.load().catch(() => {});
    recordStreams = streams;
    segments = segmentBounds(record, streams, total);
    thumbnails.load(record, streams, {defer: true, onFrames: () => player.refreshStill?.()});
    ready = true;
    selectSegment(record.live ? segments.length - 1 : 0);
    player.refreshStill?.();
    $('editPage').focus({preventScroll: true});
    updater.start(record);
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
    const container = $('segments');
    container.hidden = segments.length < 2;
    container.replaceChildren(
      ...(segments.length < 2
        ? []
        : segments.map((bounds, i) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-pressed', i === segmentIndex);
            const range = document.createElement('span');
            range.textContent = formatTimeRange(bounds.start, bounds.end, '–');
            button.append(`第 ${i + 1} 段`, range);
            button.onclick = () => {
              if (i !== segmentIndex) selectSegment(i);
            };
            return button;
          })),
    );
    controls();
  }
  function selectSegment(index) {
    const bounds = segments[index],
      stream = recordStreams[index];
    segmentIndex = index;
    player.pause();
    timeline.reset(bounds);
    clipSelection = $('wholeRecording').checked ? {...bounds} : null;
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
    if (!record) return;
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
  async function currentRoom() {
    await job(
      async (signal, diagnostic) => {
        leavePage();
        $('offlineTitle').textContent = '暂时无法打开本场直播';
        showPage('offline');
        $('offlineReason').textContent = '正在加载…';
        try {
          const source = MEMBERS.find(m => m.room === room) || {room, name: '当前直播间'};
          const next = await api.current(source, signal, {allowOffline: true});
          if (!next) {
            $('offlineReason').textContent = '当前没有直播，可以看看历史回放。';
            return;
          }
          await loadRecord(next, signal);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          diagnostic.fail(e, signal);
          showPage('offline');
          $('offlineReason').textContent = e.message;
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
        $('offlineTitle').textContent = '暂时无法打开当前视频';
        showPage('offline');
        $('offlineReason').textContent = '正在加载…';
        try {
          const next = await submissions.load(url, {signal});
          signal.throwIfAborted();
          usePlayer('submission');
          record = next;
          showPage('edit');
          setTitle($('recordTitle'), record.title);
          renderRecordMeta();
          renderExportMode();
          loadedRoute = route.key;
          const {total} = await player.load(record, signal);
          signal.throwIfAborted();
          playbackTotal = total;
          thumbnails.load(record, []);
          timeline.reset(total);
          ready = true;
          timeline.setCurrent(player.position());
          updateClock(player.position());
          if ($('panel').hidden) player.suspend();
          $('editPage').focus({preventScroll: true});
        } catch (error) {
          if (signal.aborted) throw error;
          diagnostic.fail(error, signal);
          loadedRoute = null;
          ready = false;
          player?.clear();
          showPage('offline');
          $('offlineReason').textContent = error.message;
          status(error.message, true);
        }
      },
      'load',
      {action: 'video_load', record: null},
    );
  }
  function checkCurrentVideo() {
    const route = parseSubmissionUrl(readPageUrl()),
      key = route?.key;
    if (key === observedRoute) {
      if (playerKind === 'submission' && !$('panel').hidden) player.refresh();
      return;
    }
    observedRoute = key;
    controls();
    if (!route || $('panel').hidden) return;
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
    $('panel').hidden = false;
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
    } else if (page === 'library') {
      renderCards();
      const selected = member;
      void libraries
        .load(selected)
        .then(result => {
          if (member !== selected || page !== 'library' || $('panel').hidden) return;
          renderCards();
          showScheduleResult(libraries.get(selected) || result);
        })
        .catch(() => {});
    } else if (page === 'edit') {
      enrichRecordType();
      if (ready && record?.live) updater.start(record);
    }
  }
  const close = () => {
    updater.stop();
    timeline.stop();
    $('panel').hidden = true;
    scheduleController?.abort();
    if (playerKind === 'submission') {
      player.suspend();
      thumbnails.clear();
      if (record) thumbnails.load(record, []);
      submissionThumbnails = false;
    } else playback.cancel();
  };
  $('close').onclick = close;
  $('launcher').onclick = () => {
    if (!panelWindow.launcherDragged()) $('panel').hidden ? void open() : close();
  };
  $('currentVideo').onclick = () => void currentVideo();
  $('back').onclick = () => void library();
  $('browseHistory').onclick = () => void library();
  $('retryCurrent').onclick = () => (parseSubmissionUrl(readPageUrl()) ? currentVideo() : currentRoom());
  $('refreshLibrary').onclick = () => void library(true);
  $('refreshEditor').onclick = () => (isSubmission() ? currentVideo() : refreshRecording());
  root.querySelectorAll('[data-member]').forEach(
    el =>
      (el.onclick = () => {
        member = MEMBERS.find(m => m.id === el.dataset.member);
        set('member', member.id);
        libraryScroll = 0;
        void library();
      }),
  );
  $('cancel').onclick = () => {
    if (exporter.stopWhole()) {
      controls();
      status('正在保存…');
    } else controller?.abort();
  };
  $('download').onclick = () => ($('wholeRecording').checked ? exporter.exportWhole() : exporter.exportSelected());
  $('wholeRecording').onchange = () => {
    if ($('wholeRecording').checked) {
      clipSelection = timeline.getSelection();
      timeline.setSelection({...segments[segmentIndex]}, true);
    } else {
      timeline.setSelection(clipSelection, true);
      clipSelection = null;
    }
    controls();
  };
  root.querySelectorAll('[data-mode]').forEach(
    button =>
      (button.onclick = () => {
        const kind = modeKind();
        exportModes[kind] = button.dataset.mode;
        set(`exportMode.${kind}`, button.dataset.mode);
        renderExportMode();
        updateExportSummary();
      }),
  );
  exporter = createExportActions({
    root,
    job,
    status,
    saveFilePicker,
    storage,
    mediaRequest,
    mediaApi,
    timeline,
    clearDownloads,
    refreshControls: controls,
    session: {
      busy: () => Boolean(controller),
      ready: () => ready,
      record: () => record,
      isSubmission,
      player: () => player,
      plan: () => recordingPlan,
      estimate: () => estimate,
      exportMode,
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
    isActive: () => ready && !controller && !$('panel').hidden,
  });
  bindShortcut({root, get, set, onPress: () => ($('panel').hidden ? void open() : close())});
  $('togglePlayback').onclick = () => activePlayback()?.toggle();
  $('playSelection').onclick = () => player.playSelection();
  const unbindPageProgress = bindPageProgress({
    document,
    getPlayer: () => player,
    isActive: () =>
      playerKind === 'submission' &&
      ready &&
      (!controller || jobKind === 'export') &&
      !$('panel').hidden &&
      parseSubmissionUrl(readPageUrl())?.key === loadedRoute,
  });
  const navigationTimer = setInterval(checkCurrentVideo, 500);
  window.addEventListener('popstate', checkCurrentVideo);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    unbindPageProgress();
    clearInterval(navigationTimer);
    window.removeEventListener('popstate', checkCurrentVideo);
    controller?.abort();
    libraries.abortAll();
    leavePage();
    player?.destroy();
  });
  // Only prepare the list once someone reaches for the panel: this runs on every
  // Bilibili page, and account-bound requests there would add up across tabs.
  let preloaded = Boolean(room || parseSubmissionUrl(readPageUrl()));
  const preload = () => {
    if (!preloaded) {
      preloaded = true;
      void libraries.preload(member);
    }
  };
  $('launcher').addEventListener('pointerenter', preload);
  $('launcher').addEventListener('focus', preload);
  controls();
  return {open, root};
}
