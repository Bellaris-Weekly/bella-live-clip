import {Input, BlobSource, MP4, VideoSampleSink, EncodedPacketSink} from 'mediabunny';
import {loadEmotes} from '../../../src/danmaku/emotes.js';
import {exportSelection} from '../../../src/media/export.js';

window.exportDanmaku = async ({meta, real = false, cancel = false}) => {
  const base = location.origin;
  const segments = meta.segments.map(item => ({url: `${base}/${item.file}`, duration: item.duration}));
  const map = meta.map ? {url: `${base}/${meta.map}`} : null;
  const start = meta.part.start_time + meta.offset - meta.record.start;
  const group = {
    segments,
    map,
    start: meta.part.start_time + meta.offset,
    streamEnd: meta.part.end_time,
    streamIndex: 0,
    offset: 0,
    part: meta.part,
    firstSegment: {url: `${base}/${meta.first ?? 'first.m4s'}`},
    firstMap: map,
  };
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('result.mp4', {create: true});
  const controller = new AbortController();
  const started = performance.now();
  let encodingStarted,
    encodedEnd,
    sawBurn = false;
  try {
    await exportSelection(
      {
        async request(url, {signal}) {
          const response = await fetch(url, {signal});
          return {data: await response.arrayBuffer()};
        },
      },
      meta.record,
      [group],
      {start: start + (real ? 0.2 : 3), end: start + (real ? 20.2 : 6)},
      {
        signal: controller.signal,
        danmaku: {adjustment: 0},
        createFile: () => ({handle, name: 'result.mp4', remove: () => root.removeEntry('result.mp4')}),
        onProgress(state) {
          if (state.message?.includes('压制弹幕')) {
            encodingStarted ??= performance.now();
            sawBurn = true;
            if (cancel && state.phase === 'processing' && state.progress > 0.66) controller.abort();
          }
          if (state.phase === 'complete') encodedEnd = performance.now();
        },
      },
    );
  } catch (error) {
    if (!cancel || error.name !== 'AbortError') throw error;
    const names = [];
    for await (const name of root.keys()) names.push(name);
    return {canceled: true, temporaryRemaining: names.filter(name => name.startsWith('bella-clip-')).length};
  }
  const file = await handle.getFile();
  const input = new Input({source: new BlobSource(file), formats: [MP4]});
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const frames = new VideoSampleSink(video);
    const snapshots = [];
    let overlayPixels = 0,
      animationFrames = 0;
    for (const time of real ? [0, 5, 10, 19] : [0, 1, 2]) {
      const sample = await frames.getSample(time);
      const canvas = document.createElement('canvas');
      canvas.width = sample.displayWidth;
      canvas.height = sample.displayHeight;
      sample.draw(canvas.getContext('2d'), 0, 0);
      sample.close();
      if (!real && time === 0) {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.floor(canvas.height / 4)).data;
        for (let i = 0; i < pixels.length; i += 4)
          if (Math.abs(pixels[i] - 18) + Math.abs(pixels[i + 1] - 52) + Math.abs(pixels[i + 2] - 86) > 30)
            overlayPixels++;
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      await fetch(`/artifact/frame-${time}.png`, {method: 'POST', body: blob});
      snapshots.push({time, width: canvas.width, height: canvas.height});
    }
    if (!real) {
      const resources = await loadEmotes([{text: '[花]'}], 1, 15);
      animationFrames = resources.assets.get('[花]').frames.length;
      resources.close();
    }
    const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].join(',');
    const originals = new Set();
    const init = map ? await (await fetch(map.url)).arrayBuffer() : null;
    for (const segment of segments) {
      const bytes = await (await fetch(segment.url)).arrayBuffer();
      const original = new Input({source: new BlobSource(new Blob(init ? [init, bytes] : [bytes])), formats: [MP4]});
      try {
        const source = await original.getPrimaryAudioTrack();
        for await (const packet of new EncodedPacketSink(source).packets()) originals.add(await digest(packet.data));
      } finally {
        original.dispose();
      }
    }
    let audioPayloadsPreserved = true;
    const packets = [];
    for await (const packet of new EncodedPacketSink(audio).packets()) {
      packets.push(packet.data.byteLength);
      audioPayloadsPreserved &&= originals.has(await digest(packet.data));
    }
    await fetch('/artifact/result.mp4', {method: 'POST', body: file});
    const result = {
      sawBurn,
      overlayPixels,
      animationFrames,
      audioPayloadsPreserved,
      duration: await input.computeDuration(),
      width: await video.getCodedWidth(),
      height: await video.getCodedHeight(),
      audioCodec: await audio.getCodec(),
      audioPackets: packets.length,
      bytes: file.size,
      totalSeconds: (encodedEnd - started) / 1000,
      encodeSeconds: (encodedEnd - encodingStarted) / 1000,
      snapshots,
    };
    const names = [];
    for await (const name of root.keys()) names.push(name);
    result.temporaryRemaining = names.filter(name => name.startsWith('bella-clip-')).length;
    return result;
  } finally {
    input.dispose();
    await root.removeEntry('result.mp4');
  }
};
