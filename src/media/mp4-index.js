import { BufferSource, Input, MP4 } from 'mediabunny';

// DASH exposes SIDX, whereas the pinned demuxer seeks through TFRA. Append an
// in-memory MFRA view of that index; original media bytes and offsets never move.
export async function createFragmentIndex(prefix, indexRange, fileSize) {
  const fail = () => { throw new Error('视频分段索引无效，无法定位选段，请重新加载视频。'); };
  const bytes = prefix.subarray(indexRange.offset, indexRange.offset + indexRange.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 32 || view.getUint32(0) !== bytes.length
    || String.fromCharCode(...bytes.subarray(4, 8)) !== 'sidx' || bytes[8] > 1) fail();
  const version = bytes[8], trackId = view.getUint32(12), timescale = view.getUint32(16);
  let pos = 20;
  const word = () => {
    const length = version ? 8 : 4;
    if (pos + length > bytes.length) fail();
    const value = version ? Number(view.getBigUint64(pos)) : view.getUint32(pos);
    pos += length;
    if (!Number.isSafeInteger(value)) fail();
    return value;
  };
  let time = word(), offset = indexRange.offset + bytes.length + word();
  if (!timescale || pos + 4 > bytes.length) fail();
  const count = view.getUint16(pos + 2); pos += 4;
  if (!count || pos + count * 12 !== bytes.length) fail();
  const segments = [], entries = [];
  for (let i = 0; i < count; i++, pos += 12) {
    const reference = view.getUint32(pos), duration = view.getUint32(pos + 4), sap = view.getUint32(pos + 8);
    // Hierarchical references are other indexes, not media. Never treat their
    // offsets as fragment locations or silently fall back to a whole-file scan.
    if (reference >= 0x80000000 || !reference || !duration || offset + reference > fileSize) fail();
    segments.push({ start: time / timescale, end: (time + duration) / timescale, bytes: reference });
    if ((sap >>> 31) && (sap & 0x0fffffff) === 0) entries.push({ time, offset });
    time += duration; offset += reference;
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(offset)) fail();
  }
  if (!entries.length) fail();
  const input = new Input({ source: new BufferSource(prefix), formats: [MP4] });
  let trackScale;
  try {
    const tracks = await input.getTracks();
    const track = tracks.find(item => item.id === trackId);
    if (!track) fail();
    trackScale = await track.getTimeResolution();
  } finally { input.dispose(); }
  const trailer = new Uint8Array(8 + 24 + entries.length * 19 + 16);
  const out = new DataView(trailer.buffer);
  const box = (at, size, type) => {
    out.setUint32(at, size);
    trailer.set([...type].map(char => char.charCodeAt(0)), at + 4);
  };
  box(0, trailer.length, 'mfra');
  box(8, 24 + entries.length * 19, 'tfra');
  trailer[16] = 1;
  out.setUint32(20, trackId);
  out.setUint32(28, entries.length);
  pos = 32;
  for (const entry of entries) {
    const timestamp = Math.floor(entry.time * trackScale / timescale);
    if (!Number.isSafeInteger(timestamp)) fail();
    out.setBigUint64(pos, BigInt(timestamp));
    out.setBigUint64(pos + 8, BigInt(entry.offset));
    trailer.set([1, 1, 1], pos + 16); pos += 19;
  }
  box(pos, 16, 'mfro');
  out.setUint32(pos + 12, trailer.length);
  return { trailer, segments };
}
