// Small-fixture File System Access double. Writes are transactional, just like
// createWritable: closing commits, aborting retains the previous file.
export function memoryFile(name = 'test.mp4') {
  let committed = new Uint8Array();
  const stats = { opened: 0, closed: 0, aborted: 0, writes: 0, largestWrite: 0 };
  return {
    name, stats,
    async getFile() { return new Blob([committed], { type: 'video/mp4' }); },
    async createWritable() {
      stats.opened++;
      let bytes = new Uint8Array(), ended = false;
      return {
        async write({ position, data }) {
          if (ended) throw new Error('Write after transaction ended');
          const size = position + data.byteLength;
          if (size > bytes.length) { const next = new Uint8Array(size); next.set(bytes); bytes = next; }
          bytes.set(data, position); stats.writes++; stats.largestWrite = Math.max(stats.largestWrite, data.byteLength);
        },
        async close() { ended = true; committed = bytes; bytes = null; stats.closed++; },
        async abort() { ended = true; bytes = null; stats.aborted++; },
      };
    },
  };
}
