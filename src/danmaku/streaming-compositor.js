import {mapConcurrent} from '../shared/concurrent.js';
import {createDanmakuPainter, danmakuFontSize} from './compositor.js';
import {loadEmoteCatalog, loadEmotes, referencedEmotes} from './emotes.js';
import {visibleComment} from './layout.js';
import {PREROLL} from './clock.js';

const WINDOW_SECONDS = 10;

export async function createStreamingCompositor(
  record,
  {reader, origin, start, sourceTime, width, height, adjustment, signal, fetcher, endTime = () => Infinity, metrics},
) {
  const assets = new Map(),
    budget = {used: 0, compressed: 0};
  let catalog,
    painter,
    next,
    until = sourceTime(start) + WINDOW_SECONDS,
    order = 0,
    pinned = new Set();
  const closeAssets = () => {
    for (const asset of assets.values()) asset.close();
    assets.clear();
  };
  const read = async (from, to) => {
    const events = await reader.read({origin, start: from, end: to, adjustment});
    metrics?.add('archiveWindows');
    metrics?.add('commentsRead', events.length);
    return events;
  };
  const getCatalog = () => {
    if (!catalog) {
      const finish = metrics?.start('emoteCatalog');
      catalog = loadEmoteCatalog(record.room, {signal, fetcher})
        .catch(error => {
          catalog = null;
          throw error;
        })
        .finally(() => finish?.());
    }
    return catalog;
  };
  const prefetch = () => {
    const end = endTime();
    if (until >= end) {
      next = null;
      return;
    }
    const to = Math.min(until + WINDOW_SECONDS, end);
    next = {from: until, to, promise: read(until, to)};
    // Speculation is not a required stage yet. Observe its rejection now, but
    // only retry/report it if playback actually reaches this window.
    void next.promise
      .then(events => {
        signal?.throwIfAborted();
        // Only metadata is speculative. Images still wait for actual layout
        // admission, so filtered/queued/dropped comments never fetch pictures.
        if (referencedEmotes(events.filter(event => event.time < endTime() && visibleComment(event))).size)
          return getCatalog();
      })
      .catch(() => {});
  };
  // Assets referenced by current layout/window state are pinned. Idle assets
  // remain reusable until an entry or byte budget actually needs their space.
  function evictUntil(fits) {
    let evicted = false;
    for (const [name, asset] of assets) {
      if (fits()) break;
      if (pinned.has(name)) continue;
      asset.close();
      assets.delete(name);
      evicted = true;
    }
    if (evicted) painter?.clearMeasurements();
  }
  budget.makeRoom = (kind, bytes) => {
    const limit = (kind === 'used' ? 32 : 16) * 1024 * 1024;
    evictUntil(() => budget[kind] + bytes <= limit);
  };
  async function supply(events) {
    signal?.throwIfAborted();
    const retained = painter
      ? [...painter.layout.active, ...painter.layout.waiting, ...painter.layout.events.slice(painter.layout.cursor)]
      : [];
    const names = referencedEmotes(retained.concat(events).filter(visibleComment));
    pinned = names;
    for (const name of names)
      if (assets.has(name)) {
        const asset = assets.get(name);
        assets.delete(name);
        assets.set(name, asset);
      }
    const missing = [...names].filter(name => !assets.has(name));
    if (missing.length) {
      const selected = await getCatalog();
      const added = missing.filter(name => selected.has(name)).length;
      evictUntil(() => assets.size + added <= 128);
      if (assets.size + added > 128) throw new Error('弹幕窗口表情种类超过缓存上限。');
      const loaded = await loadEmotes(
        missing.map(text => ({text})),
        record.room,
        danmakuFontSize(height),
        {signal, fetcher, selected, lazy: true, budget, metrics},
      );
      for (const [name, asset] of loaded.assets) assets.set(name, asset);
      loaded.assets.clear(); // Ownership moves into this windowed store.
    }
  }
  try {
    until = Math.min(until, endTime());
    const loaded = await read(sourceTime(start) - PREROLL, until);
    until = Math.min(until, endTime());
    const initial = loaded.filter(event => event.time < until);
    await supply(initial);
    for (const event of initial) event.order = order++;
    painter = createDanmakuPainter(
      initial,
      {assets, close: closeAssets},
      {start, sourceTime, width, height, signal, metrics},
    );
    prefetch();
    return {
      async prepare(timestamp) {
        signal?.throwIfAborted();
        const time = sourceTime(timestamp);
        while (time >= until && next) {
          // Finish the old window on its original grid, retaining pending/active
          // comments. Nothing is re-prerolled at a window boundary.
          painter.layout.advance(Math.max((painter.layout.tick - 1) / 60, until - 1e-7));
          const pending = next;
          const to = Math.min(pending.to, endTime());
          let loaded;
          try {
            loaded = await pending.promise;
          } catch (error) {
            signal?.throwIfAborted();
            // A transient prefetch failure or an over-wide speculative query
            // gets one demand read with the now-confirmed end boundary.
            loaded = await read(pending.from, to);
          }
          const events = loaded.filter(event => event.time < to);
          await supply(events);
          for (const event of events) event.order = order++;
          painter.layout.append(events);
          until = to;
          prefetch();
        }
        const finishLayout = metrics?.start('layout');
        let active;
        try {
          active = painter.layout.advance(time);
        } finally {
          finishLayout?.();
        }
        metrics?.gauge('activeComments', active.length);
        metrics?.gauge('waitingComments', painter.layout.waiting.length);
        // Multiple appearances of one asset share its decoder and clock table.
        const needed = new Map();
        for (const item of active)
          for (const part of item.parts)
            if (part.asset && (part.asset.needsPreparation?.(time - item.started) ?? true))
              needed.set(part.asset, Math.max(needed.get(part.asset) ?? 0, time - item.started));
        if (needed.size)
          await mapConcurrent(
            [...needed],
            3,
            ([asset, elapsed], _, taskSignal) => asset.prepare(elapsed, taskSignal),
            signal,
          );
      },
      render(sample, timestamp) {
        metrics?.gauge('emoteDecodedBytes', budget.used);
        metrics?.gauge('emoteCompressedBytes', budget.compressed);
        return painter.render(sample, timestamp);
      },
      async close() {
        await next?.promise.catch(() => {});
        await catalog?.catch(() => {});
        painter.close();
        await reader.close();
      },
    };
  } catch (error) {
    if (painter) painter.close();
    else closeAssets();
    throw error;
  }
}
