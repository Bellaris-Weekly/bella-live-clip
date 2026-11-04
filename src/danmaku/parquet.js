import {parquetMetadataAsync, parquetReadObjects} from 'hyparquet';
import {decompress} from 'fzstd';
import {receivedTime} from './clock.js';

const MAX_EVENTS = 100000;

export async function readMetadata(file) {
  return parquetMetadataAsync(file);
}

export async function readDanmaku(file, {from = -Infinity, to = Infinity, signal, metadata, readGroup} = {}) {
  metadata ??= await readMetadata(file);
  const meta = Object.fromEntries((metadata.key_value_metadata ?? []).map(item => [item.key, item.value]));
  if (meta.live_archive_version !== '1' || !meta.sections) throw new Error('弹幕归档格式不支持。');
  const selected = JSON.parse(meta.sections).danmaku ?? [];
  if (!Array.isArray(selected) || selected.some(i => !Number.isInteger(i) || i < 0 || i >= metadata.row_groups.length))
    throw new Error('弹幕归档分区索引无效。');
  const groups = new Set(selected);
  const rows = [];
  let rowStart = 0,
    retainedBytes = 0;
  for (const [i, group] of metadata.row_groups.entries()) {
    signal?.throwIfAborted();
    const count = Number(group.num_rows),
      rowEnd = rowStart + count;
    const stats = group.columns.find(column => column.meta_data?.path_in_schema?.[0] === 't')?.meta_data?.statistics;
    // Null t uses sent+1s, so statistics can prune only all-nonnull groups.
    const outside =
      stats?.null_count === 0n &&
      (Number(stats.max_value ?? stats.max) / 1000 < from || Number(stats.min_value ?? stats.min) / 1000 > to);
    if (groups.has(i) && !outside) {
      if (Number(group.total_byte_size) > 16 * 1024 * 1024 || count > 10000) throw new Error('弹幕分区超过内存预算。');
      // Read one section group at a time. Other sections never reach the decoder.
      const load = () =>
        parquetReadObjects({
          file,
          metadata,
          rowStart,
          rowEnd,
          columns: ['sec', 't', 'sent', 'text', 'mode', 'color'],
          compressors: {ZSTD: (input, output) => decompress(input, new Uint8Array(output))},
        });
      const values = await (readGroup ? readGroup(i, Number(group.total_byte_size), load) : load());
      for (const row of values) {
        if (row.sec !== 'danmaku') throw new Error('弹幕归档分区不一致。');
        const time = receivedTime(row);
        if (time >= from && time <= to) {
          retainedBytes += String(row.text).length * 2 + 128;
          if (retainedBytes > 16 * 1024 * 1024) throw new Error('弹幕文字超过内存预算，请缩短选区。');
          rows.push(row);
        }
        if (rows.length > MAX_EVENTS) throw new Error('选区内弹幕过多，请缩短选区后重试。');
      }
    }
    rowStart = rowEnd;
  }
  return rows;
}
