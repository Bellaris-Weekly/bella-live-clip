// Local, bounded aggregates. These are elapsed waits, not CPU timings: stages
// overlap and must never be added together to estimate total export time.
export function createExportMetrics({now = () => performance.now()} = {}) {
  const started = now(),
    stages = {};
  let firstPacketMs, encoder;
  return {
    start(name) {
      const from = now();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const ms = Math.max(0, now() - from);
        const stage = (stages[name] ??= {count: 0, totalMs: 0, maxMs: 0});
        stage.count++;
        stage.totalMs += ms;
        stage.maxMs = Math.max(stage.maxMs, ms);
      };
    },
    firstPacket() {
      firstPacketMs ??= Math.max(0, now() - started);
    },
    encoder(config) {
      // A requested preference is not evidence that hardware was actually used.
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
      return {
        elapsedMs: Math.max(0, now() - started),
        firstPacketMs,
        encoder: encoder && {...encoder},
        stages: Object.fromEntries(Object.entries(stages).map(([name, value]) => [name, {...value}])),
      };
    },
  };
}
