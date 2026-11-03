export const PLAYBACK_LATENCY = 2;
export const ORIGIN_CORRECTION = 0.49;
export const PREROLL = 15;

export function partOrigin(part, firstDecodeTime) {
  if (part.clockComplete !== true) throw new Error('弹幕对时需要从整场开头获取录像信息，请刷新场次后重试。');
  if (!Number.isFinite(part.start_time) || !Number.isFinite(firstDecodeTime))
    throw new Error('无法读取分段媒体时钟，已停止弹幕导出。');
  return part.start_time - firstDecodeTime + ORIGIN_CORRECTION;
}

export function receivedTime(row) {
  const time = row.t ?? (row.sent == null ? NaN : Number(row.sent) + 1000);
  return Number(time) / 1000;
}

// Positive adjustment delays comments; a negative value brings them forward.
export function commentTime(row, origin, adjustment = 0) {
  return receivedTime(row) - PLAYBACK_LATENCY - origin + adjustment;
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
  throw new Error('首分片缺少视频 tfdt，无法计算弹幕原点。');
}

export function sourceClock(entries) {
  const ranges = [...entries].sort((a, b) => a.start - b.start);
  return time => {
    const entry = ranges.findLast(item => item.start <= time + 1e-6) ?? ranges[0];
    if (!entry || time > entry.end + 0.1 || !Number.isFinite(entry.sourceOffset))
      throw new Error('弹幕源媒体时间映射缺失，已停止导出。');
    return time - entry.sourceOffset;
  };
}
