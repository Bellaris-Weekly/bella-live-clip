import {redactText} from '../shared/log-redaction.js';
import {performanceLog} from '../shared/performance-log.js';

const idle = Object.freeze({stage() {}, progress() {}, observe() {}, finish() {}, fail() {}});
function text(value, limit) {
  if (typeof value !== 'string') return undefined;
  // Errors from media/network libraries may embed signed URLs with unknown key
  // names. Outgoing diagnostics keep their origin/path, never query credentials.
  return redactText(value.slice(0, 65536))
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return raw.split(/[?#]/, 1)[0];
      }
    })
    .slice(0, limit);
}
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const fact = value =>
  typeof value === 'string' ? text(value, 256) : typeof value === 'boolean' ? value : number(value);

// One error as reported: its own annotations plus the browser's name/message.
function describe(error) {
  if (!error || typeof error !== 'object') return {message: text(String(error), 512)};
  const result = {name: text(error.name, 128), message: text(error.message, 512)};
  if (typeof error.status === 'number') result.status = error.status;
  if (error.code !== undefined) result.code = fact(error.code);
  for (const [key, value] of Object.entries(error.diagnostic ?? {}).slice(0, 16)) {
    const safe = fact(value);
    if (safe !== undefined && !(key in result)) result[key] = safe;
  }
  return result;
}

// A user-facing wrapper hides the browser's error; cleanup failures are kept
// beside the error that ended the operation instead of replacing it.
export function errorDetail(error) {
  if (!error || typeof error !== 'object') return undefined;
  const detail = describe(error),
    causes = [],
    seen = new Set([error]);
  for (let cause = error.cause; cause && causes.length < 3 && !seen.has(cause); cause = cause?.cause) {
    seen.add(cause);
    causes.push(describe(cause));
  }
  if (causes.length) detail.causes = causes;
  if (Array.isArray(error.suppressed) && error.suppressed.length)
    detail.suppressed = error.suppressed.slice(0, 3).map(describe);
  return detail;
}

function pageIdentity(value) {
  try {
    const url = new URL(value);
    if (!['www.bilibili.com', 'bilibili.com', 'live.bilibili.com', 'm.bilibili.com'].includes(url.hostname))
      return undefined;
    const part = url.searchParams.get('p');
    return `${url.origin}${url.pathname}${part && /^\d+$/.test(part) ? `?p=${part}` : ''}`.slice(0, 1024);
  } catch {
    return undefined;
  }
}

function snapshot(details) {
  const record = details.record || {},
    selection = details.selection || {};
  return {
    page: pageIdentity(details.pageUrl),
    mode: text(details.mode, 32),
    record: {
      kind: text(record.kind || 'recording', 32),
      key: text(record.key, 128),
      room: number(record.room),
      bvid: text(record.bvid, 64),
      aid: number(record.aid),
      cid: number(record.cid),
      part: number(record.part),
      start: number(record.start),
      end: number(record.end),
      live: typeof record.live === 'boolean' ? record.live : undefined,
    },
    selection: {start: number(selection.start), end: number(selection.end)},
    estimatedBytes: number(details.estimatedBytes),
  };
}

function transfer(request, endpoint, body) {
  return new Promise(resolve => {
    try {
      request({
        method: 'POST',
        url: endpoint,
        anonymous: true,
        timeout: 8000,
        headers: {'Content-Type': 'application/json'},
        data: body,
        onload: result => resolve(result.status === 429 || result.status >= 500),
        onerror: () => resolve(true),
        ontimeout: () => resolve(true),
        onabort: () => resolve(false),
      });
    } catch {
      resolve(false);
    }
  });
}

