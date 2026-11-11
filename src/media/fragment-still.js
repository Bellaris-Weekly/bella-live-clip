import {BufferSource, EncodedPacketSink, Input, MP4, VideoSampleSink} from 'mediabunny';
import {drawFitted} from '../shared/fit.js';

// One request is worth more than a few kilobytes: latency dominates a still.
// Observed keyframes stay under this, so the opening usually arrives in one read.
const OPENING_BYTES = 480 * 1024,
  WIDTH = 320,
  HEIGHT = 180;

function* boxes(view, start, end) {
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset);
    if (size === 1 && offset + 16 <= end) size = Number(view.getBigUint64(offset + 8));
    if (size < 8) return;
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
    yield {type, offset, size};
    offset += size;
  }
}

// Where the first sample of every track has ended, from a moof's run tables.
function firstSamplesEnd(view, moof) {
  let end = 0;
  for (const traf of boxes(view, moof.offset + 8, moof.offset + moof.size)) {
    if (traf.type !== 'traf') continue;
    const children = [...boxes(view, traf.offset + 8, traf.offset + traf.size)];
    const header = children.find(box => box.type === 'tfhd'),
      run = children.find(box => box.type === 'trun');
    if (!header || !run || !(view.getUint32(header.offset + 8) & 0x20000)) return null;
    const flags = view.getUint32(run.offset + 8) & 0xffffff;
    if (!(flags & 0x1) || !(flags & 0x200)) return null;
    let cursor = run.offset + 20;
    const dataOffset = view.getInt32(run.offset + 16);
    if (flags & 0x4) cursor += 4;
    if (flags & 0x100) cursor += 4;
    end = Math.max(end, moof.offset + dataOffset + view.getUint32(cursor));
  }
  return end || null;
}

// How much of a fragment's start a picture needs, read from its headers alone.
// `pictureEnd` covers the first samples; `mediaEnd` closes their media box.
export function openingLayout(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pictureEnd = null;
  for (const box of boxes(view, 0, bytes.length)) {
    if (box.type === 'moof' && box.offset + box.size <= bytes.length) pictureEnd = firstSamplesEnd(view, box);
    if (box.type === 'mdat') {
      const mediaEnd = box.offset + box.size;
      return {pictureEnd: Math.min(pictureEnd ?? mediaEnd, mediaEnd), mediaEnd};
    }
  }
  return null;
}

async function readBytes(request, part, offset, length, signal) {
  const start = (part.range?.offset ?? 0) + offset;
  const {data} = await request(part.url, {type: 'arraybuffer', range: {offset: start, length}, signal});
  return new Uint8Array(data);
}

function join(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// A replay fragment opens on a keyframe. That one frame, a tenth of the
// fragment, yields a picture without a player or the rest of the download.
export async function readFragmentStill(
  request,
  {segment, map},
  {signal, makeCanvas = () => document.createElement('canvas'), nativeSize = false},
) {
  signal.throwIfAborted();
  const head = await readBytes(request, segment, 0, OPENING_BYTES, signal);
  const layout = openingLayout(head);
  if (!layout) throw new Error('分片开头不是标准的媒体结构。');
  const opening =
    layout.pictureEnd <= head.length
      ? head
      : join(head, await readBytes(request, segment, head.length, layout.pictureEnd - head.length, signal));
  // The demuxer needs its media box whole, but only ever reads the first sample.
  const fragment = new Uint8Array(layout.mediaEnd);
  fragment.set(opening.subarray(0, Math.min(opening.length, layout.mediaEnd)));
  const init = map ? await readBytes(request, map, 0, map.range?.length ?? OPENING_BYTES, signal) : null;
  signal.throwIfAborted();
  const input = new Input({source: new BufferSource(init ? join(init, fragment) : fragment), formats: [MP4]});
  let sample;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('分片没有画面。');
    const packet = await new EncodedPacketSink(track).getFirstPacket();
    if (!packet || ((await track.determinePacketType(packet)) ?? packet.type) !== 'key')
      throw new Error('分片不是从关键帧开始。');
    sample = await new VideoSampleSink(track).getSample(packet.timestamp);
    signal.throwIfAborted();
    if (!sample) throw new Error('分片没有可解码的画面。');
    const canvas = makeCanvas();
    canvas.width = nativeSize ? sample.displayWidth : WIDTH;
    canvas.height = nativeSize ? sample.displayHeight : HEIGHT;
    const context = canvas.getContext('2d');
    drawFitted(
      context,
      (x, y, width, height) => sample.draw(context, x, y, width, height),
      sample.displayWidth,
      sample.displayHeight,
      canvas.width,
      canvas.height,
    );
    return canvas;
  } finally {
    sample?.close();
    input.dispose();
  }
}
