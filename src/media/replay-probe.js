import {Input, BlobSource, MP4} from 'mediabunny';
import {partOrigin, firstVideoDecodeTime} from './replay-clock.js';

export async function readPartClock(request, group, signal) {
  const read = async segment =>
    new Uint8Array((await request(segment.url, {type: 'arraybuffer', range: segment.range, signal})).data);
  const [first, init] = await Promise.all([read(group.firstSegment), group.firstMap ? read(group.firstMap) : null]);
  signal?.throwIfAborted();
  const probe = new Input({source: new BlobSource(new Blob(init ? [init, first] : [first])), formats: [MP4]});
  try {
    const track = await probe.getPrimaryVideoTrack();
    if (!track) throw new Error('首分片没有视频轨');
    const firstDecodeTime = firstVideoDecodeTime(first, track.id, await track.getTimeResolution());
    return {firstDecodeTime, origin: partOrigin(group.part, firstDecodeTime)};
  } finally {
    probe.dispose();
  }
}
