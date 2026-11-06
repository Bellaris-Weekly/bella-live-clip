import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedFetch} from '../../../src/danmaku/archive.js';
import {storageStep, cleanUp} from '../../../src/shared/errors.js';
import {createMediaPipe} from '../../../src/media/streaming-media.js';

for (const operation of ['archiveRead', 'emoteFetch'])
  test(`${operation} timeout retains its identity through a failed stream write and close`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const fetching = boundedFetch('https://example.test/resource', {
      ...(operation === 'emoteFetch' ? {operation} : {}),
      fetcher: (_, {signal}) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        }),
    });
    t.mock.timers.tick(30000);
    let timeout;
    await assert.rejects(fetching, error => {
      timeout = error;
      return error.retryable && /超时/.test(error.message);
    });
    const controller = new AbortController(),
      media = createMediaPipe({signal: controller.signal});
    const file = await media.handle.createWritable();
    const reader = media.readable.getReader();
    const reading = reader.read();
    await file.write({position: 0, data: new Uint8Array([1])});
    await reading;
    const writer = new WritableStream({
      write: chunk => storageStep('write', 'stream', () => file.write(chunk)),
    }).getWriter();
    const writing = writer.write({position: 1, data: new Uint8Array([2])});
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(timeout);
    await assert.rejects(writing, error => error === timeout);
    await cleanUp(timeout, () => writer.close());
    assert.deepEqual(timeout.diagnostic, {operation, target: 'network'});
    assert.equal(timeout.suppressed.length, 1);
    assert.ok(timeout.suppressed[0] instanceof TypeError);
    media.close();
  });
