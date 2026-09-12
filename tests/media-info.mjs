import {Input,BlobSource,MP4} from 'mediabunny';

export async function inspectMedia(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    return { duration: await input.computeDuration(), width: video ? await video.getDisplayWidth() : 0,
      height: video ? await video.getDisplayHeight() : 0, hasAudio: Boolean(audio), hasVideo: Boolean(video) };
  } finally { input.dispose(); }
}
