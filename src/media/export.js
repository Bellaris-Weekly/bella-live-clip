import {
  Input, BlobSource, HLS, MP4, MPEG_TS, Output, BufferTarget, Mp4OutputFormat, Conversion,
} from 'mediabunny';
import { selectPlaylistRange } from './playlist.js';
import { trimPrecise } from './smart-trim.js';
import { recordingSource } from './recording.js';
import { createSegmentLoader, segmentKey } from './segment-loader.js';

// The caller owns the Input so HLS and Blob inputs use the same conversion path.
export async function convertInput(input, { start, end, precise = false, signal, onProgress = () => {}, onProcessingStart = () => {} } = {}) {
  signal?.throwIfAborted();
  if (precise) return trimPrecise(input, { start, end, signal, onProgress, onProcessingStart });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let conversion, canceling;
  const cancel = () => { if (conversion) canceling = conversion.cancel(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const options = { input, output, copy: { mode: 'forced' }, showWarnings: false };
    if (start !== undefined || end !== undefined) options.trim = { start, end };
    conversion = await Conversion.init(options);
    signal?.throwIfAborted();
    if (!conversion.isValid || conversion.discardedTracks.length) {
      throw new Error('这段录像无法完整封装为 MP4，已停止导出，避免丢失声音或画面。');
    }
    conversion.onProgress = onProgress;
    onProcessingStart();
    await conversion.execute();
    signal?.throwIfAborted();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (canceling) await canceling;
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
  }
}

export async function convertMp4(blob, options = {}) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4, MPEG_TS] });
  try { return await convertInput(input, options); }
  finally { input.dispose(); }
}

// Use the preview's playlist timeline, preserving one output per discontinuity.
export async function exportSelection(api, record, groups, selection, { signal, precise = false, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const parsed = { groups: groups.filter(group => selection.start < group.streamEnd - record.start)
    .map(group => ({ ...group, offset: group.start - record.start })) };
  const plans = selectPlaylistRange(parsed, selection.start, selection.end);
  if (!plans.length) throw new Error('选区中没有可用录像，请调整起止位置。');

  const resources = new Set(plans.flatMap(plan => (plan.map ? [plan.map, ...plan.segments] : plan.segments)).map(segmentKey));
  const downloaded = new Set(), outputs = [];
  const totalDuration = plans.reduce((sum, plan) => sum + plan.end - plan.start, 0);
  let bytes = 0, completedDuration = 0, processing = 0, progress = 0, message;
  function report(phase = 'processing') {
    progress = phase === 'complete' ? 1 : Math.max(progress,
      Math.min(.99, .35 * downloaded.size / resources.size + .65 * processing));
    onProgress({ progress, downloaded: downloaded.size, count: resources.size, bytes, phase, processing, message });
  }
  report('download');

  for (const plan of plans) {
    const durationWeight = plan.end - plan.start;
    const loader = createSegmentLoader(api, plan.segments, { map: plan.map, signal,
      onRead(size, segment) { bytes += size; downloaded.add(segmentKey(segment)); report(); },
    });
    const input = new Input({ source: recordingSource([plan], loader.read), formats: [HLS, MP4, MPEG_TS] });
    try {
      // HLS duration probes the first and last files, without downloading the middle.
      const duration = await input.computeDuration();
      loader.signal.throwIfAborted();
      const start = Math.min(plan.start, duration), end = Math.min(plan.end, duration);
      if (end <= start) throw new Error('选区与录像时间线不一致，请刷新后重新定位。');
      const blob = await convertInput(input, { start, end, precise, signal: loader.signal,
        onProcessingStart: loader.beginProcessing,
        onProgress(value, detail) {
          const local = typeof value === 'number' ? value : value.progress;
          const notice = typeof value === 'number' ? detail : value;
          if (notice?.message) message = notice.message;
          processing = Math.max(processing, (completedDuration + durationWeight * local) / totalDuration);
          report();
        },
      });
      loader.signal.throwIfAborted();
      outputs.push({ blob, start: plan.offset + start, end: plan.offset + end });
      completedDuration += durationWeight;
      processing = completedDuration / totalDuration;
      report();
    } catch (error) {
      if (loader.signal.aborted) throw loader.signal.reason;
      throw error;
    } finally {
      input.dispose();
      await loader.close();
    }
  }
  signal?.throwIfAborted();
  report('complete');
  return outputs;
}
