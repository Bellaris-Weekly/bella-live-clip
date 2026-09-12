function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)]
    .map(match => [match[1], match[2] ?? match[3]]));
}

function byteRange(value, previousEnd) {
  const match = String(value).match(/^(\d+)(?:@(\d+))?$/);
  if (!match || Number(match[1]) <= 0) throw new Error('视频分片字节范围无效。');
  const offset = match[2] === undefined ? previousEnd : Number(match[2]);
  if (!Number.isSafeInteger(offset)) throw new Error('视频分片缺少字节起始位置。');
  return { offset, length: Number(match[1]) };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('B 站未返回有效的视频分片清单，请重新载入。');
  const groups = [];
  let segments = [], duration = null, map = null, rangeText = null, previous = null, total = 0;
  const flush = () => {
    if (segments.length) { groups.push({ segments, map, offset: total - segments.reduce((n, s) => n + s.duration, 0) }); segments = []; }
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) throw new Error('该场次返回了多清晰度清单，当前剪辑接口格式不受支持。');
    if (line.startsWith('#EXT-X-KEY:')) {
      if (attributes(line).METHOD !== 'NONE') throw new Error('该录像包含加密分片，无法导出。');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      flush();
      const attrs = attributes(line);
      map = { url: new URL(attrs.URI, baseUrl).href,
        range: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, undefined) : null };
    } else if (line === '#EXT-X-DISCONTINUITY') {
      flush(); previous = null;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      rangeText = line.slice(line.indexOf(':') + 1);
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      if (!(duration > 0)) throw new Error('视频分片时长无效。');
    } else if (line && !line.startsWith('#')) {
      if (duration === null) throw new Error('视频清单缺少分片时长。');
      const url = new URL(line, baseUrl).href;
      const prevEnd = previous?.url === url && previous.range ? previous.range.offset + previous.range.length : undefined;
      const range = rangeText ? byteRange(rangeText, prevEnd) : null;
      const segment = { url, duration, range };
      segments.push(segment); previous = segment; total += duration; duration = null; rangeText = null;
    }
  }
  flush();
  if (!groups.length) throw new Error('这个时间段尚无可下载的视频分片，请调整时间或稍后重试。');
  return { groups, duration: total, segmentCount: groups.reduce((n, g) => n + g.segments.length, 0) };
}

export async function mapConcurrent(items, concurrency, task, signal) {
  const result = new Array(items.length);
  let cursor = 0, failed = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      try { result[index] = await task(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  });
  await Promise.all(workers);
  return result;
}

export function selectPlaylistRange(parsed,start,end) {
 const plans=[];
 for(const group of parsed.groups){
  let cursor=group.offset;const selected=[];let first;
  for(const segment of group.segments){const next=cursor+segment.duration;if(next>start&&cursor<end){first??=cursor;selected.push(segment);}cursor=next;}
  if(selected.length)plans.push({segments:selected,map:group.map,start:Math.max(0,start-first),end:Math.min(end,cursor)-first,offset:first});
 }
 return plans;
}
