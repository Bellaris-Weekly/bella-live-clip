import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncodedPacket, EncodedVideoPacketSource, StreamTarget } from 'mediabunny';
import { createMediaOutput, createClipFile } from '../../../src/media/file-output.js';
import { createTemporaryMedia } from '../../../src/media/temporary-media.js';
import { memoryFile } from '../support/memory-file.mjs';
import { config, frame } from '../support/synthetic-frame.mjs';

const decoderConfig = { ...config, description: new Uint8Array(Buffer.from(config.description, 'base64')) };
const picture = new Uint8Array(Buffer.from(frame, 'base64'));
async function addFrame(session, data = picture, timestamp = 0) {
  const source = new EncodedVideoPacketSource('avc');
  session.output.addVideoTrack(source); await session.output.start();
  await source.add(new EncodedPacket(data, 'key', timestamp, 1), { decoderConfig });
  source.close();
}

test('输出超过 4 GiB 仍分块写入，封装索引使用大文件偏移且不创建整文件缓冲区', async () => {
  let maximum = 0, writes = 0, closed = false, highPosition = 0, co64 = false;
  const fileHandle = { async createWritable() { return {
    async write({ position, data }) { maximum = Math.max(maximum, data.byteLength); highPosition = Math.max(highPosition, position); writes++;
      if (position > 2 ** 32) co64 ||= Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(Buffer.from('co64')); },
    async close() { closed = true; }, async abort() { assert.fail('must complete'); },
  }; } };
  const session = await createMediaOutput({ fileHandle });
  assert.ok(session.output.target instanceof StreamTarget);
  const source = new EncodedVideoPacketSource('avc'); session.output.addVideoTrack(source); await session.output.start();
  // Opaque encoded payload stresses real muxing and the actual file writer;
  // playable AV is covered by the small real-frame integration fixtures.
  const payload = new Uint8Array(1024 * 1024); payload.set(picture);
  for (let i = 0; i < 4100; i++) await source.add(new EncodedPacket(payload, 'key', i, 1), { decoderConfig });
  source.close(); const result = await session.finish(); await session.cancel();
  assert.ok(result.bytes > 2 ** 32); assert.ok(highPosition > 2 ** 32);
  assert.ok(co64, 'MP4 sample index must use 64-bit offsets');
  assert.ok(maximum <= 1024 * 1024); assert.ok(writes > 4096); assert.ok(closed);
});

for (const failure of ['write', 'close']) test(`${failure} 失败保留原始错误并中止文件事务`, async () => {
  const error = new Error(`disk ${failure}`); let aborted = 0;
  const session = await createMediaOutput({ fileHandle: { async createWritable() { return {
    async write() { if (failure === 'write') throw error; },
    async close() { if (failure === 'close') throw error; },
    async abort() { aborted++; },
  }; } } });
  await assert.rejects((async () => { try { await addFrame(session); await session.finish(); } finally { await session.cancel(); } })(), value => value === error);
  assert.equal(aborted, 1);
});

test('写盘前取消不提交文件，再次创建事务可重新导出', async () => {
  const handle = memoryFile(), controller = new AbortController(), error = new Error('cancel');
  const first = await createMediaOutput({ fileHandle: handle, signal: controller.signal });
  await addFrame(first); controller.abort(error);
  await assert.rejects(first.finish(), value => value === error); await first.cancel();
  assert.equal(handle.stats.closed, 0); assert.equal(handle.stats.aborted, 1);
  const second = await createMediaOutput({ fileHandle: handle }); await addFrame(second);
  assert.ok((await second.finish()).bytes > 0); await second.cancel();
  assert.equal(handle.stats.closed, 1);
});

test('文件夹保存避开重名文件，权限失败不伪装成文件不存在', async () => {
  const existing = new Set(['片段.mp4', '片段 (1).mp4']), removed = [];
  const directory = {
    async getFileHandle(name, options) {
      if (!existing.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError');
      existing.add(name); return { name };
    },
    async removeEntry(name) { removed.push(name); existing.delete(name); },
  };
  const result = await createClipFile(directory, '片段.mp4');
  assert.equal(result.name, '片段 (2).mp4'); await result.remove();
  assert.deepEqual([...existing], ['片段.mp4', '片段 (1).mp4']); assert.deepEqual(removed, ['片段 (2).mp4']);
  const error = new DOMException('denied', 'NotAllowedError');
  await assert.rejects(createClipFile({ async getFileHandle() { throw error; } }, 'x.mp4'), value => value === error);
});

test('临时文件使用独立名称并只清理自己，浏览器不支持时明确失败', async () => {
  const created = [], removed = [];
  const root = {
    async getFileHandle(name, options) { assert.equal(options.create, true); created.push(name); return memoryFile(name); },
    async removeEntry(name) { removed.push(name); },
  };
  const storage = { async getDirectory() { assert.equal(this, storage); return root; } };
  const first = await createTemporaryMedia({ storage }), second = await createTemporaryMedia({ storage });
  assert.notEqual(first.handle.name, second.handle.name); await first.remove(); await second.remove();
  assert.deepEqual(removed, created);
  await assert.rejects(createTemporaryMedia({ storage: {} }), /不支持临时文件/);
});
