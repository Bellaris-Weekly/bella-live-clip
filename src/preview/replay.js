import {readPartClock, utcToReplay} from '../media/replay-clock.js';

// Cache only the origin, not the growing end or signed playlist address.
export function createReplayClock(request) {
  const cache = new Map();
  return async (groups, signal) =>
    Promise.all(
      groups
        .filter((group, i) => !i || group.part !== groups[i - 1].part)
        .map(async group => {
          const key = group.part.start_time;
          if (!cache.has(key)) {
            const pending = readPartClock(request, group, signal).catch(error => {
              cache.delete(key);
              throw error;
            });
            cache.set(key, pending);
          }
          return {...group.part, ...(await cache.get(key)), index: group.streamIndex};
        }),
    );
}

export function markSelection(at, before, after, parts) {
  if (!(before + after > 0)) throw new Error('前后余量合计须大于 0 秒');
  if (!parts.length || at + after * 1000 > parts.at(-1).end_time * 1000) return null;
  const start = utcToReplay(at - before * 1000, parts),
    end = utcToReplay(at + after * 1000, parts);
  // The editor exports one part at a time. Keep a crossing selection in the
  // part containing the mark and explicitly tell the user it was shortened.
  const middle = utcToReplay(at, parts);
  const part = middle.part;
  const duration = part.end_time - part.origin - part.firstDecodeTime;
  let left = start.part === part ? start.position : 0;
  let right = end.part === part ? end.position : duration;
  // A long outage can collapse both endpoints onto one boundary. Select nearby
  // footage at that boundary instead of handing the editor an empty range.
  if (right <= left) {
    const width = Math.min(duration, before + after);
    left = Math.max(0, Math.min(duration - width, middle.position - before));
    right = left + width;
  }
  return {
    part,
    start: left,
    end: right,
    snapped: start.snapped || end.snapped || middle.snapped || start.part !== end.part,
  };
}
