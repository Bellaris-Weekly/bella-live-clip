import {BufferTarget, StreamTarget, Output, Mp4OutputFormat} from 'mediabunny';
import {cleanUp, storageStep} from '../shared/errors.js';

// Each attempt owns a fresh transaction. A failed smart splice can abort and
// restart with full encoding without retaining bytes or committing a partial file.
export async function createMediaOutput({fileHandle, signal, metrics, storageTarget = 'destination'} = {}) {
  signal?.throwIfAborted();
  let file = null;
  if (fileHandle) {
    const finish = metrics?.start('fileOpen');
    try {
      file = await storageStep('createWritable', storageTarget, () => fileHandle.createWritable());
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
              await storageStep('write', storageTarget, () => file.write(chunk));
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
        await storageStep('close', storageTarget, () => file.close());
      } finally {
        finishClose?.();
      }
      file = null;
      return {bytes};
    },
    // `failure` is the error that ended the attempt, if any. A writer that
    // already failed cannot be closed again; that must not replace the cause.
    async cancel(failure) {
      await cleanUp(
        failure,
        () => {
          if (output.state !== 'finalized' && output.state !== 'canceled') return output.cancel();
        },
        () => {
          const pending = file;
          file = null;
          return pending?.abort();
        },
      );
    },
  };
}