export function createDiagnosticReporter({
  endpoint = '',
  request,
  version = '0.0.0',
  userAgent = '',
  online = () => globalThis.navigator?.onLine !== false,
  id = () => crypto.randomUUID(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now(),
  clock = () => new Date().toISOString(),
  every = (fn, ms) => setInterval(fn, ms),
  cancelTimer = timer => clearInterval(timer),
  visibility = () => globalThis.document?.visibilityState ?? 'unknown',
} = {}) {
  let pending = 0,
    dropped = 0;
  const queue = [];
  async function send(item) {
    try {
      if (await transfer(request, endpoint, item.body)) {
        await wait(1000);
        if (online()) await transfer(request, endpoint, item.body);
      }
    } catch {
      /* Logging never fails the operation. */
    } finally {
      pending--;
      pump();
    }
  }
  function pump() {
    while (pending < 2 && queue.length) {
      pending++;
      void send(queue.shift());
    }
  }
  function enqueue(item) {
    if (!online()) {
      dropped++;
      return;
    }
    // A delayed heartbeat is superseded by a newer snapshot or a terminal event.
    const obsolete = queue.findIndex(old => old.operation === item.operation && old.periodic);
    if (obsolete >= 0) queue.splice(obsolete, 1);
    if (queue.length >= 32) {
      const expendable = queue.findIndex(old => old.periodic);
      if (item.periodic && expendable < 0) {
        dropped++;
        return;
      }
      queue.splice(Math.max(0, expendable), 1);
      dropped++;
    }
    queue.push(item);
    pump();
  }
  return {
    begin(action, details = {}) {
      if (!endpoint || typeof request !== 'function') return idle;
      const context = {...snapshot(details), stage: 'starting', timeline: []};
      const operation = id(),
        started = now(),
        startedAt = clock(),
        stageTimes = {};
      const exporting = action === 'export' || action === 'recording_download';
      let finished = false,
        sequence = 0,
        timer,
        provider,
        latestMetrics;
      let stageStarted = started,
        lastAdvance = started,
        lastProgress = started,
        signature;
      let nextHeartbeat = started + 10000;
      function point(metrics = latestMetrics) {
        const elapsedMs = Math.max(0, now() - started);
        const videoFrames = number(metrics?.counters?.videoFrames ?? context.progress?.videoFrames);
        context.timeline.push({
          elapsedMs,
          stage: context.stage,
          fraction: number(context.progress?.fraction),
          bytes: number(context.progress?.bytes ?? context.progress?.written),
          videoFrames,
          processedSeconds: number(context.progress?.processedSeconds),
          fps:
            metrics?.elapsedMs > 0 && videoFrames !== undefined ? videoFrames / (metrics.elapsedMs / 1000) : undefined,
        });
        // Keep the first point and recent detail; halve the older half at capacity.
        if (context.timeline.length > 60) context.timeline = context.timeline.filter((_, i) => i >= 30 || i % 2 === 0);
      }
      function stage(value) {
        const next = text(value, 64);
        if (finished || !next || next === context.stage) return;
        const time = now();
        stageTimes[context.stage] = (stageTimes[context.stage] ?? 0) + Math.max(0, time - stageStarted);
        context.stage = next;
        stageStarted = time;
        lastAdvance = time;
        point(latestMetrics);
      }
      function publish(outcome, message, error, periodic = false) {
        try {
          const time = now();
          const elapsedMs = Math.max(0, time - started);
          const timings = {
            ...stageTimes,
            [context.stage]: (stageTimes[context.stage] ?? 0) + Math.max(0, time - stageStarted),
          };
          let metrics = latestMetrics;
          try {
            metrics = provider?.snapshot() ?? metrics;
          } catch {
            /* Keep the last snapshot. */
          }
          point(metrics);
          const performance = performanceLog(metrics);
          const processed = ['completed', 'stopped', 'partial'].includes(outcome)
            ? (context.result?.mediaSeconds ?? context.progress?.processedSeconds)
            : context.progress?.processedSeconds;
          const processingMs = performance?.elapsedMs;
          const runtime = {
            visibility: visibility(),
            noAdvanceMs: Math.max(0, time - lastAdvance),
            lastProgressMs: Math.max(0, time - lastProgress),
            timerDelayMs: periodic ? Math.max(0, time - nextHeartbeat) : 0,
            droppedLogs: dropped,
            hardwareConcurrency: number(globalThis.navigator?.hardwareConcurrency),
            deviceMemoryGiB: number(globalThis.navigator?.deviceMemory),
          };
          const heap = globalThis.performance?.memory;
          if (heap) runtime.jsHeapBytes = number(heap.usedJSHeapSize);
          const suffix = outcome;
          const payload = {
            id: `${operation}:${sequence++}`,
            source: 'bella-live-clip',
            event: `${action}_${suffix}`,
            level: outcome === 'failed' ? 'error' : ['stalled', 'partial'].includes(outcome) ? 'warn' : 'info',
            version,
            message: text(message, 4096) || '运行记录',
            context: {
              ...context,
              browser: text(userAgent, 512),
              operation: {
                id: operation,
                action,
                outcome,
                sequence: sequence - 1,
                startedAt,
                clientAt: clock(),
                elapsedMs,
              },
              stageTimes: timings,
              runtime,
              metrics: performance,
              throughput:
                processingMs > 0
                  ? {
                      realtime: processed === undefined ? undefined : processed / (processingMs / 1000),
                      fps:
                        performance.counters.videoFrames === undefined
                          ? undefined
                          : performance.counters.videoFrames / (processingMs / 1000),
                    }
                  : undefined,
              ...(error
                ? {errorName: text(error.name, 128), error: errorDetail(error), stack: text(error.stack, 8192)}
                : {}),
            },
          };
          let body = JSON.stringify(payload);
          if (new TextEncoder().encode(body).byteLength > 65536) {
            payload.context.stack = undefined;
            payload.context.truncated = true;
            payload.message = payload.message.slice(0, 1024);
            body = JSON.stringify(payload);
          }
          if (new TextEncoder().encode(body).byteLength <= 65536) enqueue({body, operation, periodic});
        } catch {
          /* No recursive diagnostics or user-facing logging errors. */
        }
      }
      function complete(outcome, message, error) {
        if (finished) return;
        finished = true;
        if (timer !== undefined) cancelTimer(timer);
        publish(outcome, message, error);
      }
      // Preview errors can occur long after loading. Only jobs with a known end
      // emit start/success events; preview's existing failure boundary stays live.
      if (action !== 'preview') publish('started', exporting ? '导出开始' : '操作开始');
      if (exporting) {
        timer = every(() => {
          if (finished) return;
          const stalled = context.stage !== 'select_destination' && now() - lastAdvance >= 30000;
          publish(stalled ? 'stalled' : 'progress', stalled ? '导出进度暂未推进' : '导出运行中', undefined, true);
          nextHeartbeat = now() + 10000;
        }, 10000);
        timer?.unref?.();
      }
      return {
        stage,
        observe(metrics) {
          provider = metrics;
        },
        progress(value) {
          if (finished) return;
          const next = [value.progress, value.bytes, value.written, value.videoFrames, value.processedSeconds].join(
            ':',
          );
          if (next !== signature) {
            signature = next;
            lastAdvance = now();
          }
          lastProgress = now();
          if (value.metrics) latestMetrics = value.metrics;
          context.progress = {
            fraction: number(value.progress),
            bytes: number(value.bytes),
            written: number(value.written),
            estimatedBytes: number(value.estimatedBytes),
            attempt: number(value.attempt),
            downloaded: number(value.downloaded),
            count: number(value.count),
            reconnecting: number(value.reconnecting),
            videoFrames: number(value.videoFrames),
            processedSeconds: number(value.processedSeconds),
            message: text(value.message, 256),
          };
          stage(value.phase);
        },
        finish(result = {}) {
          if (finished) return;
          context.result = {
            files: number(result.files),
            writtenBytes: number(result.writtenBytes),
            mediaSeconds: number(result.mediaSeconds),
          };
          const outcome = ['canceled', 'stopped', 'partial'].includes(result.status) ? result.status : 'completed';
          const messages = {
            completed: '操作完成',
            stopped: '已停止并保存',
            partial: result.error?.message || '已保存部分内容',
            canceled: '操作已取消',
          };
          complete(outcome, messages[outcome], outcome === 'partial' ? result.error : undefined);
        },
        fail(error, signal) {
          if (signal?.aborted || error?.name === 'AbortError') complete('canceled', '操作已取消');
          else complete('failed', error?.message || String(error), error);
        },
      };
    },
  };
}
