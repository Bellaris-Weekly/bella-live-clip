// Elapsed waits, not CPU timings: stages can overlap and must not be summed.
const BUCKETS = [1, 4, 16, 50, 100, 250, 1000, 5000, 15000, 60000, Infinity];
export function createExportMetrics({now = () => performance.now(), observeLongTasks = false} = {}) {
  const started = now(),
    stages = new Map(),
    active = new Map(),
    counters = {},
    gauges = {};
  let firstPacketMs, firstFrameMs, encoder, observer;
  const observe = list => {
    for (const entry of list) {
      counters.longTaskMs = (counters.longTaskMs ?? 0) + entry.duration;
      counters.longTasks = (counters.longTasks ?? 0) + 1;
    }
  };
  try {
    if (observeLongTasks && globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver(list => observe(list.getEntries()));
      observer.observe({type: 'longtask'});
    }
  } catch {
    observer?.disconnect();
    observer = null;
  }
  return {
    start(name) {
      const from = now();
      const pending = active.get(name) ?? new Set();
      active.set(name, pending);
      const token = {from};
      pending.add(token);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending.delete(token);
        const ms = Math.max(0, now() - from);
        let stage = stages.get(name);
        if (!stage)
          stages.set(name, (stage = {count: 0, totalMs: 0, maxMs: 0, histogram: new Array(BUCKETS.length).fill(0)}));
        stage.count++;
        stage.totalMs += ms;
        stage.maxMs = Math.max(stage.maxMs, ms);
        stage.histogram[BUCKETS.findIndex(limit => ms <= limit)]++;
      };
    },
    add(name, value = 1) {
      if (Number.isFinite(value)) counters[name] = (counters[name] ?? 0) + value;
    },
    gauge(name, value) {
      if (!Number.isFinite(value)) return;
      const prior = gauges[name];
      gauges[name] = {current: value, peak: Math.max(prior?.peak ?? value, value)};
    },
    close() {
      if (observer) observe(observer.takeRecords());
      observer?.disconnect();
      observer = null;
    },
    firstFrame() {
      firstFrameMs ??= Math.max(0, now() - started);
    },
    firstPacket() {
      firstPacketMs ??= Math.max(0, now() - started);
    },
    encoder(config) {
      encoder = {
        codec: config.codec,
        width: config.width,
        height: config.height,
        bitrate: config.bitrate,
        frameRate: config.framerate,
        hardwarePreference: config.hardwareAcceleration,
      };
    },
    snapshot() {
      const time = now();
      return {
        elapsedMs: Math.max(0, time - started),
        firstPacketMs,
        firstFrameMs,
        encoder: encoder && {...encoder},
        stages: Object.fromEntries([...stages].map(([name, {histogram, ...stage}]) => [name, {...stage}])),
        // Histogram upper bounds are estimates, not exact percentiles.
        latency: Object.fromEntries(
          [...stages].map(([name, stage]) => {
            const percentile = quantile => {
              let count = 0;
              for (const [i, value] of stage.histogram.entries()) {
                count += value;
                if (count >= Math.ceil(stage.count * quantile)) return Math.min(BUCKETS[i], stage.maxMs);
              }
            };
            return [name, {p50UpperMs: percentile(0.5), p95UpperMs: percentile(0.95)}];
          }),
        ),
        active: Object.fromEntries(
          [...active]
            .filter(([, pending]) => pending.size)
            .map(([name, pending]) => [
              name,
              {count: pending.size, oldestMs: Math.max(0, time - Math.min(...[...pending].map(item => item.from)))},
            ]),
        ),
        counters: {...counters},
        gauges: Object.fromEntries(Object.entries(gauges).map(([name, value]) => [name, {...value}])),
      };
    },
  };
}
