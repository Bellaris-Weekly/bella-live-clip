import {exportSelection as exportReference} from '../fixtures/danmaku-export-reference.js';
import {Input, BlobSource, MP4, EncodedPacketSink, VideoSampleSink} from 'mediabunny';
import {exportSelection} from '../../../src/media/export.js';

window.startStreaming = async ({
  blockMedia = false,
  blockIndex = 8,
  blockWrite = false,
  reference = false,
  selection = {start: 0.2, end: 42.3},
} = {}) => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('stream-result.mp4', {create: true});
  const controller = new AbortController();
  const state = (window.streamingState = {
    requests: [],
    frames: 0,
    writes: 0,
    blockedMedia: false,
    blockedWrite: false,
  });
  let releaseMedia, releaseWrite;
  const mediaGate = new Promise(resolve => {
    releaseMedia = resolve;
  });
  const writeGate = new Promise(resolve => {
    releaseWrite = resolve;
  });
  window.releaseStreamingMedia = releaseMedia;
  window.releaseStreamingWrite = releaseWrite;
  window.cancelStreaming = () => controller.abort();
  const wait = async (promise, signal) => {
    let abort;
    try {
      signal.throwIfAborted();
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, {once: true});
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
  const map = {url: `${location.origin}/init.mp4`};
  const segments = Array.from({length: 24}, (_, i) => ({url: `${location.origin}/seg${i}.m4s`, duration: 2}));
  const destination = {
    name: handle.name,
    async createWritable() {
      const file = await handle.createWritable();
      return {
        async write(chunk) {
          state.writes++;
          if (blockWrite && !state.blockedWrite) {
            state.blockedWrite = true;
            await wait(writeGate, controller.signal);
          }
          return file.write(chunk);
        },
        close: () => file.close(),
        abort: () => file.abort(),
      };
    },
  };
  window.streamingTask = (reference ? exportReference : exportSelection)(
    {
      async request(url, {signal}) {
        const match = url.match(/seg(\d+)\.m4s/);
        if (match) {
          const index = Number(match[1]);
          state.requests.push(index);
          if (blockMedia && index === blockIndex) {
            state.blockedMedia = true;
            state.framesAtBlock = state.frames;
            await wait(mediaGate, signal);
          }
        }
        return {data: await (await fetch(url, {signal})).arrayBuffer()};
      },
    },
    {room: 1, key: 'test', start: 98, end: 146},
    [
      {
        map,
        segments,
        start: 98,
        streamEnd: 146,
        streamIndex: 0,
        part: {start_time: 98, end_time: 146, clockComplete: true},
        firstSegment: segments[0],
        firstMap: map,
      },
    ],
    selection,
    {
      signal: controller.signal,
      danmaku: {},
      createFile: () => ({handle: destination, name: handle.name, remove: () => root.removeEntry(handle.name)}),
      onProgress(progress) {
        state.frames = progress.videoFrames ?? state.frames;
        state.progress = progress.progress;
      },
    },
  )
    .then(async () => {
      const input = new Input({source: new BlobSource(await handle.getFile()), formats: [MP4]});
      try {
        const audio = await input.getPrimaryAudioTrack(),
          video = await input.getPrimaryVideoTrack();
        const audioPackets = [];
        for await (const packet of new EncodedPacketSink(audio).packets())
          audioPackets.push({timestamp: packet.timestamp, duration: packet.duration, data: [...packet.data]});
        const videoTimes = [];
        for await (const packet of new EncodedPacketSink(video).packets()) videoTimes.push(packet.timestamp);
        const sample = await new VideoSampleSink(video).getSample(20);
        sample?.close();
        state.result = {duration: await input.computeDuration(), audioPackets, videoTimes, decoded: Boolean(sample)};
      } finally {
        input.dispose();
      }
    })
    .catch(error => {
      state.error = {name: error.name, message: error.message};
    })
    .finally(async () => {
      const names = [];
      for await (const name of root.keys()) names.push(name);
      state.temporary = names.filter(name => name.startsWith('bella-clip-'));
      state.done = true;
    });
};

