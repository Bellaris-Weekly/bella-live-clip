import {createStreamingCompositor} from '../../../src/danmaku/streaming-compositor.js';
import {
  VideoSample,
  Input,
  InputVideoTrack,
  BlobSource,
  MP4,
  VideoSampleSink,
  VideoSampleSource,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  EncodedVideoPacketSource,
} from 'mediabunny';
import {encodeVideoRange} from '../../../src/media/encoding.js';
import {deferred} from '../../../src/shared/deferred.js';
import {createExportMetrics} from '../../../src/media/export-metrics.js';
import {createDanmakuCompositor, createDanmakuPainter} from '../../../src/danmaku/compositor.js';
import {
  createDanmakuCompositor as reference,
  createDanmakuPainter as referencePainter,
} from '../fixtures/danmaku-compositor-reference.js';

window.checkCompositor = async ({width, height, encoded, fixed = false, streaming = false}) => {
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
  const events = Array.from({length: streaming ? 300 : 60}, (_, i) => ({
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
        [
          '[花]',
          {
            frames,
            ends: [0.1, 0.3],
            loops: Infinity,
            width: frames[0].width,
            height: frames[0].height,
            prefetch() {},
            needsPreparation: () => false,
            close() {},
          },
        ],
      ]),
      close() {},
    };
  };
  const options = {origin: 0, start: 0, end: 30, sourceTime: t => t, width, height};
  const before = await reference(
    {room: 1},
    {
      ...options,
      appearance: {
        fontSize: 40,
        lineWidth: 2,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        shadowBlur: 2,
        shadowOffsetX: 1,
        shadowOffsetY: 1,
      },
    },
  );
  const reader = {
    async read({start, end}) {
      return events.filter(item => item.time >= start && item.time < end).map(item => ({...item}));
    },
    async close() {},
  };
  const after = streaming
    ? await createStreamingCompositor({room: 1}, {...options, reader})
    : await createDanmakuCompositor({room: 1}, options);
  let compared = 0,
    calls = 0,
    referenceCalls = 0,
    currentCalls = 0,
    maxDiff = 0,
    totalDiff = 0,
    channels = 0,
    changed = 0;
  const fillText = OffscreenCanvasRenderingContext2D.prototype.fillText;
  OffscreenCanvasRenderingContext2D.prototype.fillText = function (...args) {
    calls++;
    return fillText.apply(this, args);
  };
  try {
    const times = streaming
      ? [0, 0.033, 9.99, 10, 10.01, 19.99, 20, 20.017, 30, 39.99, 40, 49, 55]
      : [0, 0.017, 0.033, 0.067, 0.1, 0.101, 0.3, 1, 2.13, 4.9, 5, 6, 8, 10, 15, 25, 29];
    for (const t of times) {
      calls = 0;
      const a = before.render(sample, t);
      referenceCalls += calls;
      calls = 0;
      await after.prepare?.(t);
      const b = after.render(sample, t);
      currentCalls += calls;
      a.draw(read, 0, 0);
      const expected = read.getImageData(0, 0, width, height).data;
      b.draw(read, 0, 0);
      const actual = read.getImageData(0, 0, width, height).data;
      a.close();
      b.close();
      for (let i = 0; i < expected.length; i++) {
        const diff = Math.abs(expected[i] - actual[i]);
        maxDiff = Math.max(maxDiff, diff);
        totalDiff += diff;
        channels++;
        if (diff) changed++;
      }
      compared++;
    }
  } finally {
    before.close();
    await after.close();
    sample.close();
    input?.dispose();
    OffscreenCanvasRenderingContext2D.prototype.fillText = fillText;
  }
  return {
    compared,
    referenceCalls,
    currentCalls,
    maxDiff,
    meanDiff: totalDiff / channels,
    changedFraction: changed / channels,
  };
};

