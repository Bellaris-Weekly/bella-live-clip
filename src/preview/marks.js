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
// A create payload is immutable once queued, including when its response is lost.
const RETRYABLE = new Set([401, 408, 429]);
export function createPendingQueue({get, set, keys, client, now = Date.now, changed = () => {}, failed = () => {}}) {
  const prefix = 'studio.pending.';
  let running,
    timer,
    stopped = false;
  const owner = () => client.identity()?.sub;
  const entries = () =>
    keys()
      .filter(key => key.startsWith(prefix))
      .map(key => get(key, null))
      // Legacy entries have no reliable owner; keep them stored without uploading them.
      .filter(entry => entry && owner() && entry.owner === owner());
  function schedule() {
    clearTimeout(timer);
    const next = entries().reduce((min, entry) => Math.min(min, entry.next || 0), Infinity);
    if (!stopped && client.identity() && Number.isFinite(next))
      timer = setTimeout(() => void flush(), Math.max(100, next - now()));
  }
  async function replay(force) {
    const user = owner();
    for (const entry of entries()) {
      if (stopped || owner() !== user) break;
      if (entry.next > now() && !force) continue;
      try {
        const {room_id, at, note} = entry.mark;
        const mark = await client.request(`/marks/${entry.mark.id}`, {method: 'PUT', body: {room_id, at, note}});
        set(prefix + entry.mark.id, null);
        if (owner() === user) changed(mark);
      } catch (error) {
        // A rejected payload never succeeds on retry; the server keeps the mark on 409.
        const permanent = error.status >= 400 && error.status < 500 && !RETRYABLE.has(error.status);
        if (permanent) set(prefix + entry.mark.id, null);
        else {
          entry.attempt = (entry.attempt || 0) + 1;
          entry.next = now() + Math.min(300000, 1000 * 2 ** Math.min(entry.attempt, 9));
          entry.error = error.message;
          set(prefix + entry.mark.id, entry);
        }
        if (owner() === user) {
          changed();
          if (permanent) failed(entry.mark, error);
        }
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
      if (!owner()) throw new Error('请先联网验证登录身份后再记轴');
      set(prefix + mark.id, {mark, owner: owner(), next: 0});
      changed();
      void flush();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
