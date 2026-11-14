import {parquetMetadataAsync, parquetReadObjects} from 'hyparquet';
import {decompress} from 'fzstd';
import {receivedTime} from './clock.js';

const MAX_EVENTS = 100000;

export async function readMetadata(file) {
  return parquetMetadataAsync(file);
}

const values = new WeakMap();
// File key/value metadata written by the collector's write_archive.
export function archiveValues(metadata) {
  if (!values.has(metadata))
    values.set(metadata, Object.fromEntries((metadata.key_value_metadata ?? []).map(item => [item.key, item.value])));
  return values.get(metadata);
}

const milliseconds = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number / 1000 : undefined;
};

// Metadata is immutable for one snapshot. Build the section/time index once;
// missing reception timestamps stay unbounded because sent+1s is the fallback.
const indexes = new WeakMap();
function indexFor(metadata) {
  if (indexes.has(metadata)) return indexes.get(metadata);
  const meta = archiveValues(metadata);
  if (meta.live_archive_version !== '1' || !meta.sections) throw new Error('弹幕归档格式不支持。');
  const sections = new Map(),
    groups = [];
  const layout = JSON.parse(meta.sections);
  for (const section of ['danmaku', 'sc']) {
    const selected = layout[section] ?? [];
    if (
      !Array.isArray(selected) ||
      selected.some(i => !Number.isInteger(i) || i < 0 || i >= metadata.row_groups.length || sections.has(i))
    )
      throw new Error('弹幕归档分区索引无效。');
    for (const i of selected) sections.set(i, section);
  }
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
      groups.push({
        i,
        section: sections.get(i),
        rowStart,
        rowEnd,
        count,
        size: Number(group.total_byte_size),
        from,
        to,
      });
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
  // The collector states complete_through_ms: every event it received up to that
  // instant is in this file, quiet stretches included. Older snapshots lack it;
  // they fall back to observed reception times (including non-chat events), not
  // sent times or HTTP Last-Modified, and quiet intervals remain uncertain.
  const stated = milliseconds(archiveValues(metadata).complete_through_ms);
  if (stated !== undefined) return stated;
  let through = 0;
  for (const group of metadata.row_groups) {
    const stats = group.columns.find(column => column.meta_data?.path_in_schema?.[0] === 't')?.meta_data?.statistics;
    if (stats?.is_max_value_exact === false) continue;
    const time = Number(stats?.max_value ?? stats?.max);
    if (Number.isFinite(time)) through = Math.max(through, time / 1000);
  }
  return through;
}

// When the collector expects to publish the next snapshot (seconds), if it says.
export function snapshotSchedule(metadata) {
  const meta = archiveValues(metadata);
  const published = milliseconds(meta.published_ms),
    interval = milliseconds(meta.publish_interval_ms);
  return published !== undefined && interval !== undefined ? {published, interval} : null;
}

// The collector's live HLS stream clock measurement, or null when absent/invalid.
export function streamClock(metadata) {
  const value = archiveValues(metadata).stream_clock;
  if (!value) return null;
  try {
    const clock = JSON.parse(value);
    return clock?.schemaVersion === 1 && Array.isArray(clock.epochs) ? clock : null;
  } catch {
    return null;
  }
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
        columns:
          group.section === 'sc'
            ? [
                'sec',
                't',
                'text',
                'sc_id',
                'price',
                'bg_color',
                'header_color',
                'font_color',
                'face',
                'event_id',
                'order',
              ]
            : ['sec', 't', 'sent', 'uid', 'text', 'mode', 'color', 'event_id', 'order'],
        compressors: {ZSTD: (input, output) => decompress(input, new Uint8Array(output))},
      });
    const values = await (readGroup ? readGroup(group.i, group.size, load) : load());
    for (const row of values) {
      if (row.sec !== group.section) throw new Error('弹幕归档分区不一致。');
      if (
        typeof row.event_id !== 'string' ||
        !row.event_id ||
        !Number.isSafeInteger(Number(row.order)) ||
        row.order == null
      )
        throw new Error('弹幕归档缺少有效的事件标识或顺序。');
      const time = receivedTime(row);
      if (time >= from && time <= to) {
        retainedBytes += String(row.text).length * 2 + 128;
        if (retainedBytes > 16 * 1024 * 1024) throw new Error('弹幕文字超过内存预算，请缩短选区。');
        if (row.sec === 'sc') {
          if (
            !Number.isFinite(Number(row.price)) ||
            Number(row.price) <= 0 ||
            typeof row.text !== 'string' ||
            !row.text.trim()
          )
            continue;
          rows.push({...row, kind: 'sc', mode: 1, color: 0xffffff, price: Number(row.price)});
        } else rows.push({...row, uid: row.uid == null ? null : String(row.uid)});
      }
      if (rows.length > MAX_EVENTS) throw new Error('选区内弹幕过多，请缩短选区后重试。');
    }
  }
  return rows;
}
