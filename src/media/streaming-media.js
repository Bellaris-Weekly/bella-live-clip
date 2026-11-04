import {Input, MP4, ReadableStreamSource} from 'mediabunny';
import {deferred} from '../shared/deferred.js';

// One pending append, plus the reader's bounded seek cache. A small startup
// prefix can arrive before the selection clock is known; it is never unbounded.
export function createMediaPipe({signal, onCancel = () => {}, maxStartupBytes = 64 * 1024 * 1024, metrics} = {}) {
  const chunks = [];
  let position = 0,
    buffered = 0,
    reading = false,
    ended = false,
    failure;
  let changed = deferred(),
    drained = deferred();
  const wake = () => {
    changed.resolve();
    changed = deferred();
  };
  const fail = error => {
    failure ??= error;
    chunks.length = 0;
    buffered = 0;
    metrics?.gauge('bufferedMediaBytes', buffered);
    wake();
    drained.resolve();
  };
  const abort = () => fail(signal.reason);
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const stream = new ReadableStream(
    {
      async pull(controller) {
        reading = true;
        while (!chunks.length && !ended && !failure) await changed.promise;
        if (failure) return controller.error(failure);
        if (!chunks.length) return controller.close();
        const chunk = chunks.shift();
        buffered -= chunk.byteLength;
        metrics?.gauge('bufferedMediaBytes', buffered);
        controller.enqueue(chunk);
        if (!chunks.length) drained.resolve();
      },
      cancel(reason) {
        fail(reason ?? new DOMException('Aborted', 'AbortError'));
        onCancel();
      },
    },
    {highWaterMark: 0},
  );
  const file = {
    async write(chunk) {
      if (failure) throw failure;
      if (chunk.position !== position) throw new Error('流式录像出现非顺序写入。');
      position += chunk.data.byteLength;
      // Bound each handoff too: a large mux fragment must not become a second
      // equally large retained copy in the sequential reader's cache.
      for (let offset = 0; offset < chunk.data.byteLength; offset += 1024 * 1024) {
        const bytes = chunk.data.slice(offset, offset + 1024 * 1024);
        if (!chunks.length) drained = deferred();
        chunks.push(bytes);
        buffered += bytes.byteLength;
        metrics?.gauge('bufferedMediaBytes', buffered);
        if (!reading && buffered > maxStartupBytes) throw new Error('关键帧预读超过内存预算，请调整选区起点。');
        wake();
        if (reading && chunks.length) {
          const finish = metrics?.start('streamWriteWait');
          try {
            await drained.promise;
          } finally {
            finish?.();
          }
        }
        if (failure) throw failure;
      }
    },
    async close() {
      ended = true;
      wake();
    },
    async abort() {
      fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    },
  };
  return {
    readable: stream,
    handle: {createWritable: async () => file},
    fail,
    get bufferedBytes() {
      return buffered;
    },
    close() {
      signal?.removeEventListener('abort', abort);
      fail(new DOMException('Aborted', 'AbortError'));
    },
  };
}

export function createStreamingMedia(options) {
  const pipe = createMediaPipe(options);
  const input = new Input({
    source: new ReadableStreamSource(pipe.readable, {
      maxCacheSize: 64 * 1024 * 1024,
      handleUnhandledError: pipe.fail,
    }),
    formats: [MP4],
  });
  return {
    input,
    handle: pipe.handle,
    fail: pipe.fail,
    get bufferedBytes() {
      return pipe.bufferedBytes;
    },
    close() {
      input.dispose();
      pipe.close();
    },
  };
}
