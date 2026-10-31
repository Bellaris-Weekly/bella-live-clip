const LIVE_INTERVAL = 30000;

// One non-overlapping poll belongs to the selected live session. Never look up
// the room again: a reconnect/new broadcast must not replace the selected key.
export function createRecordingUpdater({api, onUpdate, canRefresh = () => true, interval = LIVE_INTERVAL}) {
  let generation = 0,
    timer,
    controller;
  const read = (record, signal) =>
    api.clips(
      record,
      0,
      record.live ? Math.max(0, Math.floor(Date.now() / 1000) - record.start) : record.end - record.start,
      signal,
    );
  function stop() {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
  }
  function start(record) {
    stop();
    if (!record?.live) return;
    const token = generation;
    const schedule = () => {
      if (token === generation) timer = setTimeout(poll, interval);
    };
    async function poll() {
      if (token !== generation) return;
      if (!canRefresh()) {
        schedule();
        return;
      }
      const own = new AbortController();
      controller = own;
      try {
        const streams = await read(record, own.signal);
        if (token === generation && !own.signal.aborted && canRefresh()) onUpdate(streams);
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
    onUpdate(streams);
  }
  return {start, stop, refresh};
}
