import {recordingTime} from './recording-timeline.js';
import {LIVE_MISSING_RETRIES} from '../services/retry-request.js';
import {canEncodeVideo} from 'mediabunny';
import {deferred} from '../shared/deferred.js';
import {cleanUp} from '../shared/errors.js';
import {saveRecording} from './recording.js';
import {createStreamingMedia} from './streaming-media.js';
import {trimPrecise} from './smart-trim.js';
import {sourceClock} from '../danmaku/clock.js';
import {createCommentReader} from '../danmaku/archive.js';
import {createStreamingCompositor} from '../danmaku/streaming-compositor.js';

const DANMAKU_DOWNLOAD_CONCURRENCY = 6;

export async function exportStreamingDanmaku(
  api,
  record,
  expanded,
  plan,
  {
    origin,
    adjustment,
    preparedComments,
    createTemporary,
    fileHandle,
    signal,
    abort,
    onSegment,
    selectionStart,
    selectionEnd,
    onProgress = () => {},
    onDownload = () => {},
    metrics,
  },
) {
  const producerController = new AbortController(),
    resourcesController = new AbortController();
  const ready = deferred();
  const cancel = () => {
    producerController.abort(signal.reason);
    resourcesController.abort(signal.reason);
    ready.reject(signal.reason);
  };
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const media = createStreamingMedia({
    metrics,
    signal: producerController.signal,
    onCancel: () => producerController.abort(),
  });
  const entries = [];
  let clock,
    compositor,
    producer,
    start,
    end = Infinity,
    failure,
    thrown,
    stopping = false;
  const reader = createCommentReader(record, {
    signal: resourcesController.signal,
    prepared: preparedComments,
    createTemporary,
    metrics,
  });
  const firstIndex = expanded.segments.indexOf(plan.segments[0]);
  const lastIndex = expanded.segments.indexOf(plan.segments.at(-1));
  let downloadLimit = lastIndex + 1;
  metrics?.gauge('downloadConcurrency', DANMAKU_DOWNLOAD_CONCURRENCY);
  try {
    producer = saveRecording(api, [expanded], media.handle, {
      signal: producerController.signal,
      fragmented: true,
      storageTarget: 'stream',
      missingRetries: record.live ? LIVE_MISSING_RETRIES : 0,
      concurrency: DANMAKU_DOWNLOAD_CONCURRENCY,
      downloadLimit: () => downloadLimit,
      onSegment(entry, tracks) {
        onSegment(entry);
        entries.push(entry);
        clock = sourceClock(entries);
        const index = expanded.segments.indexOf(entry.segment);
        if (start === undefined && index >= firstIndex) {
          start = selectionStart();
          ready.resolve(start);
        }
        if (index >= lastIndex) {
          end = selectionEnd();
          const boundary = tracks.some(
            track =>
              track.key.startsWith('video:') &&
              track.packets.some(
                packet => packet.type === 'key' && recordingTime(packet.timestamp + entry.sourceOffset) >= end,
              ),
          );
          // Beyond the selection, admit only one additional fragment at a time
          // until the real keyframe boundary is found. Never prefetch past it.
          downloadLimit = Math.min(expanded.segments.length, index + (boundary ? 1 : 2));
        }
      },
      onProgress: onDownload,
    });
    void producer
      .then(result => {
        start ??= selectionStart();
        end = Math.min(result.duration, selectionEnd());
        ready.resolve(start);
      })
      .catch(error => {
        failure = error;
        if (!stopping) abort(error);
        ready.reject(error);
        media.fail(error);
      });
    const finishReady = metrics?.start('streamReady');
    try {
      start = await ready.promise;
    } finally {
      finishReady?.();
    }
    const track = await media.input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('当前浏览器无法解码视频，不能压制弹幕。');
    if (await track.getRotation()) throw new Error('当前暂不支持旋转视频压制弹幕。');
    const width = await track.getCodedWidth(),
      height = await track.getCodedHeight();
    if (!(await canEncodeVideo('avc', {width, height})))
      throw new Error('当前浏览器无法编码此分辨率的 H.264，不能压制弹幕。');
    const finishCompositor = metrics?.start('compositorInit');
    try {
      compositor = await createStreamingCompositor(record, {
        reader,
        metrics,
        origin,
        start,
        sourceTime: time => clock(time),
        width,
        height,
        adjustment,
        signal: resourcesController.signal,
        endTime: () => (Number.isFinite(end) ? clock(end) : Infinity),
      });
    } finally {
      finishCompositor?.();
    }
    const result = await trimPrecise(media.input, {
      start,
      end: () => {
        if (failure) throw failure;
        return end;
      },
      compositor,
      metrics,
      signal,
      fileHandle,
      onProgress: (value, detail) => onProgress(value, detail),
    });
    if (failure) throw failure;
    if (!Number.isFinite(end) || end <= start) throw new Error('选区结束时间尚未确认，已停止导出。');
    return result;
  } catch (error) {
    thrown = error;
    abort(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    stopping = true;
    producerController.abort();
    resourcesController.abort();
    await cleanUp(
      thrown,
      () => media.close(),
      () => producer?.catch(() => {}),
      () => (compositor ? compositor.close() : reader.close()),
    );
  }
}
