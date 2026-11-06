import {parquetMetadataAsync, parquetReadObjects} from 'hyparquet';
import {decompress} from 'fzstd';
import {receivedTime} from './clock.js';

const MAX_EVENTS = 100000;

export async function readMetadata(file) {
  return parquetMetadataAsync(file);
}

// Metadata is immutable for one snapshot. Build the section/time index once;
// missing reception timestamps stay unbounded because sent+1s is the fallback.
const indexes = new WeakMap();
function indexFor(metadata) {
  if (indexes.has(metadata)) return indexes.get(metadata);
  const meta = Object.fromEntries((metadata.key_value_metadata ?? []).map(item => [item.key, item.value]));
  if (meta.live_archive_version !== '1' || !meta.sections) throw new Error('弹幕归档格式不支持。');
  const selected = JSON.parse(meta.sections).danmaku ?? [];
  if (!Array.isArray(selected) || selected.some(i => !Number.isInteger(i) || i < 0 || i >= metadata.row_groups.length))
    throw new Error('弹幕归档分区索引无效。');
  const sections = new Set(selected),
    groups = [];
  let rowStart = 0;
  for (const [i, group] of metadata.row_groups.entries()) {
    const count = Number(group.num_rows),
      rowEnd = rowStart + count;
    if (sections.has(i)) {
      const stats = group.columns.find(column => column.meta_data?.path_in_schema?.[0] === 't')?.meta_data?.statistics;
      let from = -Infinity,
        to = Infinity;
      if (stats?.null_count === 0n) {
        const min = Number(stats.min_value ?? stats.min) / 1000;
        const max = Number(stats.max_value ?? stats.max) / 1000;
        if (Number.isFinite(min) && Number.isFinite(max)) {
          from = min;
          to = max;
        }
      }
      groups.push({i, rowStart, rowEnd, count, size: Number(group.total_byte_size), from, to});
    }
    rowStart = rowEnd;
  }
  const index = {groups, from: Infinity, to: -Infinity};
  for (const group of groups) {
    index.from = Math.min(index.from, group.from);
    index.to = Math.max(index.to, group.to);
  }
  indexes.set(metadata, index);
  return index;
}

export function danmakuBounds(metadata) {
  const {from, to} = indexFor(metadata);
  return {from, to};
}

export function snapshotCoverage(metadata) {
  // The collector's live index/Parquet contract has no coverage timestamp.
  // Use observed reception times (including non-chat events), not sent times or
  // HTTP Last-Modified: uploading a stale collector buffer does not advance it.
  // Quiet/missing-statistics intervals remain uncertain and use the bounded wait.
  let through = 0;
  for (const group of metadata.row_groups) {
    const stats = group.columns.find(column => column.meta_data?.path_in_schema?.[0] === 't')?.meta_data?.statistics;
    if (stats?.is_max_value_exact === false) continue;
    const time = Number(stats?.max_value ?? stats?.max);
    if (Number.isFinite(time)) through = Math.max(through, time / 1000);
  }
  return through;
}

export async function readDanmaku(file, {from = -Infinity, to = Infinity, signal, metadata, readGroup} = {}) {
  metadata ??= await readMetadata(file);
  const rows = [];
  let retainedBytes = 0;
  for (const group of indexFor(metadata).groups) {
    signal?.throwIfAborted();
    if (group.to < from || group.from > to) continue;
    if (group.size > 16 * 1024 * 1024 || group.count > 10000) throw new Error('弹幕分区超过内存预算。');
    const load = () =>
      parquetReadObjects({
        file,
        metadata,
        rowStart: group.rowStart,
        rowEnd: group.rowEnd,
        columns: ['sec', 't', 'sent', 'text', 'mode', 'color'],
        compressors: {ZSTD: (input, output) => decompress(input, new Uint8Array(output))},
      });
    const values = await (readGroup ? readGroup(group.i, group.size, load) : load());
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
  return rows;
}
