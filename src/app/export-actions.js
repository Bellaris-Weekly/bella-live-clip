import {createTemporaryMedia, ensureTemporarySpace} from '../media/temporary-media.js';
import {estimateSelectionBytes} from '../media/recording-estimate.js';
import {fileName} from '../media/file-name.js';
import {renderExportProgress} from '../ui/export-progress.js';
import {formatBytes, formatDuration} from '../shared/format.js';

const NO_FILE_SAVING = '当前浏览器不支持保存文件，请使用 Chrome 或 Edge。';
const MP4_FILE = {description: 'MP4 视频', accept: {'video/mp4': ['.mp4']}};

// `session` reads the open recording's live state. Each export copies what it
// needs before its first await, so a later page change cannot alter a running one.
export function createExportActions({
  root,
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
}) {
  const $ = id => root.getElementById(id);
  let wholeStop = null,
    finishing = false;
  const submissionBytes = (record, selection) =>
    ((record.media.video.bandwidth + (record.media.audio?.bandwidth || 0)) * (selection.end - selection.start)) / 8;
  const showSaved = output => {
    const line = document.createElement('p');
    line.textContent = `已保存 ${output.name} · ${formatBytes(output.bytes)}`;
    $('downloads').append(line);
  };

  async function exportVideo(record, selection, destination, {signal, onProgress}) {
    const {exportSubmission} = await import('../media/submission-export.js');
    const output = await exportSubmission(mediaRequest, record, selection, {
      signal,
      precise: session.exportMode() === 'precise',
      onProgress,
      fileHandle: destination,
    });
    showSaved({...output, name: destination.name});
  }

  async function exportClip(record, selection, destination, {signal, onProgress}) {
    const estimate = session.estimate();
    await ensureTemporarySpace(storage, estimate ? estimateSelectionBytes(estimate, record.start, selection) : 0);
    const segmentIndex = session.segmentIndex();
    const groups = (await session.plan().load(signal)).filter(group => group.streamIndex === segmentIndex);
    const {exportSelection} = await import('../media/export.js');
    await exportSelection(mediaApi, record, groups, selection, {
      signal,
      precise: session.exportMode() === 'precise',
      onProgress,
      createTemporary: options => createTemporaryMedia({...options, storage}),
      createFile: () => ({handle: destination, name: destination.name, remove: async () => {}}),
      onSaved: showSaved,
    });
  }

  async function exportSelected() {
    if (session.busy() || !session.ready()) return;
    const record = session.record(),
      submission = session.isSubmission(),
      selection = timeline.getSelection();
    const estimate = session.estimate();
    await job(
      async (signal, diagnostic) => {
        diagnostic.stage('select_destination');
        if (!saveFilePicker || (!submission && !storage?.getDirectory)) throw new Error(NO_FILE_SAVING);
        // Pick the destination before the first network await, while click activation
        // is still live. A clip stays inside one segment, so it is always one file; a
        // file picker also works in Downloads/Desktop, which Chrome refuses as directories.
        const destination = await saveFilePicker({
          suggestedName: fileName(record, selection.start, selection.end),
          types: [MP4_FILE],
        });
        signal.throwIfAborted();
        if (submission) session.player().cancel();
        else session.player().pause();
        clearDownloads();
        status('正在导出…');
        diagnostic.stage('preparing');
        const onProgress = progress => {
          diagnostic.progress(progress);
          renderExportProgress($('progress'), status, progress, submission);
          if (submission && progress.estimatedBytes !== null)
            $('estimatedSize').textContent = `约 ${formatBytes(progress.estimatedBytes)}`;
        };
        await (submission ? exportVideo : exportClip)(record, selection, destination, {signal, onProgress});
        status('导出完成。');
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
        const handle = await saveFilePicker({
          suggestedName: fileName(record, bounds.start, bounds.end, suffix),
          types: [MP4_FILE],
        });
        signal.throwIfAborted();
        session.player().pause();
        clearDownloads();
        status('正在导出整场…');
        diagnostic.stage('preparing');
        const groups = (await session.plan().load(signal)).filter(group => group.streamIndex === index);
        signal.throwIfAborted();
        wholeStop = new AbortController();
        refreshControls();
        const {saveRecording} = await import('../media/recording.js');
        const result = await saveRecording(mediaApi, groups, handle, {
          signal,
          stopSignal: wholeStop.signal,
          onProgress: progress => {
            diagnostic.progress(progress);
            if (progress.progress !== undefined) $('progress').value = progress.progress * 100;
            if (progress.phase === 'stopping' || progress.phase === 'finalizing') {
              finishing = true;
              refreshControls();
              status('正在保存…');
            } else if (progress.phase !== 'saved') {
              const state = progress.reconnecting ? `网络波动，正在重连（第 ${progress.attempt} 次）` : '导出整场';
              status(`${state} · ${formatBytes(progress.speed)}/秒 · 已写入 ${formatBytes(progress.written)}`);
            }
          },
        });
        if (!result.saved) {
          status('已停止。');
          return;
        }
        status(result.stopped ? '已停止。' : '导出完成。');
        const message = document.createElement('p');
        message.textContent = `已保存${result.stopped ? '已完成部分' : '整场'} · ${formatDuration(result.duration)} · ${formatBytes(result.bytes)}`;
        $('downloads').append(message);
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
