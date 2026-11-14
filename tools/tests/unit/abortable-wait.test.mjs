import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createAbortableWait} from '../../../src/shared/abortable-wait.js';
import {deferred} from '../../../src/shared/deferred.js';

test('completed waits release cancellation subscriptions, while concurrent waits share the first abort reason', async () => {
  const waits = createAbortableWait();
  assert.equal(await waits.wait(Promise.resolve(42)), 42);
  const failure = new Error('task failed');
  await assert.rejects(waits.wait(Promise.reject(failure)), error => error === failure);
  const first = deferred(),
    second = deferred(),
    reason = new Error('canceled');
  const results = Promise.allSettled([waits.wait(first.promise), waits.wait(second.promise)]);
  waits.abort(reason);
  waits.abort(new Error('cleanup failed'));
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, reason);
  }
  // Cancellation still observes late failures, including tasks supplied after abort.
  first.reject(failure);
  second.resolve(7);
  await assert.rejects(waits.wait(Promise.reject(failure)), error => error === reason);
  await new Promise(resolve => setImmediate(resolve));
});

test('a long-lived cancellation scope does not retain completed frame waits', () => {
  // Isolate GC from the test runner. A shared pending Promise.race branch
  // retains roughly 30 MiB for this workload; current waits should stay bounded.
  const moduleUrl = new URL('../../../src/shared/abortable-wait.js', import.meta.url).href;
  const output = execFileSync(process.execPath, [
    '--expose-gc',
    '--input-type=module',
    '-e',
    `import {createAbortableWait} from ${JSON.stringify(moduleUrl)};
     const waits = createAbortableWait();
     const heap = () => { global.gc(); return process.memoryUsage().heapUsed; };
     const before = heap();
     for (let i = 0; i < 100000; i++) await waits.wait(Promise.resolve(i));
     const retained = heap() - before;
     waits.abort(new Error('finished'));
     process.stdout.write(String(retained));`,
  ]);
  const retained = Number(output.toString());
  assert.ok(retained < 8 * 1024 * 1024, `completed waits retained ${retained} bytes`);
});
