// OPFS holds only this export's normalized media, never URLs or credentials.
// File snapshots are read lazily by BlobSource; do not call arrayBuffer() on them.
export async function createTemporaryMedia({ storage = globalThis.navigator?.storage, signal } = {}) {
  signal?.throwIfAborted();
  if (!storage?.getDirectory) throw new Error('当前浏览器不支持临时文件存储，请使用 Chrome 或 Edge 导出直播片段。');
  const root = await storage.getDirectory();
  signal?.throwIfAborted();
  const name = `bella-clip-${crypto.randomUUID()}.mp4`;
  const handle = await root.getFileHandle(name, { create: true });
  return { handle, async remove() { await root.removeEntry(name); } };
}

export function mediaStorageError(error) {
  if (error.name === 'QuotaExceededError') {
    return new Error('存储空间不足，无法完成导出。请检查浏览器临时存储配额及保存位置的可用空间，或缩短选区后重试。', { cause: error });
  }
  return error;
}
