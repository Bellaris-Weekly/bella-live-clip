const time = value => Math.round(value * 1e6) / 1e6;

// One common epoch for all tracks. PTS may reorder inside a GOP: never clamp or
// sort individual packets. Only a discontinuity/reset moves a complete segment.
export class RecordingTimeline {
  constructor() { this.offset = null; this.tracks = new Map(); this.end = 0; }

  append(tracks, discontinuity = false) {
    const starts = tracks.map(track => track.packets.reduce((min, packet) => Math.min(min, packet.timestamp), Infinity));
    const first = Math.min(...starts);
    if (!Number.isFinite(first)) throw new Error('录像分片没有音视频数据。');
    if (this.offset === null || discontinuity) this.offset = time(this.end - first);
    let correction = 0;
    for (const [index, track] of tracks.entries()) {
      const previous = this.tracks.get(track.key);
      if (!previous) continue;
      let boundary = previous.boundary;
      for (const packet of track.packets) {
        if (packet.type === 'key') boundary = previous.max;
        if (time(packet.timestamp + this.offset) < boundary) {
          correction = Math.max(correction, previous.end - time(starts[index] + this.offset));
          break;
        }
      }
    }
    this.offset = time(this.offset + correction);
    for (const track of tracks) {
      const state = this.tracks.get(track.key) ?? {max: -Infinity, boundary: -Infinity, end: 0};
      for (const packet of track.packets) {
        const timestamp = time(packet.timestamp + this.offset);
        if (packet.type === 'key') state.boundary = state.max;
        if (timestamp < state.boundary) throw new Error('录像分片内部的关键帧时间线发生倒退，无法无损拼接。');
        state.max = Math.max(state.max, timestamp);
        state.end = Math.max(state.end, time(timestamp + packet.duration));
      }
      this.tracks.set(track.key, state); this.end = Math.max(this.end, state.end);
    }
    return this.offset;
  }
}
