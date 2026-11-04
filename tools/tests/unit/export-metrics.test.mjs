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
