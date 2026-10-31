import { BlobSource, Input, MP4, MPEG_TS } from 'mediabunny';
import { convertInput } from '../../../src/media/export.js';

export async function convertMp4(blob, options = {}) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4, MPEG_TS] });
  try { return await convertInput(input, options); }
  finally { input.dispose(); }
}

// Never overwrite an unrelated existing clip in a real test directory.
export async function createClipFile(directory, name) {
  const stem = name.replace(/\.mp4$/i, '');
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix ? `${stem} (${suffix}).mp4` : name;
    try { await directory.getFileHandle(candidate); }
    catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      const handle = await directory.getFileHandle(candidate, { create: true });
      return { handle, name: candidate, remove: () => directory.removeEntry(candidate) };
    }
  }
}
