import {mapConcurrent} from '../shared/concurrent.js';
import {createDanmakuPainter} from './compositor.js';
import {loadEmoteCatalog, loadEmotes, referencedEmotes} from './emotes.js';
import {visibleComment} from './layout.js';
import {PREROLL} from './clock.js';

const WINDOW_SECONDS = 10;

export async function createStreamingCompositor(
  record,
  {
    reader,
    origin,
    start,
    sourceTime,
    width,
    height,
    adjustment,
    signal,
    fetcher,
    endTime = () => Infinity,
    onError = () => {},
  },
) {
  const assets = new Map(),
    budget = {used: 0, compressed: 0};
  let catalog,
    painter,
    next,
    until = sourceTime(start) + WINDOW_SECONDS,
    order = 0;
  const closeAssets = () => {
    for (const asset of assets.values()) asset.close();
    assets.clear();
  };
  const read = (from, to) => reader.read({origin, start: from, end: to, adjustment});
  const prefetch = () => {
    const end = endTime();
    if (until >= end) {
      next = null;
      return;
    }
    const to = Math.min(until + WINDOW_SECONDS, end);
    next = {to, promise: read(until, to)};
    void next.promise.catch(error => {
      if (!signal?.aborted) onError(error);
    });
  };
  async function supply(events) {
    signal?.throwIfAborted();
    const retained = painter
      ? [...painter.layout.active, ...painter.layout.waiting, ...painter.layout.events.slice(painter.layout.cursor)]
      : [];
    const names = referencedEmotes(retained.concat(events).filter(visibleComment));
    let evicted = false;
    for (const [name, asset] of assets)
      if (!names.has(name)) {
        asset.close();
        assets.delete(name);
        evicted = true;
      }
    if (evicted) painter?.clearMeasurements();
    const missing = [...names].filter(name => !assets.has(name));
    if (missing.length) {
      catalog ??= loadEmoteCatalog(record.room, {signal, fetcher});
      const selected = await catalog;
      if (assets.size + missing.filter(name => selected.has(name)).length > 128)
        throw new Error('弹幕窗口表情种类超过缓存上限。');
      const loaded = await loadEmotes(
        missing.map(text => ({text})),
        record.room,
        (45 * height) / 1080,
        {signal, fetcher, selected, lazy: true, budget},
      );
      for (const [name, asset] of loaded.assets) assets.set(name, asset);
      loaded.assets.clear(); // Ownership moves into this windowed store.
    }
  }
  try {
    until = Math.min(until, endTime());
    const initial = await read(sourceTime(start) - PREROLL, until);
    await supply(initial);
    for (const event of initial) event.order = order++;
    painter = createDanmakuPainter(initial, {assets, close: closeAssets}, {start, sourceTime, width, height, signal});
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
          const events = await pending.promise;
          await supply(events);
          for (const event of events) event.order = order++;
          painter.layout.append(events);
          until = pending.to;
          prefetch();
        }
        const active = painter.layout.advance(time);
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
      render: (sample, timestamp) => painter.render(sample, timestamp),
      async close() {
        await next?.promise.catch(() => {});
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
