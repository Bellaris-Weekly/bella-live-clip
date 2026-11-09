const DAY = 86400000,
  ZONE = 8 * 3600000;
export function parseManualTime(text, {from, to, now}) {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(.*))?$/s);
  if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59)
    throw new Error('请输入东八区时间，如 21:13:40 跑调');
  const time = (+match[1] * 3600 + +match[2] * 60 + +(match[3] || 0)) * 1000;
  const midnight = value => Math.floor((value + ZONE) / DAY) * DAY - ZONE;
  let at = midnight(to - 1) + time;
  if (at >= to) at -= DAY;
  if (at < from || at >= to) {
    at = midnight(now) + time;
    if (at > now) at -= DAY;
  }
  const note = match[4] || '';
  if (note.length > 200) throw new Error('备注不能超过 200 字');
  return {at, note};
}
export const markTime = at => new Date(at + ZONE).toISOString().slice(11, 19);

// Each UUID has its own key: tabs never overwrite each other's queue snapshot.
// A create payload is immutable once sent, including when its response is lost.
export function createPendingQueue({get, set, keys, client, now = Date.now, changed = () => {}}) {
  const prefix = 'studio.pending.';
  let running,
    timer,
    stopped = false;
  const entries = () =>
    keys()
      .filter(key => key.startsWith(prefix))
      .map(key => get(key, null))
      .filter(Boolean);
  function schedule() {
    clearTimeout(timer);
    const next = entries().reduce((min, entry) => Math.min(min, entry.next || 0), Infinity);
    if (!stopped && client.identity() && Number.isFinite(next))
      timer = setTimeout(() => void flush(), Math.max(100, next - now()));
  }
  async function replay(force) {
    for (const entry of entries()) {
      if (stopped || !client.identity()) break;
      if (entry.next > now() && (!force || !entry.finalized)) continue;
      entry.finalized = true;
      set(prefix + entry.mark.id, entry);
      try {
        const {room_id, at, note} = entry.mark;
        const mark = await client.request(`/marks/${entry.mark.id}`, {method: 'PUT', body: {room_id, at, note}});
        set(prefix + entry.mark.id, null);
        changed(mark);
      } catch (error) {
        entry.attempt = (entry.attempt || 0) + 1;
        entry.next = now() + Math.min(300000, 1000 * 2 ** Math.min(entry.attempt, 9));
        set(prefix + entry.mark.id, entry);
        changed();
        if (error.status === 401) break;
      }
    }
  }
  function flush(force = false) {
    if (running) return running;
    running = replay(force).finally(() => {
      running = null;
      schedule();
    });
    return running;
  }
  return {
    entries,
    flush,
    add(mark) {
      set(prefix + mark.id, {mark, next: now() + 15000});
      changed();
      schedule();
    },
    finish(id, note) {
      const key = prefix + id,
        entry = get(key, null);
      // Note input is closed before this deadline; retries always replay the exact body.
      if (!entry || entry.finalized) return;
      entry.finalized = true;
      entry.mark.note = note;
      entry.next = 0;
      set(key, entry);
      changed();
      void flush();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
