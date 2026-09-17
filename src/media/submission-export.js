import { openSubmissionMedia } from './remote-mp4.js';
import { trimCopyTracks, trimPreciseTracks } from './smart-trim.js';

export async function exportSubmission(request, submission, selection, { signal, precise = false, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const { start, end } = selection;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > submission.duration + .001) {
    throw new Error('视频选区无效，请重新选择起止位置。');
  }
  let bytes = 0, progress = 0, message;
  const retries = new Map();
  const report = (phase = 'processing') => onProgress({ progress, bytes, phase, message,
    reconnecting: retries.size, attempt: Math.max(0, ...retries.values()) });
  const media = openSubmissionMedia(request, submission, { signal,
    onRead(size) { bytes += size; report(); },
    onRetry(state, descriptor) { if (state) retries.set(descriptor, state.attempt); else retries.delete(descriptor); report(); },
  });
  try {
    report('download');
    const tracks = await media.getTracks();
    const trim = precise ? trimPreciseTracks : trimCopyTracks;
    const blob = await trim(tracks, { start, end, signal,
      onProgress(value, detail) { progress = Math.max(progress, Math.min(.99, value)); message = detail?.message ?? message; report(); },
    });
    signal?.throwIfAborted();
    progress = 1; report('complete');
    return blob;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally { media.dispose(); }
}