window.startLazyResourceTest = async () => {
  const {createStreamingCompositor} = await import('../../../src/danmaku/streaming-compositor.js');
  const {VideoSample} = await import('mediabunny');
  const state = (window.lazyState = {images: 0, rendered: 0});
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  window.releaseLazyResource = release;
  const events = [
    {time: 0, text: '先显示文字', mode: 1, color: 0xffffff, order: 0},
    {time: 22, text: '[晚]', mode: 5, color: 0xffffff, order: 1},
  ];
  const reader = {
    async read({start, end}) {
      return events.filter(event => event.time >= start && event.time < end).map(event => ({...event}));
    },
    async close() {},
  };
  const fetcher = async url => {
    if (url.endsWith('index.json')) return new Response(JSON.stringify({catalog: 'catalog.json'}));
    if (url.endsWith('catalog.json'))
      return new Response(
        JSON.stringify({emotes: [{name: '晚', kind: 'emoji', file: 'late.png', width: 128, height: 128}]}),
      );
    state.images++;
    state.blocked = true;
    await gate;
    return new Response(await (await fetch('/flower.png')).arrayBuffer(), {headers: {'Content-Type': 'image/png'}});
  };
  const compositor = await createStreamingCompositor(
    {room: 1},
    {reader, origin: 0, start: 0, sourceTime: t => t, width: 640, height: 360, fetcher},
  );
  const frame = new OffscreenCanvas(640, 360);
  frame.getContext('2d').fillRect(0, 0, 640, 360);
  const sample = new VideoSample(frame, {timestamp: 0, duration: 1 / 30});
  for (const time of [0.1, 10.1, 20.1, 21.9]) {
    await compositor.prepare(time);
    const output = compositor.render(sample, time);
    output.close();
    state.rendered++;
  }
  state.beforeImages = state.images;
  window.lazyTask = compositor
    .prepare(22)
    .then(() => {
      const output = compositor.render(sample, 22);
      output.close();
      state.rendered++;
    })
    .catch(error => {
      state.error = error.message;
    })
    .finally(async () => {
      sample.close();
      await compositor.close();
      state.done = true;
    });
};

window.checkWindowPolicies = async () => {
  const {createStreamingCompositor} = await import('../../../src/danmaku/streaming-compositor.js');
  const base = {origin: 0, start: 0, sourceTime: t => t, width: 640, height: 360};
  let end = Infinity;
  const reads = [];
  const unused = await createStreamingCompositor(
    {room: 1},
    {
      ...base,
      endTime: () => end,
      reader: {
        async read({start, end}) {
          reads.push([start, end]);
          if (start >= 10) throw new Error('unused prefetch');
          return [];
        },
        async close() {},
      },
    },
  );
  end = 5;
  await unused.prepare(1);
  await unused.close();
  let limit = Infinity;
  const retried = [];
  const required = await createStreamingCompositor(
    {room: 1},
    {
      ...base,
      endTime: () => limit,
      reader: {
        async read({start, end}) {
          retried.push([start, end]);
          if (start >= 10 && end > 12) throw new Error('over-wide prefetch');
          return start >= 10 ? [{time: 11, order: 0, mode: 5, text: '需要的窗口', color: 0xffffff}] : [];
        },
        async close() {},
      },
    },
  );
  limit = 12;
  await required.prepare(11);
  await required.close();
  const persistent = await createStreamingCompositor(
    {room: 1},
    {
      ...base,
      reader: {
        async read({start}) {
          if (start >= 10) throw new Error('required window failed');
          return [];
        },
        async close() {},
      },
    },
  );
  let requiredError;
  try {
    await persistent.prepare(11);
  } catch (error) {
    requiredError = error.message;
  }
  await persistent.close();
  return {reads, retried, requiredError};
};

window.checkEmoteCache = async pressure => {
  const {createStreamingCompositor} = await import('../../../src/danmaku/streaming-compositor.js');
  const ids = pressure ? [...Array.from({length: 22}, (_, i) => i), 20, 0] : [0, 0];
  const events = ids.map((id, index) => ({
    time: pressure ? index * 10 : index * 35,
    mode: 4,
    text: `[图${id}]`,
    color: 0xffffff,
    order: index,
  }));
  const reads = {};
  const image = await (await fetch('/flower.png')).blob();
  const fetcher = async url => {
    if (url.endsWith('index.json')) return new Response(JSON.stringify({catalog: 'catalog.json'}));
    if (url.endsWith('catalog.json'))
      return new Response(
        JSON.stringify({
          emotes: [...new Set(ids)].map(id => ({
            name: `图${id}`,
            kind: 'emoji',
            file: `${id}.png`,
            width: pressure ? 1000 : 128,
            height: pressure ? 1000 : 128,
          })),
        }),
      );
    const id = Number(url.match(/(\d+)\.png$/)[1]);
    reads[id] = (reads[id] ?? 0) + 1;
    return new Response(image, {headers: {'Content-Type': 'image/png'}});
  };
  const compositor = await createStreamingCompositor(
    {room: 1},
    {
      origin: 0,
      start: 0,
      sourceTime: t => t,
      width: 1920,
      height: 1080,
      fetcher,
      reader: {
        async read({start, end}) {
          return events.filter(event => event.time >= start && event.time < end).map(event => ({...event}));
        },
        async close() {},
      },
    },
  );
  try {
    const times = pressure ? events.map(event => event.time) : [0, 10, 20, 30, 35];
    for (const time of times) await compositor.prepare(time);
    return reads;
  } finally {
    await compositor.close();
  }
};
