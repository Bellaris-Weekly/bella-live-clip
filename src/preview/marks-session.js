import {batch, signal} from '@preact/signals';
import {createPendingQueue, markTime, parseManualTime} from './marks.js';
import {createReplayClock, markSelection} from './replay.js';
import {utcToReplay} from '../media/replay-clock.js';
import {bindShortcut} from '../app/shortcut-field.js';
import {DEFAULT_SHORTCUT, matchesShortcut, normalizeShortcut} from '../ui/shortcuts.js';
import {roomIdFromUrl} from '../domain/records.js';

export const MARK_SHORTCUT = {...DEFAULT_SHORTCUT, code: 'KeyM'};
// A note that has been written and left alone is saved after this long.
export const AUTOSAVE_SECONDS = 8;

// Shared marks for the open recording (editor side column) or the live room this page shows
// (the mini window). Marks are absolute UTC+8 instants; they map to recording time only once
// the replay clock of each recorded part is known.
export function createMarksSession({
  root,
  client,
  get,
  set,
  keys,
  api,
  mediaRequest,
  pageUrl,
  session,
  notify,
  report,
  onLogout,
}) {
  const state = {
    items: signal([]),
    filter: signal('all'),
    selected: signal(null),
    editing: signal(null),
    history: signal(null),
    error: signal(''),
    capture: signal(null),
    live: signal(null),
    mini: signal(false),
    margins: signal({before: get('marks.before', 30), after: get('marks.after', 15)}),
    shortcut: signal(''),
  };
  let records = [],
    parts = [],
    refreshing,
    waiting = null,
    disposed = false,
    captureTimer,
    clock = createReplayClock(mediaRequest),
    ownerKey;
  const queue = createPendingQueue({
    get,
    set,
    keys,
    client,
    changed(mark) {
      if (mark) records = [...records.filter(item => item.id !== mark.id), mark];
      render();
    },
    failed(mark, error) {
      notify(`${markTime(mark.at)} 的轴没有传上创作台：${error.message}`, {error: true});
      report(error, {record: {room: mark.room_id}});
    },
  });
  // The editor's recording wins; otherwise the live room of this page, while it is live.
  function range() {
    const record = session.record();
    if (record && record.kind !== 'submission')
      return {
        from: record.start * 1000,
        to: record.live ? client.serverNow() + 1 : record.end * 1000,
        room: record.room,
      };
    const live = state.live.value;
    return live ? {from: live.start * 1000, to: client.serverNow() + 1, room: live.room} : null;
  }
  function timeOf(mark) {
    const record = session.record();
    if (!record || ownerKey !== record.key || !parts.length) return null;
    const mapped = utcToReplay(mark.at, parts);
    return mapped && !mapped.snapped ? mapped.part.start_time - record.start + mapped.position : null;
  }
  function render() {
    const current = range();
    if (!current) {
      state.items.value = [];
      return;
    }
    const me = client.identity()?.name || '';
    const pending = queue.entries().map(entry => ({...entry.mark, pending: true, error: entry.error, created_by: me}));
    const {after} = state.margins.value;
    state.items.value = [...new Map([...records, ...pending].map(mark => [mark.id, mark])).values()]
      .filter(mark => Number(mark.room_id) === Number(current.room) && mark.at >= current.from && mark.at < current.to)
      .sort((a, b) => a.at - b.at)
      .map(mark => ({
        ...mark,
        mine: mark.created_by === me,
        time: mark.deleted ? null : timeOf(mark),
        // Only the editor knows how far the replay reaches.
        waiting:
          !mark.deleted &&
          Boolean(session.record()) &&
          (!parts.length || mark.at + after * 1000 > parts.at(-1).end_time * 1000),
      }));
  }
  async function run(action) {
    if (!client.identity()) return;
    try {
      return await action();
    } catch (error) {
      if (error.status === 409) {
        state.editing.value = null;
        await refresh(true);
        notify('这条轴刚被别人修改，已刷新，请重试。', {error: true});
      } else notify(error.message, {error: true});
    }
  }
  async function mutate(mark, method, suffix, body) {
    await client.request(`/marks/${mark.id}${suffix}${body ? '' : `?rev=${mark.rev}`}`, {method, body});
    await refresh(true);
  }
  async function jump(mark) {
    if (!session.ready()) return;
    const {before, after} = state.margins.value;
    state.selected.value = mark.id;
    const selection = markSelection(mark.at, before, after, parts);
    if (!selection) {
      waiting = mark;
      notify('这段回放还没生成，生成后会自动跳过去。');
      if (session.record()?.live) await session.refresh();
      return false;
    }
    waiting = null;
    session.select(selection, mark);
    notify(
      selection.snapped
        ? '这条轴落在断流空档或跨分段，已对齐到最近可用画面；跨段请分段导出。'
        : `已选中前 ${before} 秒到后 ${after} 秒`,
    );
    return true;
  }
  function refresh(force = false) {
    if (refreshing) return force === true ? refreshing.then(() => refresh()) : refreshing;
    refreshing = readMarks().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function readMarks() {
    if (disposed || !client.identity() || document.hidden) return;
    if (!session.isOpen() && !state.mini.value) return;
    const record = session.record(),
      key = record?.key ?? `live:${state.live.value?.room}`;
    try {
      if (ownerKey !== key) {
        ownerKey = key;
        records = [];
        parts = [];
        waiting = null;
        clock = createReplayClock(mediaRequest);
      }
      render();
      await queue.flush();
      const current = range();
      if (!current) return;
      const result = await client.request(
        `/marks?${new URLSearchParams({room_id: current.room, from: current.from, to: current.to, include_deleted: 1})}`,
      );
      if (ownerKey !== key || !client.identity()) return;
      records = result;
      state.error.value = '';
      render();
      if (record && session.ready()) {
        const mapped = await clock(await session.groups(), session.signal());
        if (session.record()?.key !== key || !client.identity()) return;
        parts = mapped;
        render();
        if (waiting) await jump(waiting);
      }
      void client.syncClock().catch(() => {});
    } catch (error) {
      if (error.name !== 'AbortError') state.error.value = error.message;
    }
  }
  // The real room id and the running stream for this page, so marks work without the editor.
  async function resolveLive() {
    const pageRoom = roomIdFromUrl(pageUrl());
    if (!pageRoom || !client.identity()) return null;
    const live = await api.current({room: pageRoom, name: '当前直播间'});
    set(`studio.room.${pageRoom}`, live.room);
    state.live.value = live.live ? {room: live.room, start: live.start, title: live.title, member: live.member} : null;
    return live.room;
  }
  // The draft lives only in memory until it is saved; an empty draft is never uploaded by itself.
  async function capture() {
    if (!client.identity()) return;
    const at = client.serverNow(),
      id = crypto.randomUUID();
    settleCapture();
    const current = session.record();
    const pageRoom = roomIdFromUrl(pageUrl());
    let room = session.isOpen() && current?.kind !== 'submission' ? current?.room : null;
    if (!room && pageRoom)
      room = state.live.value?.room ?? get(`studio.room.${pageRoom}`, null) ?? (await resolveLive());
    if (!room || !client.identity()) {
      notify('请先打开直播或回放场次', {error: true});
      return;
    }
    batch(() => {
      state.capture.value = {id, at, room, note: '', deadline: null};
      if (!session.isOpen()) state.mini.value = true;
    });
    void refresh();
  }
  function updateCapture(patch) {
    if (state.capture.value) state.capture.value = {...state.capture.value, ...patch};
  }
  function holdCapture() {
    clearTimeout(captureTimer);
    updateCapture({deadline: null});
  }
  function releaseCapture() {
    const current = state.capture.value;
    if (!current || !current.note.trim() || current.deadline) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => saveCapture(), AUTOSAVE_SECONDS * 1000);
    updateCapture({deadline: Date.now() + AUTOSAVE_SECONDS * 1000});
  }
  function closeCapture() {
    const current = state.capture.value;
    clearTimeout(captureTimer);
    state.capture.value = null;
    return current;
  }
  function saveCapture(note = state.capture.value?.note ?? '') {
    const current = closeCapture();
    if (current) queue.add({id: current.id, room_id: current.room, at: current.at, note: note.trim()});
  }
  // Written notes are kept when the draft has to go away; blank drafts are dropped.
  function settleCapture() {
    if (state.capture.value?.note.trim()) saveCapture();
    else closeCapture();
  }
  bindShortcut({
    root,
    get,
    set,
    onPress: () => void run(capture),
    field: 'markShortcut',
    key: 'marks.shortcut',
    fallback: MARK_SHORTCUT,
    accepts: value =>
      !matchesShortcut(value, normalizeShortcut(get('shortcut', DEFAULT_SHORTCUT)) || DEFAULT_SHORTCUT) &&
      !matchesShortcut(value, DEFAULT_SHORTCUT),
    onChange: text => (state.shortcut.value = text),
  });
  const authChanged = () => {
    if (!client.identity()) {
      closeCapture();
      waiting = null;
      records = [];
      parts = [];
      batch(() => {
        state.mini.value = false;
        state.live.value = null;
        state.history.value = null;
        state.editing.value = null;
      });
      render();
      onLogout();
    } else {
      void resolveLive().catch(() => {});
      void queue.flush();
      if (session.isOpen()) void session.open();
    }
  };
  client.subscribe(authChanged);
  void resolveLive().catch(() => {});
  const online = () => {
    void client.check().catch(() => {});
    void queue.flush(true);
    void refresh();
  };
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(() => void refresh(), 10000);
  return {
    state,
    refresh,
    opened() {
      state.mini.value = false;
      void queue.flush(true);
      return refresh(true);
    },
    acceptsPanelShortcut: value =>
      !matchesShortcut(value, normalizeShortcut(get('marks.shortcut', MARK_SHORTCUT)) || MARK_SHORTCUT),
    actions: {
      capture: () => void run(capture),
      setNote: note => updateCapture({note}),
      holdCapture,
      releaseCapture,
      saveCapture,
      discardCapture: closeCapture,
      restamp: () => updateCapture({at: client.serverNow()}),
      shiftCapture: seconds =>
        updateCapture({at: Math.min(client.serverNow(), state.capture.value.at + seconds * 1000)}),
      add: text =>
        run(async () => {
          const current = range();
          if (!current) throw new Error('请先打开直播或回放场次');
          const parsed = parseManualTime(text, {...current, now: client.serverNow()});
          queue.add({id: crypto.randomUUID(), room_id: current.room, ...parsed});
        }),
      jump: mark => run(() => jump(mark)),
      edit: mark => (state.editing.value = mark.id),
      cancelEdit: () => (state.editing.value = null),
      save: (mark, time, note) =>
        run(async () => {
          const parsed = parseManualTime(time, {...range(), now: client.serverNow()});
          await mutate(mark, 'PUT', '', {room_id: mark.room_id, at: parsed.at, note, rev: mark.rev});
          state.editing.value = null;
        }),
      remove: mark => run(() => mutate(mark, 'DELETE', '')),
      restore: mark => run(() => mutate(mark, 'POST', '/restore')),
      history: mark =>
        run(async () => {
          state.history.value = {mark, rows: null};
          const rows = await client.request(`/marks/${mark.id}/revisions`);
          if (state.history.value?.mark === mark) state.history.value = {mark, rows};
        }),
      closeHistory: () => (state.history.value = null),
      setFilter: filter => (state.filter.value = filter),
      setMargin(key, value) {
        const number = Number(value);
        const valid = Number.isFinite(number) && number >= 0 && number <= 3600;
        const next = valid ? number : key === 'before' ? 30 : 15;
        set(`marks.${key}`, next);
        state.margins.value = {...state.margins.value, [key]: next};
        render();
      },
      showMini: () => {
        state.mini.value = true;
        void refresh(true);
      },
      hideMini: () => {
        settleCapture();
        state.mini.value = false;
      },
    },
    dispose() {
      disposed = true;
      queue.stop();
      clearInterval(timer);
      clearTimeout(captureTimer);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', refresh);
    },
  };
}
