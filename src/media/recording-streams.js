import {parsePlaylist} from './playlist.js';

const unavailable = '这场暂时没有可下载的录像分段，请稍后刷新。';

// A zero in the API can still refer to a real playlist. Anchor its media at the
// original wall time and never extend it into the following part.
export async function measureRecordingStream(parts, index, record, request, signal) {
  const part = parts[index];
  const response = await request(part.stream, {signal});
  signal?.throwIfAborted();
  const {duration} = parsePlaylist(response.data, response.url);
  const end = Math.min(
    part.start_time + duration,
    parts[index + 1]?.start_time ?? Infinity,
    record.live ? Infinity : record.end,
  );
  if (!Number.isFinite(end) || end <= Math.max(record.start, part.start_time)) throw new Error(unavailable);
  return {...part, end_time: end, playlistTimed: true};
}

export async function recordingStreams(record, parts, request, signal, previous = []) {
  signal?.throwIfAborted();
  const end = record.live ? Infinity : record.end;
  const candidates = parts.filter(
    part =>
      typeof part.stream === 'string' &&
      part.stream &&
      Number.isFinite(part.start_time) &&
      Number.isFinite(part.end_time) &&
      part.end_time >= part.start_time &&
      part.start_time < end &&
      (part.end_time > record.start || part.start_time === part.end_time),
  );
  const timed = part => part.end_time > part.start_time;
  if (candidates.some(timed)) {
    // A recovered part that is already open still belongs to the recording
    // after a reconnect, even if the API keeps reporting its duration as zero.
    const known = new Map(previous.filter(part => part.playlistTimed).map(part => [part.start_time, part.end_time]));
    const streams = candidates.map((part, i) => {
      const measured = Math.min(known.get(part.start_time) ?? 0, candidates[i + 1]?.start_time ?? Infinity, end);
      return !timed(part) && measured > Math.max(record.start, part.start_time)
        ? {...part, end_time: measured, playlistTimed: true}
        : part;
    });
    // Interior parts stay selectable. Measure an interior zero only on demand.
    return streams.slice(streams.findIndex(timed), streams.findLastIndex(timed) + 1);
  }

  // With no reported footage, try the playlists before declaring the recording
  // unavailable. One unreadable part must not hide another usable part.
  const playable = [];
  let failure;
  for (let index = 0; index < candidates.length; index++) {
    try {
      playable.push(await measureRecordingStream(candidates, index, record, request, signal));
    } catch (error) {
      signal?.throwIfAborted();
      failure ??= error;
    }
  }
  if (!playable.length) throw failure ?? new Error(unavailable);
  return playable;
}
