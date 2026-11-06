import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSpriteCache} from '../../../src/danmaku/sprite-cache.js';
import {performanceLog} from '../../../src/shared/performance-log.js';
import {createExportMetrics} from '../../../src/media/export-metrics.js';

test('sprites reuse each item part, evict oldest bytes and release expired owners and clear', () => {
  const metrics = createExportMetrics(),
    cache = createSpriteCache({maxBytes: 32, metrics});
  const images = [],
    owners = [{}, {}, {}],
    part = {};
  const create = () => {
    const image = {
      close() {
        this.closed = true;
      },
    };
    images.push(image);
    return {image, bytes: 16};
  };
  const first = cache.get(owners[0], part, create);
  assert.equal(cache.get(owners[0], part, create), first);
  cache.get(owners[1], part, create);
  cache.get(owners[0], part, create);
  cache.get(owners[2], part, create);
  assert.equal(images[0].closed, undefined);
  assert.ok(images[1].closed, 'least recently used owner evicted');
  cache.retain([owners[2]]);
  assert.ok(images[0].closed, 'departed comment released');
  cache.clear();
  cache.clear();
  assert.ok(images.every(image => image.closed));
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.gauges.spriteBytes, {current: 0, peak: 32});
  assert.equal(snapshot.counters.spriteRasters, 3);
  assert.equal(snapshot.counters.spriteHits, 2);
  const logged = performanceLog(snapshot);
  assert.deepEqual(logged.counters, snapshot.counters);
  assert.deepEqual(logged.gauges, snapshot.gauges);
});

test('remeasurement releases all parts of only that owner and permits fresh sprites', () => {
  const metrics = createExportMetrics();
  const cache = createSpriteCache({maxBytes: 64, metrics});
  const owner = {},
    other = {},
    first = {},
    second = {};
  let closed = 0;
  const create = limit => {
    assert.equal(limit, 64);
    return {image: {close: () => closed++}, bytes: 16};
  };
  cache.get(owner, first, create);
  cache.get(owner, second, create);
  const retained = cache.get(other, first, create);
  cache.delete(owner);
  cache.delete(owner);
  assert.equal(closed, 2);
  assert.equal(metrics.snapshot().gauges.spriteBytes.current, 16);
  assert.equal(cache.get(other, first, create), retained);
  cache.get(owner, first, create);
  assert.equal(metrics.snapshot().counters.spriteRasters, 4);
  cache.clear();
  assert.equal(closed, 4);
});

test('eviction removes the lookup and an oversized raster can fall back without evicting sprites', () => {
  const cache = createSpriteCache({maxBytes: 16});
  const owner = {},
    first = {},
    second = {};
  let closed = 0;
  const create = () => ({image: {close: () => closed++}, bytes: 16});
  const original = cache.get(owner, first, create);
  assert.equal(
    cache.get(owner, second, () => null),
    null,
  );
  assert.equal(cache.get(owner, first, create), original);
  cache.get(owner, second, create);
  assert.equal(closed, 1);
  assert.notEqual(cache.get(owner, first, create), original);
  assert.equal(closed, 2);
  cache.clear();
  assert.equal(closed, 3);
});
