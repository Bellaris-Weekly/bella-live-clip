import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withExportPicker} from '../../../src/app/export-actions.js';
import {createExportMetrics} from '../../../src/media/export-metrics.js';

test('picker opens synchronously; preparation overlaps but destination writes await its result', async () => {
  let resolvePicker,
    picked = false,
    preparing = false,
    writes = 0,
    time = 0;
  const metrics = createExportMetrics({now: () => time});
  const run = withExportPicker(
    () => {
      picked = true;
      return new Promise(resolve => {
        resolvePicker = resolve;
      });
    },
    new AbortController().signal,
    metrics,
    async destination => {
      preparing = true;
      const handle = await destination;
      await handle.createWritable();
    },
  );
  assert.ok(picked);
  assert.ok(preparing);
  assert.equal(writes, 0);
  time = 7000;
  resolvePicker({
    createWritable: async () => {
      writes++;
    },
  });
  await run;
  assert.equal(writes, 1);
  assert.equal(metrics.snapshot().stages.pickerWait.totalMs, 7000);
});

test('picker cancel aborts running preparation and waits for temporary cleanup', async () => {
  let rejectPicker,
    cleaned = false,
    started = false;
  const error = new DOMException('picker canceled', 'AbortError');
  const run = withExportPicker(
    () =>
      new Promise((_, reject) => {
        rejectPicker = reject;
      }),
    new AbortController().signal,
    createExportMetrics(),
    async (_, signal) => {
      started = true;
      try {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      } finally {
        await new Promise(resolve => setImmediate(resolve));
        cleaned = true;
      }
    },
  );
  assert.ok(started);
  rejectPicker(error);
  await assert.rejects(run, value => value === error);
  assert.ok(cleaned);
});

test('export cancellation releases a waiter even while the native picker remains open', async () => {
  const controller = new AbortController();
  let resolved,
    cleaned = false;
  const run = withExportPicker(
    () =>
      new Promise(resolve => {
        resolved = resolve;
      }),
    controller.signal,
    createExportMetrics(),
    async destination => {
      try {
        await destination;
      } finally {
        cleaned = true;
      }
    },
  );
  controller.abort();
  await assert.rejects(run, {name: 'AbortError'});
  assert.ok(cleaned);
  resolved({name: 'late.mp4'});
});
