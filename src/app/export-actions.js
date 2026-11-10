import {createExportMetrics} from '../media/export-metrics.js';
import {createTemporaryMedia, ensureTemporarySpace, mediaStorageError} from '../media/temporary-media.js';
import {LIVE_MISSING_RETRIES} from '../services/retry-request.js';
import {estimateSelectionBytes} from '../media/recording-estimate.js';
import {fileName} from '../media/file-name.js';
import {renderExportProgress, limitProgress} from '../ui/export-progress.js';
import {formatBytes, formatDuration} from '../shared/format.js';

const NO_FILE_SAVING = '当前浏览器不支持保存文件，请使用 Chrome 或 Edge。';
const MP4_FILE = {description: 'MP4 视频', accept: {'video/mp4': ['.mp4']}};

// The picker must be invoked before any await. Its rejection also cancels
// preparation that has already started, including temporary media downloads.
export async function withExportPicker(pick, signal, metrics, work) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const finish = metrics.start('pickerWait');
  let rejectAbort;
  const stopped = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  void stopped.catch(() => {});
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, {once: true});
  if (controller.signal.aborted) onAbort();
  try {
    const picked = Promise.resolve(pick())
      .catch(error => {
        controller.abort(error);
        throw error;
      })
      .finally(finish);
    const destination = Promise.race([picked, stopped]);
    void destination.catch(() => {});
    return await work(destination, controller.signal);
  } catch (error) {
    controller.abort(error);
    throw controller.signal.reason;
  } finally {
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
    finish();
    metrics.close();
  }
}

