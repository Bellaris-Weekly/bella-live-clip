export const PLAYBACK_LATENCY = 2;

// The collector's live archive measures, per stream clock epoch, the host UTC at
// which stream time zero was first received (origin_us). Replay fragments carry
// that stream time as tfdt, so it replaces the platform start-time estimate. The
// estimate (integer start_time) is only used to pick the epoch of this part.
export const STREAM_ORIGIN_CORRECTION = 0;
export const STREAM_EPOCH_TOLERANCE = 10;
export const STREAM_MIN_SEGMENTS = 60;

export function streamOrigin(clock, estimate) {
  if (!clock || !Number.isFinite(estimate)) return null;
  const matches = clock.epochs.filter(
    epoch =>
      Number.isSafeInteger(epoch?.origin_us) && Math.abs(epoch.origin_us / 1e6 - estimate) <= STREAM_EPOCH_TOLERANCE,
  );
  if (matches.length !== 1 || !(matches[0].segments >= STREAM_MIN_SEGMENTS)) return null;
  return matches[0].origin_us / 1e6 + STREAM_ORIGIN_CORRECTION;
}

export function receivedTime(row) {
  const time = row.t ?? (row.sent == null ? NaN : Number(row.sent) + 1000);
  return Number(time) / 1000;
}

// Positive adjustment delays comments; a negative value brings them forward.
export function commentTime(row, origin, adjustment = 0) {
  return receivedTime(row) - PLAYBACK_LATENCY - origin + adjustment;
}

export function sourceClock(entries) {
  const ranges = [...entries].sort((a, b) => a.start - b.start);
  return time => {
    let low = 0,
      high = ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ranges[middle].start <= time + 1e-6) low = middle + 1;
      else high = middle;
    }
    const entry = ranges[Math.max(0, low - 1)];
    if (!entry || time > entry.end + 0.1 || !Number.isFinite(entry.sourceOffset))
      throw new Error('弹幕源媒体时间映射缺失，已停止导出。');
    return time - entry.sourceOffset;
  };
}
