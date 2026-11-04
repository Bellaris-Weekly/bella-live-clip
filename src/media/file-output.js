import {BufferTarget, StreamTarget, Output, Mp4OutputFormat} from 'mediabunny';

// Each attempt owns a fresh transaction. A failed smart splice can abort and
// restart with full encoding without retaining bytes or committing a partial file.
export async function createMediaOutput({fileHandle, signal, metrics} = {}) {
  signal?.throwIfAborted();
  let file = null;
  if (fileHandle) {
    const finish = metrics?.start('fileOpen');
    try {
      file = await fileHandle.createWritable();
    } finally {
      finish?.();
    }
  }
  let bytes = 0;
  const target = file
    ? new StreamTarget(
        new WritableStream({
          async write(chunk) {
            signal?.throwIfAborted();
            const finish = metrics?.start('fileWrite');
            try {
              await file.write(chunk);
              metrics?.add('writtenBytes', chunk.data.byteLength);
            } finally {
              finish?.();
            }
            bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
          },
        }),
        {chunked: true, chunkSize: 1024 * 1024},
      )
    : new BufferTarget();
  const output = new Output({format: new Mp4OutputFormat({fastStart: false}), target});
  return {
    output,
    async finish() {
      const finish = metrics?.start('outputFinalize');
      try {
        if (output.state !== 'finalized') await output.finalize();
      } finally {
        finish?.();
      }
      signal?.throwIfAborted();
      if (!fileHandle) return new Blob([target.buffer], {type: 'video/mp4'});
      const finishClose = metrics?.start('fileClose');
      try {
        await file.close();
      } finally {
        finishClose?.();
      }
      file = null;
      return {bytes};
    },
    async cancel() {
      try {
        if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
      } finally {
        if (file) {
          const pending = file;
          file = null;
          await pending.abort();
        }
      }
    },
  };
}
