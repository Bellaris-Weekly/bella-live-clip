import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapConcurrent} from '../../../src/shared/concurrent.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return {promise, resolve};
};

test('bounded workers overlap independent work and preserve input order', async () => {
  const gates = Array.from({length: 5}, deferred),
    started = [];
  const work = mapConcurrent([0, 1, 2, 3, 4], 2, async i => {
    started.push(i);
    await gates[i].promise;
    return i * 2;
  });
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await work, [0, 2, 4, 6, 8]);
});

test('failure aborts siblings and waits for their cleanup before rejecting', async () => {
  const gate = deferred();
  let siblingSignal,
    settled = false,
    cleaned = false;
  const failure = new Error('failed image');
  const work = mapConcurrent([0, 1, 2], 2, async (item, _, signal) => {
    if (item === 0) {
      await gate.promise;
      throw failure;
    }
    assert.equal(item, 1, 'no queued work starts after failure');
    siblingSignal = signal;
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    await new Promise(resolve => setImmediate(resolve));
    cleaned = true;
  });
  const checked = assert.rejects(work, error => error === failure);
  void checked.then(() => {
    settled = true;
  });
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(siblingSignal.aborted, true);
  assert.equal(settled, false);
  await checked;
  assert.equal(cleaned, true);
});

test('already canceled work never starts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    mapConcurrent([1], 3, () => assert.fail('started'), controller.signal),
    {name: 'AbortError'},
  );
});
