import {
  Input, BlobSource, MP4, MPEG_TS, EncodedPacketSink, Conversion,
} from 'mediabunny';
import { selectPlaylistRange } from './playlist.js';
import { trimPrecise } from './smart-trim.js';
import { recordingTime } from './recording-timeline.js';
import { saveRecording } from './recording.js';
import { segmentKey } from './segment-loader.js';
import { createMediaOutput } from './file-output.js';
import { createTemporaryMedia, mediaStorageError } from './temporary-media.js';
import { requestWithRetry } from '../services/retry-request.js';

// The caller owns the Input so HLS and Blob inputs use the same conversion path.
export async function convertInput(input, { start, end, precise = false, signal, onProgress = () => {}, onProcessingStart = () => {}, fileHandle } = {}) {
  signal?.throwIfAborted();
  if (precise) return trimPrecise(input, { start, end, signal, onProgress, onProcessingStart, fileHandle });
  const session = await createMediaOutput({ fileHandle, signal }), { output } = session;
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
    return await session.finish();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (canceling) await canceling;
    await session.cancel();
  }
}

export async function convertMp4(blob, options = {}) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4, MPEG_TS] });
  try { return await convertInput(input, options); }
  finally { input.dispose(); }
}

// Boundary probes use native packet times, never the HLS clock heuristic. A
// GOP may span any number of files; extend until a real random-access point is
// found, not a fixed "one extra segment" rule. Only boundary files are cached.
async function extendPlan(group, plan, read, signal) {
  const first = group.segments.indexOf(plan.segments[0]);
  const last = group.segments.indexOf(plan.segments.at(-1));
  let from = first, to = last;
  async function keys(index) {
    const segment = group.segments[index], parts = group.map ? [await read(group.map), await read(segment)] : [await read(segment)];
    const input = new Input({ source: new BlobSource(new Blob(parts)), formats: [MP4, MPEG_TS] });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('录像没有可读取的画面。');
      const origin = await input.getFirstTimestamp(), result = [];
      for await (const packet of new EncodedPacketSink(track).packets()) {
        signal?.throwIfAborted();
        if ((await track.determinePacketType(packet) ?? packet.type) === 'key') result.push(packet.timestamp - origin);
      }
      return result;
    } finally { input.dispose(); }
  }
  while (from > 0) {
    const times = await keys(from);
    if (times.some(time => time <= (from === first ? plan.start : Infinity))) break;
    from--;
  }
  const lastStart = plan.segments.slice(0, -1).reduce((sum, segment) => sum + segment.duration, 0);
  while (to < group.segments.length - 1) {
    const times = await keys(to);
    if (times.some(time => time >= (to === last ? plan.end - lastStart : -Infinity))) break;
    to++;
  }
  return { segments: group.segments.slice(from, to + 1), map: group.map };
}

// Translate within the selected segment, retaining native time between files.
// At an exact manifest boundary use the actual end, including duration drift.
function selectionTime(plan, entries, point, endBoundary) {
  let cursor = 0;
  for (const segment of plan.segments) {
    const next = cursor + segment.duration;
    if (point < next || (endBoundary && point <= next + 1e-6)) {
      const entry = entries.get(segmentKey(segment));
      if (!entry) {
        // An undecodable prefix was skipped. The first retained media starts at
        // zero; this follows the same contract as full-recording export.
        return 0;
      }
      if (endBoundary && Math.abs(point - next) <= 1e-6) return entry.end;
      return recordingTime(Math.min(entry.end, entry.start + point - cursor));
    }
    cursor = next;
  }
  return entries.get(segmentKey(plan.segments.at(-1)))?.end ?? 0;
}

