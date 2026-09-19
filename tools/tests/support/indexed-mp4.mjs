// Turn the muxer's MFRA file into the SIDX-only layout used by DASH servers.
// Each generated video fragment contains one 2-second GOP.
export function withSegmentIndex(bytes, { version = 0, timescale = 1000, firstOffset = 0 } = {}) {
  const boxes = [];
  for (let pos = 0; pos < bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos);
    const size = view.getUint32(0), type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (size < 8) throw new Error('Invalid fixture box');
    boxes.push({ pos, size, type }); pos += size;
  }
  const first = boxes.find(box => box.type === 'moof').pos;
  const fragments = boxes.filter(box => box.type === 'moof').map(box => {
    const index = boxes.indexOf(box), mdat = boxes[index + 1];
    if (mdat.type !== 'mdat') throw new Error('Expected contiguous fixture fragment');
    return bytes.subarray(box.pos, mdat.pos + mdat.size);
  });
  const sidx = new Uint8Array((version ? 40 : 32) + 12 * fragments.length), view = new DataView(sidx.buffer);
  view.setUint32(0, sidx.length); sidx.set([115, 105, 100, 120], 4); sidx[8] = version;
  view.setUint32(12, 1); view.setUint32(16, timescale);
  if (version) view.setBigUint64(28, BigInt(firstOffset)); else view.setUint32(24, firstOffset);
  let pos = version ? 36 : 28;
  view.setUint16(pos + 2, fragments.length); pos += 4;
  for (const fragment of fragments) {
    view.setUint32(pos, fragment.length); view.setUint32(pos + 4, 2 * timescale);
    view.setUint32(pos + 8, 0x90000000); pos += 12;
  }
  const padding = new Uint8Array(firstOffset);
  if (firstOffset) { new DataView(padding.buffer).setUint32(0, firstOffset); padding.set([102,114,101,101], 4); }
  return { bytes: new Uint8Array(Buffer.concat([bytes.subarray(0, first), sidx, padding, ...fragments])),
    indexRange: { offset: first, length: sidx.length } };
}
