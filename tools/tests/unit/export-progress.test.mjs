import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderExportProgress, limitProgress} from '../../../src/ui/export-progress.js';
import {createProgressGate} from '../../../src/shared/progress-gate.js';

test('progress gate skips snapshot construction but immediately reports status changes and forced updates', () => {
  let time = 0,
    snapshots = 0;
  const shouldReport = createProgressGate(() => time);
  const report = (...args) => {
    if (shouldReport(...args)) snapshots++;
  };
  report('processing', 'encoding', 0, 0);
  for (let i = 0; i < 10000; i++) report('processing', 'encoding', 0, 0);
  assert.equal(snapshots, 1);
  time = 100;
  report('processing', 'encoding', 0, 0);
  report('processing', 'waiting for comments', 0, 0);
  report('processing', 'waiting for comments', 1, 1);
  report('processing', 'waiting for comments', 1, 2);
  report('processing', 'encoding', 0, 2);
  report('processing', 'encoding', 0, 2, true);
  report('complete', 'saved', 0, 2);
  assert.equal(snapshots, 8);
});

test('准备时使用不定进度并标明读取量，实际处理后恢复百分比', () => {
  let progress = 0;
  const setProgress = value => {
    progress = value;
  };
  let text;
  const status = value => {
    text = value;
  };
  for (const bytes of [70 * 1024 ** 2, 208 * 1024 ** 2]) {
    renderExportProgress(setProgress, status, {phase: 'preparing', progress: 0, bytes}, true);
    assert.ok(Number.isNaN(progress));
    assert.match(text, /正在定位选段 · 已读取/);
    assert.doesNotMatch(text, /0%/);
  }
  renderExportProgress(setProgress, status, {phase: 'processing', progress: 0.42, bytes: 1024}, true);
  assert.equal(progress, 42);
  assert.match(text, /42% · 已读取/);
  renderExportProgress(setProgress, status, {phase: 'complete', progress: 1, bytes: 2048}, true);
  assert.equal(progress, 100);
});

test('直播片段保留处理比例和重连状态', () => {
  let progress;
  let text;
  renderExportProgress(
    value => {
      progress = value;
    },
    value => {
      text = value;
    },
    {progress: 0.5, processing: 0.3, bytes: 1024, downloaded: 3, count: 5, reconnecting: 1, attempt: 2},
    false,
  );
  assert.equal(progress, 50);
  assert.match(text, /第 2 次/);
  assert.match(text, /第 2 次.* · 30% · 已读取/);
});

test('packet progress is throttled, while phase changes, retries and completion are immediate', () => {
  let time = 0;
  const received = [];
  const report = limitProgress(
    state => received.push(state),
    () => time,
  );
  report({phase: 'processing', progress: 0.1});
  for (time = 1; time < 100; time++) report({phase: 'processing', progress: 0.2});
  assert.equal(received.length, 1);
  report({phase: 'processing', progress: 0.3});
  assert.equal(received.length, 2);
  report({phase: 'processing', progress: 0.3, reconnecting: 1, attempt: 1});
  report({phase: 'processing', progress: 0.3, reconnecting: 1, attempt: 2});
  report({phase: 'processing', progress: 0.3, reconnecting: 0});
  report({phase: 'finalizing', progress: 0.99});
  report({phase: 'complete', progress: 1});
  assert.equal(received.length, 7);
  assert.equal(received.at(-1).progress, 1);
});
