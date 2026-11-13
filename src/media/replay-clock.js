export const ORIGIN_CORRECTION = 0.49;

export function partOrigin(part, firstDecodeTime) {
  if (part.clockComplete !== true) throw new Error('对时需要从整场开头获取录像信息，请刷新场次后重试。');
  if (!Number.isFinite(part.start_time) || !Number.isFinite(firstDecodeTime)) throw new Error('无法读取分段媒体时钟。');
  return part.start_time - firstDecodeTime + ORIGIN_CORRECTION;
}

export async function readPartClock(request, group, signal) {
  return (await import('./replay-probe.js')).readPartClock(request, group, signal);
}

function* boxes(view, start, end) {
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return;
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
    yield {type, start: offset + header, end: offset + size};
    offset += size;
  }
}

// Select the video's tfdt, not whichever track happens to appear first.
export function firstVideoDecodeTime(bytes, trackId, timescale) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const moof of boxes(view, 0, bytes.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(view, moof.start, moof.end)) {
      if (traf.type !== 'traf') continue;
      const children = [...boxes(view, traf.start, traf.end)];
      const header = children.find(box => box.type === 'tfhd');
      const time = children.find(box => box.type === 'tfdt');
      if (!header || !time || header.end - header.start < 8 || time.end - time.start < 8) continue;
      if (view.getUint32(header.start + 4) !== trackId) continue;
      const version = view.getUint8(time.start);
      if (version > 1 || (version === 1 && time.end - time.start < 12)) break;
      const ticks = version ? Number(view.getBigUint64(time.start + 4)) : view.getUint32(time.start + 4);
      if (Number.isSafeInteger(ticks) && timescale > 0) return ticks / timescale;
    }
  }
  throw new Error('首分片缺少视频 tfdt，无法计算媒体时钟原点。');
}

// UTC is milliseconds; position is seconds from the first video decode time of
// a whole part, the same coordinate used by the replay player. Never sum EXTINF.
export function replayToUtc({part, position}) {
  return (part.origin + part.firstDecodeTime + position) * 1000;
}
export function utcToReplay(at, parts) {
  if (!parts.length) return null;
  let best;
  for (const part of parts) {
    const start = replayToUtc({part, position: 0});
    const end = part.end_time * 1000;
    const snapped = Math.max(start, Math.min(end, at));
    const distance = Math.abs(snapped - at);
    if (!best || distance < best.distance)
      best = {part, position: (snapped - start) / 1000, snapped: distance > 0, distance};
  }
  return best;
}
