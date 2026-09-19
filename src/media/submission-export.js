import { openSubmissionMedia } from './remote-mp4.js';
import { trimCopyTracks, trimPreciseTracks } from './smart-trim.js';

export async function exportSubmission(request, submission, selection, { signal, precise = false, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const { start, end } = selection;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > submission.duration + .001) {
    throw new Error('视频选区无效，请重新选择起止位置。');
  }
  let bytes = 0, progress = 0, message, phase = 'preparing';
  const estimates = new Map();
  const descriptors = [submission.media.video, submission.media.audio].filter(Boolean);
  for (const descriptor of descriptors) estimates.set(descriptor, descriptor.bandwidth ? descriptor.bandwidth * (end - start) / 8 : null);
  const retries = new Map();
  const report = () => onProgress({ progress, bytes, phase, message,
    estimatedBytes: [...estimates.values()].every(value => value !== null) ? [...estimates.values()].reduce((sum, value) => sum + value, 0) : null,
    reconnecting: retries.size, attempt: Math.max(0, ...retries.values()) });
  const media = openSubmissionMedia(request, submission, { signal,
    onRead(size) { bytes += size; report(); },
    onIndex(segments, descriptor) {
      estimates.set(descriptor, segments.reduce((sum, segment) => sum + segment.bytes
        * Math.max(0, Math.min(end, segment.end) - Math.max(start, segment.start)) / (segment.end - segment.start), 0));
      report();
    },
    onRetry(state, descriptor) { if (state) retries.set(descriptor, state.attempt); else retries.delete(descriptor); report(); },
  });
  try {
    report();
    const tracks = await media.getTracks();
    const trim = precise ? trimPreciseTracks : trimCopyTracks;
    const blob = await trim(tracks, { start, end, signal,
      onProcessingStart() { phase = 'processing'; report(); },
      onProgress(value, detail) { progress = Math.max(progress, Math.min(.99, value)); message = detail?.message ?? message; report(); },
    });
    signal?.throwIfAborted();
    progress = 1; phase = 'complete'; report();
    return blob;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally { media.dispose(); }
}
