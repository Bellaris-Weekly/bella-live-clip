import {BufferSource, EncodedPacketSink, Input, MP4, VideoSampleSink} from 'mediabunny';
import {drawFitted} from '../shared/fit.js';

const PROBE_BYTES = 8192, WIDTH = 320, HEIGHT = 180;

// Byte length through the first media box, read from the box headers alone.
export function firstMediaEnd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 8 <= bytes.length;) {
    let size = view.getUint32(offset);
    if (size === 1 && offset + 16 <= bytes.length) size = Number(view.getBigUint64(offset + 8));
    if (size < 8) return null;
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'mdat') return offset + size;
    offset += size;
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
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

// A replay fragment opens on a keyframe and is a few megabytes, of which the
// first media box is about a tenth. That box alone yields a picture, without a
// player, a playlist parse or the rest of the fragment.
export async function readFragmentStill(request, {segment, map}, {signal, makeCanvas = () => document.createElement('canvas')}) {
  signal.throwIfAborted();
  const head = await readBytes(request, segment, 0, PROBE_BYTES, signal);
  const end = firstMediaEnd(head);
  if (!end) throw new Error('分片开头不是标准的媒体结构。');
  const first = end <= head.length ? head.subarray(0, end)
    : join(head, await readBytes(request, segment, head.length, end - head.length, signal));
  const init = map ? await readBytes(request, map, 0, map.range?.length ?? PROBE_BYTES, signal) : null;
  signal.throwIfAborted();
  const input = new Input({source: new BufferSource(init ? join(init, first) : first), formats: [MP4]});
  let sample;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('分片没有画面。');
    const packet = await new EncodedPacketSink(track).getFirstPacket();
    if (!packet || (await track.determinePacketType(packet) ?? packet.type) !== 'key') throw new Error('分片不是从关键帧开始。');
    sample = await new VideoSampleSink(track).getSample(packet.timestamp);
    signal.throwIfAborted();
    if (!sample) throw new Error('分片没有可解码的画面。');
    const canvas = makeCanvas();
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    drawFitted(context, (x, y, width, height) => sample.draw(context, x, y, width, height),
      sample.displayWidth, sample.displayHeight, WIDTH, HEIGHT);
    return canvas;
  } finally {
    sample?.close();
    input.dispose();
  }
}