// `session` reads the open recording's live state. Each export copies what it
// needs before its first await, so a later page change cannot alter a running one.
export function createExportActions({
  session,
  job,
  status,
  saveFilePicker,
  storage,
  mediaRequest,
  mediaApi,
  timeline,
  clearDownloads,
  refreshControls,
  view,
}) {
  let wholeStop = null,
    finishing = false;
  const submissionBytes = (record, selection) =>
    ((record.media.video.bandwidth + (record.media.audio?.bandwidth || 0)) * (selection.end - selection.start)) / 8;
  const showSaved = output => view.saved(`已保存 ${output.name} · ${formatBytes(output.bytes)}`);

  async function loadPlan(signal, metrics) {
    const finish = metrics?.start('playlistLoad');
    try {
      return await session.plan().load(signal);
    } finally {
      finish?.();
    }
  }

  async function exportVideo(record, selection, destination, {signal, onProgress, metrics}) {
    const {exportSubmission} = await import('../media/submission-export.js');
    const output = await exportSubmission(mediaRequest, record, selection, {
      signal,
      precise: session.exportMode() === 'precise',
      onProgress,
      metrics,
      fileHandle: {
        async createWritable(...args) {
          const handle = await destination;
          signal.throwIfAborted();
          return handle.createWritable(...args);
        },
      },
    });
    showSaved({...output, name: (await destination).name});
    return output;
  }

  async function exportClip(record, selection, destination, {signal, onProgress, danmaku, metrics}) {
    const estimate = session.estimate();
    if (!danmaku)
      await ensureTemporarySpace(storage, estimate ? estimateSelectionBytes(estimate, record.start, selection) : 0);
    const segmentIndex = session.segmentIndex();
    const groups = (await loadPlan(signal, metrics)).filter(group => group.streamIndex === segmentIndex);
    const {exportSelection} = await import('../media/export.js');
    return await exportSelection(mediaApi, record, groups, selection, {
      signal,
      precise: session.exportMode() !== 'copy',
      onProgress,
      danmaku,
      metrics,
      createTemporary: options => createTemporaryMedia({...options, storage}),
      // One picked file. A selection across a stream break would need several.
      maxFiles: 1,
      createFile: async () => {
        const handle = await destination;
        signal.throwIfAborted();
        return {handle, name: handle.name, remove: async () => {}};
      },
      onSaved: showSaved,
    });
  }

  async function exportSelected() {
    if (session.busy() || !session.ready()) return;
    const record = session.record(),
      submission = session.isSubmission(),
      selection = timeline.getSelection(),
      danmaku = session.danmaku?.();
    const estimate = session.estimate();
    await job(
      async (signal, diagnostic) => {
        diagnostic.stage('select_destination');
        if (!saveFilePicker || (!submission && !storage?.getDirectory)) throw new Error(NO_FILE_SAVING);
        const metrics = createExportMetrics({observeLongTasks: true});
        diagnostic.observe?.(metrics);
        return withExportPicker(
          () =>
            saveFilePicker({
              suggestedName: fileName(record, selection.start, selection.end),
              types: [MP4_FILE],
            }),
          signal,
          metrics,
          async (destination, signal) => {
            signal.throwIfAborted();
            if (submission) session.player().cancel();
            else session.player().pause();
            clearDownloads();
            status('正在导出…');
            diagnostic.stage('preparing');
            const updateProgress = limitProgress(progress => {
              renderExportProgress(view.progress, status, progress, submission);
              if (submission && progress.estimatedBytes !== null)
                view.estimate(`约 ${formatBytes(progress.estimatedBytes)}`);
            });
            const onProgress = progress => {
              diagnostic.progress(progress);
              updateProgress(progress);
            };
            const result = await (submission ? exportVideo : exportClip)(record, selection, destination, {
              signal,
              onProgress,
              danmaku,
              metrics,
            });
            const files = Array.isArray(result) ? result : [result];
            metrics.close();
            diagnostic.finish?.({
              files: files.length,
              writtenBytes: files.reduce((sum, file) => sum + (file?.bytes ?? 0), 0),
              mediaSeconds: selection.end - selection.start,
            });
            status('导出完成。');
          },
        );
      },
      'export',
      {
        selection,
        mode: session.exportMode(),
        estimatedBytes: submission
          ? submissionBytes(record, selection)
          : estimate
            ? estimateSelectionBytes(estimate, record.start, selection)
            : undefined,
      },
    );
  }

  async function exportWhole() {
    // Keep the picker inside the click activation, before playlist/network work.
    if (session.busy() || !session.ready()) return;
    // Segments are separate recordings: only the selected one is saved, never spliced.
    const record = session.record(),
      segments = session.segments(),
      index = session.segmentIndex();
    const bounds = segments[index] ?? {start: 0, end: session.total()};
    await job(
      async (signal, diagnostic) => {
        diagnostic.stage('select_destination');
        if (!saveFilePicker) throw new Error(NO_FILE_SAVING);
        const suffix = segments.length > 1 ? `_整场_第${index + 1}段` : '_整场';
        const metrics = createExportMetrics({observeLongTasks: true});
        diagnostic.observe?.(metrics);
        return withExportPicker(
          () =>
            saveFilePicker({
              suggestedName: fileName(record, bounds.start, bounds.end, suffix),
              types: [MP4_FILE],
            }),
          signal,
          metrics,
          async (destination, signal) => {
            signal.throwIfAborted();
            session.player().pause();
            clearDownloads();
            status('正在导出整场…');
            diagnostic.stage('preparing');
            const groups = (await loadPlan(signal, metrics)).filter(group => group.streamIndex === index);
            signal.throwIfAborted();
            wholeStop = new AbortController();
            refreshControls();
            const {saveRecording} = await import('../media/recording.js');
            // Whole recordings write immediately; overlap playlist loading only.
            const handle = await destination;
            signal.throwIfAborted();
            const result = await saveRecording(mediaApi, groups, handle, {
              signal,
              metrics,
              stopSignal: wholeStop.signal,
              // Hours of downloaded media must survive one unreadable fragment.
              keepPartial: true,
              missingRetries: record.live ? LIVE_MISSING_RETRIES : 0,
              onProgress: progress => {
                diagnostic.progress(progress);
                if (progress.progress !== undefined) view.progress(progress.progress * 100);
                if (progress.phase === 'stopping' || progress.phase === 'finalizing') {
                  finishing = true;
                  refreshControls();
                  status('正在保存…');
                } else if (progress.phase !== 'saved') {
                  const state = progress.reconnecting ? `网络波动，正在重连（第 ${progress.attempt} 次）` : '导出整场';
                  status(`${state} · ${formatBytes(progress.speed)}/秒 · 已写入 ${formatBytes(progress.written)}`);
                }
              },
            }).catch(error => {
              throw signal.aborted ? error : mediaStorageError(error);
            });
            if (!result.saved) {
              metrics.close();
              diagnostic.finish?.({status: 'canceled', files: 0});
              status('已停止。');
              return;
            }
            metrics.close();
            diagnostic.finish?.({
              status: result.interrupted ? 'partial' : result.stopped ? 'stopped' : 'completed',
              error: result.interrupted,
              files: 1,
              writtenBytes: result.bytes,
              mediaSeconds: result.duration,
            });
            status(
              result.interrupted
                ? `录像分片读取失败${result.interrupted.status ? `（HTTP ${result.interrupted.status}）` : ''}，已保存读取到的部分。`
                : result.stopped
                  ? '已停止。'
                  : '导出完成。',
              Boolean(result.interrupted),
            );
            view.saved(
              `已保存${result.stopped ? '已完成部分' : '整场'} · ${formatDuration(result.duration)} · ${formatBytes(result.bytes)}`,
            );
          },
        );
      },
      'export',
      {action: 'recording_download', selection: {...bounds}, mode: 'whole'},
    );
  }

  return {
    exportSelected,
    exportWhole,
    stopping: () => finishing || Boolean(wholeStop?.signal.aborted),
    // A whole export stops gracefully and keeps what it has written.
    stopWhole() {
      if (!wholeStop) return false;
      wholeStop.abort();
      return true;
    },
    reset() {
      wholeStop = null;
      finishing = false;
    },
  };
}
