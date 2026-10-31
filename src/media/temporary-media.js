import { formatBytes } from '../shared/format.js';

const PREFIX = 'bella-clip-';
// Long enough that a running export in another tab is never touched.
const ABANDONED_AFTER = 24 * 60 * 60 * 1000;
const SPACE_MARGIN = 1.1;

// A crash or closed tab leaves its temporary file behind, invisible to the user.
export async function removeAbandonedMedia(root, now = Date.now()) {
  try {
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file' || !name.startsWith(PREFIX)) continue;
      try {
        if (now - (await handle.getFile()).lastModified > ABANDONED_AFTER) await root.removeEntry(name);
      } catch { /* A file still in use stays until a later export. */ }
    }
  } catch { /* Cleaning up must never stop an export. */ }
}

// Fail before downloading anything rather than at 90% of a long export.
export async function ensureTemporarySpace(storage, bytes) {
  let estimate;
  try { estimate = await storage?.estimate?.(); } catch { return; }
  if (!bytes || !estimate?.quota) return;
  const available = estimate.quota - (estimate.usage ?? 0);
  if (available < bytes * SPACE_MARGIN) {
    throw new Error(`浏览器临时空间不足：需要约 ${formatBytes(bytes)}，可用 ${formatBytes(available)}。请缩短选区或清理磁盘。`);
  }
}

// OPFS holds only this export's normalized media, never URLs or credentials.
// File snapshots are read lazily by BlobSource; do not call arrayBuffer() on them.
export async function createTemporaryMedia({ storage = globalThis.navigator?.storage, signal } = {}) {
  signal?.throwIfAborted();
  if (!storage?.getDirectory) throw new Error('当前浏览器不支持保存文件，请使用 Chrome 或 Edge。');
  const root = await storage.getDirectory();
  signal?.throwIfAborted();
  await removeAbandonedMedia(root);
  signal?.throwIfAborted();
  const name = `${PREFIX}${crypto.randomUUID()}.mp4`;
  const handle = await root.getFileHandle(name, { create: true });
  return { handle, async remove() { await root.removeEntry(name); } };
}

export function mediaStorageError(error) {
  if (error.name === 'QuotaExceededError') {
    return new Error('存储空间不足，请清理磁盘或缩短选区。', { cause: error });
  }
  return error;
}