// Normalize each selected discontinuity to temporary disk using the exact same
// packet timeline as full download, then trim from that seekable MP4 into the
// destination. No combined HLS Input or whole-file ArrayBuffer is involved.
export async function exportSelection(api, record, groups, selection, {
  signal, precise = false, onProgress = () => {}, onSaved = () => {}, createFile,
  createTemporary = createTemporaryMedia,
} = {}) {
  signal?.throwIfAborted();
  const parsed = { groups: groups.filter(group => selection.start < group.streamEnd - record.start)
    .map(group => ({ ...group, offset: group.start - record.start })) };
  const plans = parsed.groups.flatMap(group => selectPlaylistRange({ groups: [group] }, selection.start, selection.end)
    .map(plan => ({ ...plan, group })));
  if (!plans.length) throw new Error('选区中没有可用录像，请调整起止位置。');
  const outputs = [], downloaded = new Set();
  const totalDuration = plans.reduce((sum, plan) => sum + plan.end - plan.start, 0);
  let completedDuration = 0;
  const resources = new Set(plans.flatMap(plan => (plan.map ? [plan.map, ...plan.segments] : plan.segments)).map(segmentKey));
  let bytes = 0, progress = 0, processing = 0, reconnecting = 0, attempt = 0, message;
  function report(phase = 'preparing') {
    onProgress({ progress, processing, bytes, downloaded: downloaded.size, count: resources.size,
      phase, reconnecting, attempt, message });
  }
  report();
  for (const [index, plan] of plans.entries()) {
    let temporary, input, destination, saved = false;
    const entries = new Map(), cache = new Map();
    const { group } = plan, weight = plan.end - plan.start;
    async function read(segment) {
      const key = segmentKey(segment);
      if (cache.has(key)) return cache.get(key);
      resources.add(key);
      const response = await requestWithRetry(api, segment.url, { type: 'arraybuffer', range: segment.range, signal }, {
        onRetry(state) { reconnecting = state ? 1 : 0; attempt = state?.attempt ?? 0; report(); },
      });
      signal?.throwIfAborted();
      const data = new Uint8Array(response.data);
      bytes += data.byteLength; downloaded.add(key); report();
      cache.set(key, data);
      // Map plus the two boundary probes. Long undecodable prefixes cannot
      // accumulate the whole selection in memory.
      for (const old of cache.keys()) {
        if (cache.size <= 3) break;
        if (old !== (group.map && segmentKey(group.map))) cache.delete(old);
      }
      return data;
    }
    try {
      temporary = await createTemporary({ signal });
      signal?.throwIfAborted();
      message = '正在整理录像并写入临时文件';
      const expanded = await extendPlan(group, plan, read, signal);
      for (const segment of expanded.segments) resources.add(segmentKey(segment));
      const savingApi = { async request(url, options) {
        const key = segmentKey({ url, range: options.range });
        let data = cache.get(key);
        if (data) { cache.delete(key); return { data }; }
        const response = await api.request(url, options);
        bytes += response.data.byteLength; downloaded.add(key);
        return response;
      } };
      await saveRecording(savingApi, [expanded], temporary.handle, { signal, concurrency: 2,
        onSegment(entry) { entries.set(segmentKey(entry.segment), entry); },
        onProgress(state) {
          reconnecting = state.reconnecting; attempt = state.attempt;
          processing = Math.max(processing, (completedDuration + weight * .65 * state.progress) / totalDuration);
          progress = Math.max(progress, Math.min(.99, processing)); report();
        },
      });
      cache.clear();
      signal?.throwIfAborted();
      input = new Input({ source: new BlobSource(await temporary.handle.getFile()), formats: [MP4] });
      const duration = await input.computeDuration();
      const start = Math.max(0, selectionTime(plan, entries, plan.start, false));
      const end = Math.min(duration, selectionTime(plan, entries, plan.end, true));
      if (end <= start) throw new Error('选区内没有可导出的音视频，请调整起止位置。');
      destination = await createFile({ start: plan.offset + plan.start, end: plan.offset + plan.end, index, count: plans.length });
      signal?.throwIfAborted();
      message = '正在裁剪并写入文件';
      const result = await convertInput(input, { start, end, precise, signal, fileHandle: destination.handle,
        onProgress(value, detail) {
          if (detail?.message) message = detail.message;
          processing = Math.max(processing, (completedDuration + weight * (.65 + .35 * value)) / totalDuration);
          progress = Math.max(progress, Math.min(.99, processing)); report('processing');
        },
      });
      saved = true;
      const output = { ...result, name: destination.name, start: plan.offset + plan.start,
        end: plan.offset + plan.end };
      outputs.push(output);
      completedDuration += weight;
      onSaved(output);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw mediaStorageError(error);
    } finally {
      input?.dispose(); cache.clear();
      try { if (destination && !saved) await destination.remove(); }
      finally { if (temporary) await temporary.remove(); }
    }
  }
  progress = processing = 1; message = '已保存到所选文件夹'; report('complete');
  return outputs;
}
