import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDanmakuPainter} from '../../../src/danmaku/compositor.js';

function contexts(t) {
  const previous = globalThis.OffscreenCanvas;
  t.after(() => {
    if (previous) globalThis.OffscreenCanvas = previous;
    else delete globalThis.OffscreenCanvas;
  });
  let created = 0,
    textDraws = 0;
  const ink = {
    measureText: () => ({
      width: 20,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 20,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
    }),
    clearRect() {},
    strokeText() {},
    fillText() {
      textDraws++;
    },
  };
  globalThis.OffscreenCanvas = class {
    constructor() {
      this.first = ++created === 1;
    }
    getContext() {
      return this.first ? ink : null;
    }
  };
  return () => textDraws;
}
const options = {start: 0, sourceTime: t => t, width: 1920, height: 1080};
test('failure allocating the export canvas preserves the actionable error', t => {
  contexts(t);
  const painter = createDanmakuPainter([], {assets: new Map(), close() {}}, options);
  try {
    assert.throws(
      () =>
        painter.render(
          {
            toCanvasImageSource() {
              return {};
            },
          },
          0,
        ),
      /无法创建弹幕合成画布/,
    );
  } finally {
    painter.close();
  }
});
test('failure allocating a text sprite falls back to direct text rendering', t => {
  const draws = contexts(t);
  const painter = createDanmakuPainter(
    [{time: 0, mode: 5, text: '测试', order: 0}],
    {assets: new Map(), close() {}},
    options,
  );
  try {
    painter.renderOverlay(1);
    assert.equal(draws(), 1);
  } finally {
    painter.close();
  }
});
