import {VideoSample, Input, BlobSource, MP4, VideoSampleSink} from 'mediabunny';
import {createDanmakuCompositor} from '../../../src/danmaku/compositor.js';
import {createDanmakuCompositor as reference} from '../fixtures/danmaku-compositor-reference.js';

window.checkCompositor = async ({width, height, encoded, fixed = false}) => {
  const frame = new OffscreenCanvas(width, height);
  const context = frame.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#d4712f');
  gradient.addColorStop(0.5, '#197db4');
  gradient.addColorStop(1, '#39b25f');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  const input = encoded
    ? new Input({source: new BlobSource(new Blob([new Uint8Array(encoded)])), formats: [MP4]})
    : null;
  const sample = input
    ? await new VideoSampleSink(await input.getPrimaryVideoTrack()).getSample(0)
    : new VideoSample(frame, {timestamp: 0, duration: 1 / 30});
  const read = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true});
  const events = Array.from({length: 60}, (_, i) => ({
    time: -5 + i * 0.17,
    order: i,
    mode: [1, 4, 5][i % 3],
    text: i % 4 === 0 ? '彩色😀[花] Aa字形 gj' : '测试弹幕 ' + i,
    color: [0xffffff, 0xff8044, 0x3399ff][i % 3],
  }));
  window.compositorEvents = fixed
    ? events.slice(0, 3).map(event => ({...event, time: -1, mode: 5, text: '固定弹幕 ' + event.order}))
    : events;
  window.compositorAssets = fontSize => {
    const frames = ['#ff0000', '#0000ff'].map(color => {
      const c = new OffscreenCanvas(Math.ceil(fontSize * 1.8), Math.ceil(fontSize * 2.7));
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, c.width, c.height);
      return c;
    });
    return {
      assets: new Map([
        ['[花]', {frames, ends: [0.1, 0.3], loops: Infinity, width: frames[0].width, height: frames[0].height}],
      ]),
      close() {},
    };
  };
  const options = {origin: 0, start: 0, end: 30, sourceTime: t => t, width, height};
  const before = await reference({room: 1}, options);
  const after = await createDanmakuCompositor({room: 1}, options);
  let compared = 0,
    calls = 0,
    referenceCalls = 0,
    currentCalls = 0;
  const fillText = OffscreenCanvasRenderingContext2D.prototype.fillText;
  OffscreenCanvasRenderingContext2D.prototype.fillText = function (...args) {
    calls++;
    return fillText.apply(this, args);
  };
  try {
    for (const t of [0, 0.017, 0.033, 0.067, 0.1, 0.101, 0.3, 1, 2.13, 4.9, 5, 6, 8, 10, 15, 25, 29]) {
      calls = 0;
      const a = before.render(sample, t);
      referenceCalls += calls;
      calls = 0;
      const b = after.render(sample, t);
      currentCalls += calls;
      a.draw(read, 0, 0);
      const expected = read.getImageData(0, 0, width, height).data;
      b.draw(read, 0, 0);
      const actual = read.getImageData(0, 0, width, height).data;
      a.close();
      b.close();
      for (let i = 0; i < expected.length; i++)
        if (expected[i] !== actual[i]) {
          throw new Error(`Pixel mismatch ${width}x${height} time=${t} byte=${i}: ${expected[i]} != ${actual[i]}`);
        }
      compared++;
    }
  } finally {
    before.close();
    after.close();
    sample.close();
    input?.dispose();
    OffscreenCanvasRenderingContext2D.prototype.fillText = fillText;
  }
  return {compared, referenceCalls, currentCalls};
};
