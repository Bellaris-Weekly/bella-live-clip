import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMediaPipe} from '../../../src/media/streaming-media.js';

test('startup buffering is bounded and released on close', async () => {
  const media = createMediaPipe({maxStartupBytes: 4});
  const file = await media.handle.createWritable();
  await file.write({position: 0, data: new Uint8Array(4)});
  assert.equal(media.bufferedBytes, 4);
  await assert.rejects(file.write({position: 4, data: new Uint8Array(1)}), /预读超过/);
  media.close();
  assert.equal(media.bufferedBytes, 0);
});

test('a reader applies backpressure to writes and cancellation wakes a blocked writer', async () => {
  const controller = new AbortController();
  const media = createMediaPipe({signal: controller.signal});
  const file = await media.handle.createWritable();
  const reader = media.readable.getReader();
  const reading = reader.read();
  await file.write({position: 0, data: new Uint8Array([1])});
  assert.deepEqual((await reading).value, new Uint8Array([1]));
  let finished = false;
  const pending = file.write({position: 1, data: new Uint8Array([2])});
  void pending.then(
    () => {
      finished = true;
    },
    () => {},
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(media.bufferedBytes, 1);
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  media.close();
});

test('cancellation wakes an empty reader without waiting for another fragment', async () => {
  const controller = new AbortController();
  const media = createMediaPipe({signal: controller.signal});
  const reader = media.readable.getReader();
  const reading = reader.read();
  controller.abort();
  await assert.rejects(reading, {name: 'AbortError'});
  media.close();
});

test('large mux writes are handed off in bounded chunks', async () => {
  const media = createMediaPipe(),
    reader = media.readable.getReader();
  const file = await media.handle.createWritable();
  const initial = reader.read();
  await file.write({position: 0, data: new Uint8Array([1])});
  await initial;
  const pending = file.write({position: 1, data: new Uint8Array(2 * 1024 * 1024 + 1)});
  assert.equal((await reader.read()).value.length, 1024 * 1024);
  assert.equal((await reader.read()).value.length, 1024 * 1024);
  assert.equal((await reader.read()).value.length, 1);
  await pending;
  assert.equal(media.bufferedBytes, 0);
  media.close();
});
