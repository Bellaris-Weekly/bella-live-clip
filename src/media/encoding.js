import { Quality, canEncodeVideo } from 'mediabunny';

export async function preciseVideoOptions(track) {
  const [width, height, stats] = await Promise.all([
    track.getSquarePixelWidth(), track.getSquarePixelHeight(), track.computePacketStats(),
  ]);
  // Budget for each source frame, with headroom for a second lossy generation.
  // An explicit bitrate avoids Quality's quantizer-first encoder selection.
  const bitrate = Math.ceil(Math.max(stats.averageBitrate * 2, width * height * stats.averagePacketRate * 0.12));
  const quality = new Quality({ bitrate });
  const hardware = await canEncodeVideo('avc', { width, height, quality, hardwareAcceleration: 'prefer-hardware' });
  return { codec: 'avc', quality, hardwareAcceleration: hardware ? 'prefer-hardware' : 'no-preference' };
}
