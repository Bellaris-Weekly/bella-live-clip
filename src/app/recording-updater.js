const LIVE_INTERVAL = 30000;
// The platform's editor treats signed playback addresses as valid for 30 minutes.
const REPLAY_INTERVAL = 20 * 60 * 1000;

// One non-overlapping poll belongs to the selected session. Never look up the
// room again: a reconnect/new broadcast must not replace the selected key.
export function createRecordingUpdater({api, onUpdate, canRefresh = () => true, liveInterval = LIVE_INTERVAL, replayInterval = REPLAY_INTERVAL, now = () => Date.now()}) {
  let generation = 0, timer, controller, fetchedAt = 0;
  const read = (record, signal) => api.clips(record, 0,
    record.live ? Math.max(0, Math.floor(now() / 1000) - record.start) : record.end - record.start, signal);
  function stop() {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
  }
  function start(record, {fresh = false} = {}) {
    stop();
    if (!record) return;
    if (fresh) fetchedAt = now();
    const token = generation;
    const schedule = () => {
      if (token === generation) timer = setTimeout(poll, record.live ? liveInterval : replayInterval);
    };
    async function poll() {
      if (token !== generation) return;
      if (!canRefresh()) { schedule(); return; }
      const own = new AbortController();
      controller = own;
      try {
        const streams = await read(record, own.signal);
        if (token === generation && !own.signal.aborted && canRefresh()) { fetchedAt = now(); onUpdate(streams); }
      } catch {
        // A transient API failure leaves the usable recording intact; retry later.
      } finally {
        if (controller === own) controller = null;
        schedule();
      }
    }
    schedule();
  }
  async function refresh(record, signal) {
    const streams = await read(record, signal);
    signal?.throwIfAborted();
    fetchedAt = now();
    onUpdate(streams);
  }
  // Exports read addresses for a long time, so begin with fresh ones. The old
  // addresses may still work if this fails, so that is not a reason to stop.
  async function ensureFresh(record, signal) {
    if (now() - fetchedAt < replayInterval) return;
    try { await refresh(record, signal); }
    catch (error) { signal?.throwIfAborted(); if (error.name === 'AbortError') throw error; }
  }
  return {start, stop, refresh, ensureFresh};
}
