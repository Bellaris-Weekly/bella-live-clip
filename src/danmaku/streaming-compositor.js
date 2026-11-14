import {mapConcurrent} from '../shared/concurrent.js';
import {createDanmakuPainter, danmakuFontSize} from './compositor.js';
import {loadEmoteCatalog, loadEmotes, referencedEmotes} from './emotes.js';
import {visibleComment} from './layout.js';
import {avatarSize, commentPreroll} from './super-chat.js';
import {createAvatarCache} from './avatars.js';

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
    metrics,
    preparedEmoteCatalog,
    emoteCache,
  },
) {
  const assets = new Map(),
    budget = {used: 0, compressed: 0};
  let catalog = preparedEmoteCatalog?.promise,
    painter,
    next,
    until = sourceTime(start) + WINDOW_SECONDS,
    order = 0,
    pinned = new Set(),
    supplying = Promise.resolve(),
    prefetching = Promise.resolve(),
    foregroundPrepared = !emoteCache;
  const deferredNames = new Set();
  const parentSignal = signal,
    controller = new AbortController();
  signal = controller.signal;
  const avatars = createAvatarCache({signal, fetcher, metrics, size: avatarSize(danmakuFontSize(height))});
  const closeAssets = () => {
    avatars.close();
    for (const asset of assets.values()) asset.close();
    assets.clear();
  };
  const abort = () => {
    controller.abort(parentSignal?.reason);
    closeAssets();
  };
  parentSignal?.addEventListener('abort', abort, {once: true});
  if (parentSignal?.aborted) abort();
  const read = async (from, to, prefetch = false) => {
    const events = await reader.read({origin, start: from, end: to, adjustment, prefetch});
    if (events === null) return null;
    metrics?.add('archiveWindows');
    metrics?.add('commentsRead', events.length);
    return events;
  };
  const fetchCatalog = () => {
    const finish = metrics?.start('emoteCatalog');
    return (emoteCache ? emoteCache.catalog(signal) : loadEmoteCatalog(record.room, {signal, fetcher})).finally(() =>
      finish?.(),
    );
  };
  const getCatalog = async (speculative = false) => {
    catalog ??= fetchCatalog();
    if (speculative) return catalog;
    try {
      return await catalog;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      // Keep speculative rejection until demand, then retry once and cache the
      // text-only result if the directory remains unavailable.
      catalog = fetchCatalog().catch(retryError => {
        signal?.throwIfAborted();
        if (retryError?.name === 'AbortError') throw retryError;
        metrics?.add('emoteFailures');
        return new Map();
      });
      return catalog;
    }
  };
  const prefetch = () => {
    const end = endTime();
    if (until >= end) {
      next = null;
      return;
    }
    const to = Math.min(until + WINDOW_SECONDS, end);
    next = {from: until, to, promise: read(until, to, true)};
    // Speculation is not a required stage yet. Observe its rejection now, but
    // only retry/report it if playback actually reaches this window.
    void next.promise
      .then(events => {
        if (events === null) return;
        signal?.throwIfAborted();
        return supply(
          events.filter(event => event.time < endTime()),
          true,
        );
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
  function supply(events, speculative = false) {
    const task = supplying.then(() => supplyWindow(events, speculative));
    supplying = task.catch(() => {});
    return task;
  }
  function prefetchAssets(names) {
    const pending = [...names].map(name => assets.get(name)).filter(Boolean);
    prefetching = prefetching.then(() => mapConcurrent(pending, 3, asset => asset.prefetch(), signal)).catch(() => {});
  }
  async function supplyWindow(events, speculative) {
    signal?.throwIfAborted();
    const retained = painter
      ? [...painter.layout.active, ...painter.layout.waiting, ...painter.layout.events.slice(painter.layout.cursor)]
      : [];
    avatars.prefetch(events, retained.concat(events));
    const names = referencedEmotes(retained.concat(events).filter(visibleComment));
    // Speculation may evict idle entries, but cannot pin future bytes ahead of
    // current playback and make a required decoder fail its budget.
    pinned = speculative ? referencedEmotes(retained.filter(visibleComment)) : names;
    for (const name of names)
      if (assets.has(name)) {
        const asset = assets.get(name);
        assets.delete(name);
        assets.set(name, asset);
      }
    const missing = [...names].filter(name => !assets.has(name));
    if (missing.length) {
      const selected = await getCatalog(speculative);
      const added = missing.filter(name => selected.has(name)).length;
      evictUntil(() => assets.size + added <= 128);
      if (assets.size + added > 128) throw new Error('弹幕窗口表情种类超过缓存上限。');
      const loaded = await loadEmotes(
        missing.map(text => ({text})),
        record.room,
        danmakuFontSize(height),
        {
          signal,
          fetcher,
          selected,
          lazy: true,
          budget,
          metrics,
          readEmote: emoteCache?.read,
          discardEmote: emoteCache?.discard,
        },
      );
      for (const [name, asset] of loaded.assets) assets.set(name, asset);
      loaded.assets.clear(); // Ownership moves into this windowed store.
    }
    // Fetch compressed input now; decoder creation and frame retention stay on demand.
    if (foregroundPrepared) prefetchAssets(names);
    else if (speculative) for (const name of referencedEmotes(events.filter(visibleComment))) deferredNames.add(name);
  }
  try {
    until = Math.min(until, endTime());
    void getCatalog(true).catch(() => {});
    const finishInitial = metrics?.start('commentWindowInitial');
    let loaded;
    try {
      loaded = await read(sourceTime(start) - commentPreroll(width, height), until);
    } finally {
      finishInitial?.();
    }
    until = Math.min(until, endTime());
    const initial = loaded.filter(event => event.time < until);
    await supply(initial);
    for (const event of initial) event.order = order++;
    painter = createDanmakuPainter(
      initial,
      {assets, avatars, close: closeAssets},
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
          } catch {
            signal?.throwIfAborted();
            // A transient prefetch failure or an over-wide speculative query
            // gets one demand read with the now-confirmed end boundary.
            loaded = null;
          }
          if (loaded === null) loaded = await read(pending.from, to);
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
        metrics?.gauge('droppedSuperChats', painter.layout.droppedSuperChats);
        // Multiple appearances of one asset share its decoder and clock table.
        const needed = new Map();
        for (const item of active)
          for (const part of item.parts)
            if (part.asset && part.asset.needsPreparation(time - item.started))
              needed.set(part.asset, Math.max(needed.get(part.asset) ?? 0, time - item.started));
        const finishStall = needed.size ? metrics?.start('emoteStall') : null;
        try {
          if (needed.size)
            await mapConcurrent(
              [...needed],
              3,
              ([asset, elapsed], _, taskSignal) => asset.prepare(elapsed, taskSignal),
              signal,
            );
        } finally {
          finishStall?.();
        }
        if (!foregroundPrepared) {
          // A preview's first visible emotes take all three download slots.
          // Expired preroll and future-window images must not queue ahead of
          // them. Export retains its existing eager prefetch behavior.
          foregroundPrepared = true;
          const remaining = [
            ...active,
            ...painter.layout.waiting,
            ...painter.layout.events.slice(painter.layout.cursor),
          ];
          prefetchAssets(new Set([...referencedEmotes(remaining.filter(visibleComment)), ...deferredNames]));
          deferredNames.clear();
        }
      },
      renderOverlay(timestamp) {
        return painter.renderOverlay(timestamp);
      },
      get overlayOpacity() {
        return painter.overlayOpacity;
      },
      get superChatOverlay() {
        return painter.superChatOverlay;
      },
      get overlayRevision() {
        return painter.overlayRevision;
      },
      // During a network/decode wait, keep already placed comments moving at
      // the current media time without advancing the deterministic layout.
      renderAvailableOverlay(timestamp) {
        return painter.renderOverlay(timestamp, false);
      },
      render(sample, timestamp) {
        metrics?.gauge('emoteDecodedBytes', budget.used);
        metrics?.gauge('emoteCompressedBytes', budget.compressed);
        return painter.render(sample, timestamp);
      },
      async close() {
        parentSignal?.removeEventListener('abort', abort);
        controller.abort();
        preparedEmoteCatalog?.controller.abort();
        closeAssets();
        await next?.promise.catch(() => {});
        await catalog?.catch(() => {});
        await supplying;
        await prefetching;
        painter.close();
        await reader.close();
      },
    };
  } catch (error) {
    parentSignal?.removeEventListener('abort', abort);
    controller.abort();
    preparedEmoteCatalog?.controller.abort();
    await supplying;
    await prefetching;
    if (painter) painter.close();
    else closeAssets();
    throw error;
  }
}
