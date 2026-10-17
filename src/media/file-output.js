import { BufferTarget, StreamTarget, Output, Mp4OutputFormat } from 'mediabunny';

// Each attempt owns a fresh transaction. A failed smart splice can abort and
// restart with full encoding without retaining bytes or committing a partial file.
export async function createMediaOutput({ fileHandle, signal } = {}) {
  signal?.throwIfAborted();
  let file = fileHandle ? await fileHandle.createWritable() : null;
  let bytes = 0;
  const target = file ? new StreamTarget(new WritableStream({
    async write(chunk) {
      signal?.throwIfAborted();
      await file.write(chunk);
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
    },
  }), { chunked: true, chunkSize: 1024 * 1024 }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  return {
    output,
    async finish() {
      if (output.state !== 'finalized') await output.finalize();
      signal?.throwIfAborted();
      if (!fileHandle) return new Blob([target.buffer], { type: 'video/mp4' });
      await file.close();
      file = null;
      return { bytes };
    },
    async cancel() {
      try {
        if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
      } finally {
        if (file) { const pending = file; file = null; await pending.abort(); }
      }
    },
  };
}

// Directory saves must never overwrite an unrelated existing clip.
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