// Isolate sampling from layout/overlap: exact same text, phase and video source.
window.inspectSpriteSampling = async () => {
  const width = 640,
    height = 360;
  const background = new OffscreenCanvas(width, height);
  const base = background.getContext('2d');
  base.fillStyle = '#608090';
  base.fillRect(0, 0, width, height);
  const sample = new VideoSample(background, {timestamp: 0, duration: 1 / 60});
  const read = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true});
  const result = [];
  try {
    for (const scene of ['integer', 'fractional', 'moving', 'overlap', 'emote']) {
      const events = [
        {time: 0, mode: 5, text: scene === 'emote' ? '[花]' : 'Shadow 测试 Agj', color: 0xffffff, order: 0},
      ];
      if (scene === 'overlap') events.push({...events[0], mode: 1, color: 0xff8044, order: 1});
      const options = {
        start: 0,
        sourceTime: t => t,
        width,
        height,
        appearance: {
          fontSize: 40,
          shadowColor: 'rgba(0, 0, 0, 0.5)',
          shadowBlur: 2,
          shadowOffsetX: 1,
          shadowOffsetY: 1,
        },
      };
      const before = referencePainter(events, window.compositorAssets((40 * height) / 1080), options);
      const after = createDanmakuPainter(events, window.compositorAssets((40 * height) / 1080), options);
      let x = scene === 'integer' || scene === 'moving' ? 100 : 100.375;
      before.layout.x = after.layout.x = () => x;
      try {
        for (const time of scene === 'moving' ? [0, 0.017] : [0]) {
          if (time) x += 0.375;
          const a = before.render(sample, time),
            b = after.render(sample, time);
          a.draw(read, 0, 0);
          const expected = read.getImageData(0, 0, width, height).data;
          b.draw(read, 0, 0);
          const actual = read.getImageData(0, 0, width, height).data;
          a.close();
          b.close();
          let maxDiff = 0,
            total = 0,
            changed = 0;
          for (let i = 0; i < expected.length; i++) {
            const d = Math.abs(expected[i] - actual[i]);
            maxDiff = Math.max(maxDiff, d);
            total += d;
            changed += d !== 0;
          }
          result.push({
            scene,
            time,
            maxDiff,
            meanDiff: total / expected.length,
            changedFraction: changed / expected.length,
          });
        }
      } finally {
        before.close();
        after.close();
      }
    }
  } finally {
    sample.close();
  }
  return result;
};

window.checkFailedEmoteSprites = () => {
  const width = 640,
    height = 360;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').fillRect(0, 0, width, height);
  const sample = new VideoSample(canvas, {timestamp: 0, duration: 1 / 60});
  const read = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true});
  const events = [{time: 0, mode: 5, text: 'before[花]after😀', color: 0xff8044, order: 0}];
  const metrics = createExportMetrics();
  const resources = window.compositorAssets((40 * height) / 1080);
  const referenceResources = window.compositorAssets((40 * height) / 1080);
  const options = {
    start: 0,
    sourceTime: t => t,
    width,
    height,
    metrics,
    appearance: {fontSize: 40, shadowColor: 'rgba(0, 0, 0, 0.5)', shadowBlur: 2, shadowOffsetX: 1, shadowOffsetY: 1},
  };
  const before = referencePainter(events, referenceResources, options);
  const after = createDanmakuPainter(events, resources, options);
  const close = ImageBitmap.prototype.close;
  let closed = 0;
  ImageBitmap.prototype.close = function () {
    closed++;
    return close.call(this);
  };
  const compare = time => {
    const a = before.render(sample, time),
      b = after.render(sample, time);
    a.draw(read, 0, 0);
    const expected = read.getImageData(0, 0, width, height).data;
    b.draw(read, 0, 0);
    const actual = read.getImageData(0, 0, width, height).data;
    a.close();
    b.close();
    let maxDiff = 0;
    for (let i = 0; i < expected.length; i++) maxDiff = Math.max(maxDiff, Math.abs(expected[i] - actual[i]));
    return {maxDiff, closed, metrics: metrics.snapshot()};
  };
  try {
    const initial = compare(0);
    resources.assets.get('[花]').failed = referenceResources.assets.get('[花]').failed = true;
    const fallback = compare(0.017);
    const textParts = after.layout.active[0].parts.map(part => part.text);
    const reuse = compare(0.033);
    after.clearMeasurements();
    const cleared = {closed, bytes: metrics.snapshot().gauges.spriteBytes.current};
    const rebuilt = compare(0.05);
    const expired = compare(6);
    return {initial, fallback, textParts, reuse, cleared, rebuilt, expired};
  } finally {
    before.close();
    after.close();
    sample.close();
    ImageBitmap.prototype.close = close;
  }
};

