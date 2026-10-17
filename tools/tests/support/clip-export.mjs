import { exportSelection as saveSelection } from '../../../src/media/export.js';
import { memoryFile } from './memory-file.mjs';

// Small-fixture adapter: production always receives real disk destinations.
export async function exportSelection(api, record, groups, selection, options = {}) {
  const files = [];
  const outputs = await saveSelection(api, record, groups, selection, {
    createTemporary: async () => ({ handle: memoryFile(), async remove() {} }),
    createFile: async () => {
      const handle = memoryFile(); files.push(handle);
      return { handle, name: handle.name, async remove() {} };
    },
    ...options,
  });
  return Promise.all(outputs.map(async (output, i) => ({ ...output, blob: await files[i].getFile() })));
}
