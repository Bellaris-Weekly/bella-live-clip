import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTemporaryMedia, ensureTemporarySpace, removeAbandonedMedia} from '../../../src/media/temporary-media.js';

const DAY = 24 * 60 * 60 * 1000;
function directory(files) {
  const items = new Map(
    Object.entries(files).map(([name, age]) => [
      name,
      age === 'dir' ? {kind: 'directory'} : {kind: 'file', getFile: async () => ({lastModified: 1000 * DAY - age})},
    ]),
  );
  return {
    removed: [],
    async *entries() {
      yield* [...items];
    },
    async removeEntry(name) {
      this.removed.push(name);
      items.delete(name);
    },
    async getFileHandle(name) {
      const handle = {name, kind: 'file'};
      items.set(name, handle);
      return handle;
    },
  };
}

test('abandoned temporary files are removed, recent ones and unrelated entries stay', async () => {
  const root = directory({
    'bella-clip-old.mp4': 2 * DAY,
    'bella-clip-new.mp4': DAY / 2,
    'bella-clip-dir': 'dir',
    'other.mp4': 9 * DAY,
  });
  await removeAbandonedMedia(root, 1000 * DAY);
  assert.deepEqual(root.removed, ['bella-clip-old.mp4']);
});

test('a locked file or unreadable directory never stops an export', async () => {
  const root = directory({'bella-clip-old.mp4': 2 * DAY});
  root.removeEntry = async () => {
    throw new Error('locked');
  };
  await removeAbandonedMedia(root, 1000 * DAY);
  await removeAbandonedMedia(
    {
      entries() {
        throw new Error('denied');
      },
    },
    1000 * DAY,
  );
});

test('creating temporary media also cleans up and keeps its own file removable', async () => {
  const root = directory({});
  const media = await createTemporaryMedia({storage: {getDirectory: async () => root}});
  assert.match(media.handle.name, /^bella-clip-.+\.mp4$/);
  await media.remove();
  assert.deepEqual(root.removed, [media.handle.name]);
});

test('an export that clearly will not fit stops before downloading', async () => {
  const storage = {estimate: async () => ({quota: 1000, usage: 400})};
  await ensureTemporarySpace(storage, 500);
  await assert.rejects(ensureTemporarySpace(storage, 600), /临时空间不足/);
});

test('unknown sizes and unavailable estimates are not treated as a lack of space', async () => {
  await ensureTemporarySpace({estimate: async () => ({quota: 1, usage: 1})}, 0);
  await ensureTemporarySpace({}, 1e12);
  await ensureTemporarySpace(undefined, 1e12);
  await ensureTemporarySpace(
    {
      estimate: async () => {
        throw new Error('denied');
      },
    },
    1e12,
  );
});