window.checkEncodingOverlap = async () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff'];
  const canvas = new OffscreenCanvas(64, 64);
  const context = canvas.getContext('2d');
  const painter = createDanmakuPainter(
    [],
    {assets: new Map(), close() {}},
    {
      start: 0,
      sourceTime: time => time,
      width: 64,
      height: 64,
    },
  );
  const readContext = new OffscreenCanvas(64, 64).getContext('2d', {willReadFrequently: true});
  const pixel = sample => {
    sample.draw(readContext, 0, 0);
    return [...readContext.getImageData(32, 32, 1, 1).data];
  };
  const originalSamples = VideoSampleSink.prototype.samples;
  const originalAdd = VideoSampleSource.prototype.add;
  const gate = deferred();
  const events = [],
    pixels = [],
    samples = [],
    rendered = [],
    closes = new Map();
  let active = 0,
    peak = 0,
    returned = false;
  const own = sample => {
    const close = sample.close.bind(sample);
    sample.close = () => {
      closes.set(sample, (closes.get(sample) ?? 0) + 1);
      close();
    };
    return sample;
  };
  VideoSampleSink.prototype.samples = function () {
    let index = 0;
    return {
      async next() {
        if (index === colors.length) return {done: true};
        context.fillStyle = colors[index];
        context.fillRect(0, 0, 64, 64);
        const value = own(new VideoSample(canvas, {timestamp: index / 30, duration: 1 / 30}));
        samples.push(value);
        index++;
        return {value, done: false};
      },
      async return() {
        returned = true;
        return {done: true};
      },
    };
  };
  VideoSampleSource.prototype.add = async function (sample, options) {
    const index = Math.round(sample.timestamp * 30);
    events.push(`add${index}`);
    peak = Math.max(peak, ++active);
    try {
      if (index === 0) await gate.promise;
      // Inspect the original snapshot only after frame 1 repainted the painter's canvas.
      pixels.push(pixel(sample));
      await originalAdd.call(this, sample, options);
      events.push(`resolved${index}`);
    } finally {
      active--;
    }
  };
  const packets = [];
  const timeout = setTimeout(() => gate.reject(new Error('next frame did not render during add')), 5000);
  try {
    for await (const packet of encodeVideoRange(new InputVideoTrack({}, {}), {
      start: 0,
      end: 0.1,
      settings: {encodingOptions: {codec: 'avc', bitrate: 1000000, latencyMode: 'quality'}},
      compositor: {
        render(sample, time) {
          const index = Math.round(time * 30);
          events.push(`render${index}`);
          const frame = own(painter.render(sample, time));
          rendered.push(frame);
          if (index === 1) gate.resolve();
          return frame;
        },
      },
    }))
      packets.push(packet);
  } finally {
    clearTimeout(timeout);
    VideoSampleSink.prototype.samples = originalSamples;
    VideoSampleSource.prototype.add = originalAdd;
    painter.close();
  }
  const output = new Output({format: new Mp4OutputFormat(), target: new BufferTarget()});
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source);
  await output.start();
  for (const {packet, decoderConfig} of packets) await source.add(packet, {decoderConfig});
  await output.finalize();
  const input = new Input({source: new BlobSource(new Blob([output.target.buffer])), formats: [MP4]});
  const decoded = [];
  try {
    for await (const sample of new VideoSampleSink(await input.getPrimaryVideoTrack()).samples()) {
      try {
        decoded.push(pixel(sample));
      } finally {
        sample.close();
      }
    }
  } finally {
    input.dispose();
  }
  return {
    events,
    pixels,
    decoded,
    peak,
    returned,
    closes: [...samples, ...rendered].map(sample => closes.get(sample)),
    timestamps: packets.map(({packet}) => packet.timestamp),
    durations: packets.map(({packet}) => packet.duration),
    firstKey: packets[0].packet.type,
  };
};

window.checkLiveWindowPrefetch = async () => {
  const calls = [];
  const compositor = await createStreamingCompositor(
    {room: 1},
    {
      reader: {
        async read({start, end, prefetch}) {
          calls.push({start, end, prefetch});
          return prefetch ? null : [];
        },
        async close() {},
      },
      origin: 0,
      start: 0,
      sourceTime: time => time,
      width: 64,
      height: 64,
      endTime: () => 20,
    },
  );
  try {
    await compositor.prepare(9);
    const before = calls.slice();
    await compositor.prepare(10);
    await compositor.prepare(11);
    return {before, after: calls};
  } finally {
    await compositor.close();
  }
};
