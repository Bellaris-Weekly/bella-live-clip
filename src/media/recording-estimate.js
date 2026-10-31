// Fragments run to several megabytes; one byte and its Content-Range give the size.
async function segmentSize(api, segment, signal) {
  try {
    const {headers} = await api.request(segment.url, {
      type: 'arraybuffer',
      range: {offset: 0, length: 1},
      needHeaders: true,
      signal,
    });
    const total = Number(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headers ?? '')?.[1]);
    if (total > 0) return total;
  } catch (error) {
    signal?.throwIfAborted();
  }
  return (await api.request(segment.url, {type: 'arraybuffer', signal})).data.byteLength;
}

export async function estimateRecordingRate(api, groups, signal, previous) {
  // Sample each uninterrupted part so quality changes are reflected in its estimate.
  const rates = [];
  for (const group of groups) {
    const cached = previous?.groups.find(old => old.start === group.start && old.streamIndex === group.streamIndex);
    if (cached) {
      rates.push({...group, rate: cached.rate});
      continue;
    }
    const sample = group.segments[Math.floor(group.segments.length / 2)];
    const size = sample.range?.length ?? (await segmentSize(api, sample, signal));
    const rate = size / sample.duration;
    rates.push({...group, rate});
  }
  return {groups: rates};
}

export function estimateSelectionBytes(estimate, recordStart, selection) {
  let bytes = 0;
  for (const group of estimate.groups) {
    let cursor = group.start - recordStart;
    for (const segment of group.segments) {
      const overlap = Math.max(
        0,
        Math.min(cursor + segment.duration, selection.end) - Math.max(cursor, selection.start),
      );
      bytes += overlap * (segment.range ? segment.range.length / segment.duration : group.rate);
      cursor += segment.duration;
    }
  }
  return bytes;
}
