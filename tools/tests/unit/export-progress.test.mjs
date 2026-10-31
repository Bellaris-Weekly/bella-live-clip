import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderExportProgress} from '../../../src/ui/export-progress.js';

test('准备时使用不定进度并标明读取量，实际处理后恢复百分比', () => {
  const progress = {
    value: 0,
    removeAttribute(key) {
      delete this[key];
    },
  };
  let text;
  const status = value => {
    text = value;
  };
  for (const bytes of [70 * 1024 ** 2, 208 * 1024 ** 2]) {
    renderExportProgress(progress, status, {phase: 'preparing', progress: 0, bytes}, true);
    assert.equal(progress.value, undefined);
    assert.match(text, /正在定位选段 · 已读取/);
    assert.doesNotMatch(text, /0%/);
  }
  renderExportProgress(progress, status, {phase: 'processing', progress: 0.42, bytes: 1024}, true);
  assert.equal(progress.value, 42);
  assert.match(text, /42% · 已读取/);
  renderExportProgress(progress, status, {phase: 'complete', progress: 1, bytes: 2048}, true);
  assert.equal(progress.value, 100);
});

test('直播片段保留处理比例和重连状态', () => {
  const progress = {};
  let text;
  renderExportProgress(
    progress,
    value => {
      text = value;
    },
    {progress: 0.5, processing: 0.3, bytes: 1024, downloaded: 3, count: 5, reconnecting: 1, attempt: 2},
    false,
  );
  assert.equal(progress.value, 50);
  assert.match(text, /第 2 次/);
  assert.match(text, /第 2 次.* · 30% · 已读取/);
});
