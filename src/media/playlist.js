function attributes(text) {
  return Object.fromEntries(
    [...text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(match => [match[1], match[2] ?? match[3]]),
  );
}

function byteRange(value, previousEnd) {
  const match = String(value).match(/^(\d+)(?:@(\d+))?$/);
  if (!match || Number(match[1]) <= 0) throw new Error('视频分片字节范围无效。');
  const offset = match[2] === undefined ? previousEnd : Number(match[2]);
  if (!Number.isSafeInteger(offset)) throw new Error('视频分片缺少字节起始位置。');
  return {offset, length: Number(match[1])};
}

// Bilibili lists fragment durations rounded to 0.01 s (4.17 for 250 frames at 60 fps). Summed over a
// long recording that drifts by seconds, so durations are restored to whole 60 fps frames. Preview and
// export must share this, or a clip lands away from where it was picked.
const FRAME_GRID = 60;
const onGrid = (value, grid, tolerance) => Math.abs(value * grid - Math.round(value * grid)) <= tolerance;
export function frameDuration(listed) {
  const frames = Math.round(listed * FRAME_GRID);
  return onGrid(listed, FRAME_GRID, 0.31) ? frames / FRAME_GRID : listed;
}
// Whether a whole playlist reads as rounded 60 fps: every duration within rounding of whole frames,
// and not all of them exact on a 50 fps grid (25/50 fps fragments are listed exactly, e.g. 4.12).
// Returns the duration mapping to use for every fragment of that playlist.
export function playlistDurations(text) {
  const listed = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
  const rounded =
    listed.length > 0 &&
    listed.every(value => onGrid(value, FRAME_GRID, 0.31)) &&
    !listed.every(value => onGrid(value, 50, 1e-6));
  return rounded ? frameDuration : value => value;
}

export function parsePlaylist(text, baseUrl) {
  const restore = playlistDurations(text);
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('B 站未返回有效的视频分片清单，请重新载入。');
  const groups = [];
  let segments = [],
    duration = null,
    map = null,
    rangeText = null,
    previous = null,
    total = 0;
  const flush = () => {
    if (segments.length) {
      groups.push({segments, map, offset: total - segments.reduce((n, s) => n + s.duration, 0)});
      segments = [];
    }
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) throw new Error('该场次返回了多清晰度清单，当前剪辑接口格式不受支持。');
    if (line.startsWith('#EXT-X-KEY:')) {
      if (attributes(line).METHOD !== 'NONE') throw new Error('该录像包含加密分片，无法导出。');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      flush();
      const attrs = attributes(line);
      map = {
        url: new URL(attrs.URI, baseUrl).href,
        range: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, undefined) : null,
      };
    } else if (line === '#EXT-X-DISCONTINUITY') {
      flush();
      previous = null;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      rangeText = line.slice(line.indexOf(':') + 1);
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      if (!(duration > 0)) throw new Error('视频分片时长无效。');
      duration = restore(duration);
    } else if (line && !line.startsWith('#')) {
      if (duration === null) throw new Error('视频清单缺少分片时长。');
      const url = new URL(line, baseUrl).href;
      const prevEnd =
        previous?.url === url && previous.range ? previous.range.offset + previous.range.length : undefined;
      const range = rangeText ? byteRange(rangeText, prevEnd) : null;
      const segment = {url, duration, range};
      segments.push(segment);
      previous = segment;
      total += duration;
      duration = null;
      rangeText = null;
    }
  }
  flush();
  if (!groups.length) throw new Error('这个时间段尚无可下载的视频分片，请调整时间或稍后重试。');
  return {groups, duration: total};
}

export const segmentKey = segment => JSON.stringify([segment.url, segment.range ?? null]);

// The fragment holding an absolute recording time, within its timed group.
export function locateSegment(groups, time) {
  for (const group of groups) {
    let cursor = group.start;
    if (time < cursor) continue;
    for (const segment of group.segments) {
      if (time < cursor + segment.duration) return {segment, map: group.map};
      cursor += segment.duration;
    }
  }
  return null;
}

export function selectPlaylistRange(parsed, start, end) {
  const plans = [];
  for (const group of parsed.groups) {
    let cursor = group.offset;
    const selected = [];
    let first;
    for (const segment of group.segments) {
      const next = cursor + segment.duration;
      if (next > start && cursor < end) {
        first ??= cursor;
        selected.push(segment);
      }
      cursor = next;
    }
    if (selected.length)
      plans.push({
        segments: selected,
        map: group.map,
        start: Math.max(0, start - first),
        end: Math.min(end, cursor) - first,
        offset: first,
      });
  }
  return plans;
}
