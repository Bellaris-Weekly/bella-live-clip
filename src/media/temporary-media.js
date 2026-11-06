import {formatBytes} from '../shared/format.js';
import {storageStep} from '../shared/errors.js';

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
      } catch {
        /* A file still in use stays until a later export. */
      }
    }
  } catch {
    /* Cleaning up must never stop an export. */
  }
}

// Fail before downloading anything rather than at 90% of a long export.
export async function ensureTemporarySpace(storage, bytes) {
  let estimate;
  try {
    estimate = await storage?.estimate?.();
  } catch {
    return;
  }
  if (!bytes || !estimate?.quota) return;
  const available = estimate.quota - (estimate.usage ?? 0);
  if (available < bytes * SPACE_MARGIN) {
    throw new Error(
      `浏览器临时空间不足：需要约 ${formatBytes(bytes)}，可用 ${formatBytes(available)}。请缩短选区或清理磁盘。`,
    );
  }
}

// OPFS holds only this export's normalized media, never URLs or credentials.
// File snapshots are read lazily by BlobSource; do not call arrayBuffer() on them.
export async function createTemporaryMedia({storage = globalThis.navigator?.storage, signal} = {}) {
  signal?.throwIfAborted();
  if (!storage?.getDirectory) throw new Error('当前浏览器不支持保存文件，请使用 Chrome 或 Edge。');
  const root = await storageStep('getDirectory', 'temporary', () => storage.getDirectory());
  signal?.throwIfAborted();
  await removeAbandonedMedia(root);
  signal?.throwIfAborted();
  const name = `${PREFIX}${crypto.randomUUID()}.mp4`;
  const handle = await storageStep('getFileHandle', 'temporary', () => root.getFileHandle(name, {create: true}));
  return {
    handle,
    async remove() {
      await storageStep('removeEntry', 'temporary', () => root.removeEntry(name));
    },
  };
}

// The browser reports these when a file changes, disappears or is locked while
// it is being written, e.g. by another program; the stored bytes cannot be trusted.
const FILE_STATE_ERRORS = new Set([
  'NotFoundError',
  'InvalidStateError',
  'NoModificationAllowedError',
  'NotReadableError',
]);

export function mediaStorageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('存储空间不足，请清理磁盘或缩短选区。', {cause: error});
  }
  const target = error?.diagnostic?.target;
  if (!FILE_STATE_ERRORS.has(error?.name) || !['temporary', 'destination'].includes(target)) return error;
  if (target === 'temporary') {
    return new Error(
      `浏览器临时文件读写失败（${error.name}），导出已停止。请关闭其他正在导出的页面，或重启浏览器后重试。`,
      {cause: error},
    );
  }
  return new Error(
    `保存的文件写入失败（${error.name}），文件可能被移动、删除或被其他程序占用。请重新选择保存位置后重试。`,
    {cause: error},
  );
}
