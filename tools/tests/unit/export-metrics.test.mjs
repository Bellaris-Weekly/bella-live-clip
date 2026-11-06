import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExportMetrics} from '../../../src/media/export-metrics.js';

test('overlapping stage waits are independent of elapsed time; snapshots stay immutable', () => {
  let time = 0;
  const metrics = createExportMetrics({now: () => time});
  const read = metrics.start('sampleWait');
  time = 5;
  const write = metrics.start('fileWrite');
  time = 10;
  read();
  read();
  metrics.firstPacket();
  const before = metrics.snapshot();
  time = 20;
  write();
  metrics.firstPacket();
  const after = metrics.snapshot();
  assert.equal(after.elapsedMs, 20);
  assert.equal(after.firstPacketMs, 10);
  assert.deepEqual(after.stages, {
    sampleWait: {count: 1, totalMs: 10, maxMs: 10},
    fileWrite: {count: 1, totalMs: 15, maxMs: 15},
  });
  assert.deepEqual(before.stages, {sampleWait: {count: 1, totalMs: 10, maxMs: 10}});
  after.stages.sampleWait.totalMs = 0;
  assert.equal(metrics.snapshot().stages.sampleWait.totalMs, 10);
});

test('live waits, histogram bounds and buffer peaks remain observable without per-frame events', () => {
  let time = 0;
  const metrics = createExportMetrics({now: () => time});
  const pending = metrics.start('mediaRequest');
  time = 2500;
  assert.deepEqual(metrics.snapshot().active.mediaRequest, {count: 1, oldestMs: 2500});
  pending();
  for (const ms of [1, 2, 3, 20, 40, 100]) {
    const stop = metrics.start('render');
    time += ms;
    stop();
  }
  metrics.add('videoFrames', 6);
  metrics.gauge('bufferedMediaBytes', 1024);
  metrics.gauge('bufferedMediaBytes', 128);
  const result = metrics.snapshot();
  assert.deepEqual(result.active, {});
  assert.equal(result.latency.render.p50UpperMs, 4);
  assert.equal(result.latency.render.p95UpperMs, 100);
  assert.equal(result.counters.videoFrames, 6);
  assert.deepEqual(result.gauges.bufferedMediaBytes, {current: 128, peak: 1024});
});

test('first frame is recorded once and long task observation drains and disconnects at end', t => {
  let callback,
    observed,
    disconnected = 0,
    time = 0;
  t.mock.property(
    globalThis,
    'PerformanceObserver',
    class {
      static supportedEntryTypes = ['longtask'];
      constructor(fn) {
        callback = fn;
      }
      observe(value) {
        observed = value;
      }
      takeRecords() {
        return [{duration: 80}];
      }
      disconnect() {
        disconnected++;
      }
    },
  );
  const metrics = createExportMetrics({now: () => time, observeLongTasks: true});
  time = 100;
  metrics.firstFrame();
  time = 200;
  metrics.firstFrame();
  callback({getEntries: () => [{duration: 60}, {duration: 100}]});
  metrics.close();
  metrics.close();
  assert.deepEqual(observed, {type: 'longtask'});
  assert.equal(disconnected, 1);
  assert.equal(metrics.snapshot().firstFrameMs, 100);
  assert.equal(metrics.snapshot().counters.longTaskMs, 240);
  assert.equal(metrics.snapshot().counters.longTasks, 3);
});
