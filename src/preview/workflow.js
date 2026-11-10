import {STUDIO} from './studio.js';
import {createPendingQueue, parseManualTime, markTime} from './marks.js';
import {createReplayClock, markSelection} from './replay.js';
import {utcToReplay} from '../media/replay-clock.js';
import {bindShortcut} from '../app/shortcut-field.js';
import {DEFAULT_SHORTCUT, matchesShortcut, normalizeShortcut} from '../ui/shortcuts.js';
import {roomIdFromUrl} from '../domain/records.js';

export const MARK_SHORTCUT = {...DEFAULT_SHORTCUT, code: 'KeyM'};

export function createLoginGate({root, client}) {
  const $ = id => root.getElementById(id);
  const login = document.createElement('section');
  login.id = 'studioLogin';
  login.innerHTML = `<p>登录贝报创作台后即可使用。</p><a class="button" href="${STUDIO}/plugin/link" target="_blank" rel="noopener noreferrer">登录</a>`;
  $('body').prepend(login);
  const style = document.createElement('style');
  style.textContent =
    '#panel[data-logged-out] #body > :not(#studioLogin), #panel[data-logged-out] #shortcut, #panel[data-logged-out] #version {display:none!important} #studioLogin {padding:24px}';
  root.append(style);
  const render = () => {
    const loggedOut = !client.identity();
    $('panel').toggleAttribute('data-logged-out', loggedOut);
    login.hidden = !loggedOut;
  };
  render();
  client.subscribe(render);
  return render;
}

export function createWorkflow({root, client, get, set, keys, api, mediaRequest, session, open, onLogout}) {
  const $ = id => root.getElementById(id);
  createLoginGate({root, client});
  const style = document.createElement('style');
  style.textContent = `
    .studio-settings,.studio-marks {padding:12px 0;border-top:1px solid #8884}
    .studio-settings label {display:inline-flex;gap:6px;align-items:center;margin:6px}
    .studio-settings input[type=number] {width:65px} #markShortcut {width:150px}
    .studio-marks form,.studio-row {display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}
    .studio-row input {min-width:60px;max-width:180px} .studio-row [data-time] {width:90px}
    .studio-row small {opacity:.7} .studio-marks input {padding:5px} .studio-marks pre {white-space:pre-wrap}
    #studioToast {position:fixed;right:24px;bottom:80px;z-index:2147483647;background:#24232b;color:white;padding:12px;border-radius:8px;max-width:360px;font:14px/1.5 sans-serif}
    #studioToast input {display:block;width:270px;padding:6px;margin-top:6px;color:#222;background:white}
    #studioTicks {position:absolute;inset:0;pointer-events:none;z-index:5} #studioTicks i {position:absolute;top:0;height:12px;width:3px;background:#f7b538}
  `;
  root.append(style);
  const settings = document.createElement('details');
  settings.className = 'studio-settings';
  settings.innerHTML =
    '<summary>设置</summary><p><span id="studioIdentity"></span> <button id="studioLogout">退出</button></p><label>记轴快捷键 <input id="markShortcut" readonly></label><label>入点提前（秒）<input id="markBefore" type="number" min="0" max="3600"></label><label>出点延后（秒）<input id="markAfter" type="number" min="0" max="3600"></label>';
  $('body').append(settings);
  const area = document.createElement('section');
  area.className = 'studio-marks';
  area.innerHTML =
    '<h3>共享轴表</h3><form><input id="manualMark" aria-label="补记时间和备注" placeholder="21:13:40 跑调" maxlength="210" required><button>补记</button><button type="button" id="recordMark">记轴</button></form><div id="studioMarkStatus" role="status"></div><div id="studioMarks"></div>';
  $('editPage').append(area);
  const ticks = document.createElement('div');
  ticks.id = 'studioTicks';
  $('timeline').append(ticks);
  const toast = document.createElement('div');
  toast.id = 'studioToast';
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  root.append(toast);
  let toastTimer,
    inputTimer,
    finishInput,
    records = [],
    parts = [],
    refreshing,
    waiting = null,
    disposed = false;
  let clock = createReplayClock(mediaRequest),
    ownerKey;
  const margins = () => ({before: Number($('markBefore').value), after: Number($('markAfter').value)});
  for (const [id, key, fallback] of [
    ['markBefore', 'marks.before', 30],
    ['markAfter', 'marks.after', 15],
  ]) {
    $(id).value = get(key, fallback);
    $(id).onchange = () => {
      const value = Number($(id).value);
      if (!Number.isFinite(value) || value < 0 || value > 3600) $(id).value = fallback;
      set(key, Number($(id).value));
      render();
    };
  }
  function notice(text) {
    if (finishInput) {
      $('studioMarkStatus').textContent = text;
      return;
    }
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 5000);
  }
  const queue = createPendingQueue({
    get,
    set,
    keys,
    client,
    changed(mark) {
      if (mark) records = [...records.filter(item => item.id !== mark.id), mark];
      render();
    },
  });
  function range() {
    const record = session.record();
    return record && record.kind !== 'submission'
      ? {from: record.start * 1000, to: record.live ? client.serverNow() + 1 : record.end * 1000, room: record.room}
      : null;
  }
  function items() {
    const current = range();
    if (!current) return [];
    const pending = queue
      .entries()
      .map(entry => ({...entry.mark, pending: true, created_by: client.identity()?.name || ''}));
    return [...new Map([...records, ...pending].map(mark => [mark.id, mark])).values()]
      .filter(mark => Number(mark.room_id) === Number(current.room) && mark.at >= current.from && mark.at < current.to)
      .sort((a, b) => a.at - b.at);
  }
  function renderTicks() {
    ticks.replaceChildren();
    if (!range() || !parts.length || ownerKey !== session.record()?.key) return;
    const view = session.view(),
      record = session.record();
    for (const mark of items().filter(mark => !mark.deleted)) {
      const mapped = utcToReplay(mark.at, parts);
      if (!mapped || mapped.snapped) continue;
      const time = mapped.part.start_time - record.start + mapped.position;
      if (time < view.start || time > view.end) continue;
      const tick = document.createElement('i');
      tick.style.left = `${((time - view.start) / (view.end - view.start)) * 100}%`;
      ticks.append(tick);
    }
  }
  function render() {
    area.hidden = !range();
    renderTicks();
    if (root.activeElement?.matches('input') && $('studioMarks').contains(root.activeElement)) return;
    $('studioMarks').replaceChildren();
    for (const mark of items()) {
      const row = document.createElement('div');
      row.className = 'studio-row';
      const button = (text, action) => {
        const el = document.createElement('button');
        el.textContent = text;
        el.type = 'button';
        el.onclick = () => void run(action);
        row.append(el);
        return el;
      };
      button(markTime(mark.at), () => jump(mark)).disabled = Boolean(mark.deleted);
      const note = document.createElement('span');
      note.textContent = mark.note || '（无备注）';
      row.append(note);
      const info = document.createElement('small');
      info.textContent = `${mark.created_by || ''} · ${mark.pending ? '未同步' : mark.deleted ? '已删除' : '已同步'}${!mark.deleted && (!parts.length || mark.at + margins().after * 1000 > parts.at(-1).end_time * 1000) ? ' · 等待回放' : ''}`;
      row.append(info);
      if (/^BV[0-9A-Za-z]+$/.test(mark.bvid || '')) {
        const link = document.createElement('a');
        link.textContent = mark.bvid;
        link.href = `https://www.bilibili.com/video/${mark.bvid}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        row.append(link);
      }
      if (!mark.pending) {
        if (!mark.deleted)
          button('编辑', () => {
            const time = document.createElement('input');
            time.value = markTime(mark.at);
            time.dataset.time = '';
            time.setAttribute('aria-label', '轴时间（UTC+8）');
            const input = document.createElement('input');
            input.value = mark.note;
            input.maxLength = 200;
            input.setAttribute('aria-label', '轴备注');
            row.append(time, input);
            button('保存', async () => {
              const parsed = parseManualTime(time.value, {...range(), now: client.serverNow()});
              await mutate(mark, 'PUT', '', {room_id: mark.room_id, at: parsed.at, note: input.value, rev: mark.rev});
            });
            input.focus();
          });
        button(mark.deleted ? '撤销删除' : '删除', () =>
          mutate(mark, mark.deleted ? 'POST' : 'DELETE', mark.deleted ? '/restore' : ''),
        );
        button('历史', async () => {
          const history = await client.request(`/marks/${mark.id}/revisions`);
          const pre = document.createElement('pre');
          pre.textContent = history
            .map(
              item =>
                `#${item.rev} ${item.op} · ${item.by} · ${new Date(item.at_time).toISOString()}\n${JSON.stringify(item.changes)}`,
            )
            .join('\n');
          row.append(pre);
        });
      }
      $('studioMarks').append(row);
    }
  }
  async function run(action) {
    if (!client.identity()) return;
    try {
      await action();
    } catch (error) {
      if (error.status === 409) {
        root.activeElement?.blur();
        await refresh(true);
        notice('这条轴已被修改，已刷新，请重试。');
      } else notice(error.message);
    }
  }
  async function mutate(mark, method, suffix, body) {
    await client.request(`/marks/${mark.id}${suffix}${body ? '' : `?rev=${mark.rev}`}`, {method, body});
    root.activeElement?.blur();
    await refresh(true);
  }
  async function jump(mark) {
    if (!session.ready()) return;
    const {before, after} = margins();
    const selection = markSelection(mark.at, before, after, parts);
    if (!selection) {
      waiting = mark;
      notice('等待回放');
      if (session.record()?.live) await session.refresh();
      return;
    }
    waiting = null;
    session.select(selection, mark);
    if (selection.snapped) notice('时间落在断流空档或跨分段，已对齐到最近可用画面；跨段请分段导出。');
  }
  function refresh(force = false) {
    if (refreshing) return force === true ? refreshing.then(() => refresh()) : refreshing;
    refreshing = readMarks().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function readMarks() {
    if (disposed || !client.identity() || $('panel').hidden || document.hidden) return;
    const record = session.record(),
      key = record?.key;
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
      if (session.record()?.key !== key || !client.identity()) return;
      records = result;
      render();
      if (session.ready()) {
        const mapped = await clock(await session.groups(), session.signal());
        if (session.record()?.key !== key || !client.identity()) return;
        parts = mapped;
        render();
        if (waiting) await jump(waiting);
      }
      void client.syncClock().catch(() => {});
    } catch (error) {
      if (error.name !== 'AbortError') $('studioMarkStatus').textContent = error.message;
    }
  }
  async function capture() {
    if (!client.identity()) return;
    const at = client.serverNow(),
      id = crypto.randomUUID();
    finishInput?.('');
    const current = session.record();
    const pageRoom = roomIdFromUrl(location.href);
    let room = !$('panel').hidden && current?.kind !== 'submission' ? current?.room : null;
    if (!room && pageRoom) {
      room = get(`studio.room.${pageRoom}`, null);
      if (!room) room = await resolvePageRoom();
    }
    if (!room || !client.identity()) {
      notice('请先打开直播或回放场次');
      return;
    }
    queue.add({id, room_id: room, at, note: ''});
    clearTimeout(toastTimer);
    toast.replaceChildren(document.createTextNode('已记轴 · Enter 保存，Esc 留空'));
    const input = document.createElement('input');
    input.maxLength = 200;
    input.setAttribute('aria-label', '轴备注');
    toast.append(input);
    toast.hidden = false;
    finishInput = note => {
      clearTimeout(inputTimer);
      queue.finish(id, note);
      toast.hidden = true;
      finishInput = null;
    };
    input.onkeydown = event => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finishInput(event.key === 'Enter' ? input.value : '');
      }
    };
    inputTimer = setTimeout(() => finishInput?.(input.value), 12000);
    input.focus();
  }
  async function resolvePageRoom() {
    const room = roomIdFromUrl(location.href);
    if (!room || !client.identity()) return null;
    const live = await api.current({room, name: '当前直播间'});
    set(`studio.room.${room}`, live.room);
    return live.room;
  }
  void resolvePageRoom().catch(() => {});
  $('recordMark').onclick = () => void run(capture);
  area.querySelector('form').onsubmit = event => {
    event.preventDefault();
    void run(async () => {
      const parsed = parseManualTime($('manualMark').value, {...range(), now: client.serverNow()});
      const id = crypto.randomUUID();
      queue.add({id, room_id: range().room, ...parsed});
      queue.finish(id, parsed.note);
      $('manualMark').value = '';
      notice('已补记');
    });
  };
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
  });
  $('studioLogout').onclick = () => client.logout();
  const authChanged = () => {
    $('studioIdentity').textContent = `已登录：${client.identity()?.name || ''}`;
    if (!client.identity()) {
      finishInput?.('');
      waiting = null;
      records = [];
      parts = [];
      onLogout();
    } else {
      void resolvePageRoom().catch(() => {});
      void queue.flush();
      if (!$('panel').hidden) void open();
    }
  };
  client.subscribe(authChanged);
  $('studioIdentity').textContent = `已登录：${client.identity()?.name || ''}`;
  const online = () => {
    void client.check().catch(() => {});
    void queue.flush(true);
    void refresh();
  };
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(() => void refresh(), 10000);
  return {
    refresh,
    opened() {
      void queue.flush(true);
      return refresh(true);
    },
    acceptsPanelShortcut: value =>
      !matchesShortcut(value, normalizeShortcut(get('marks.shortcut', MARK_SHORTCUT)) || MARK_SHORTCUT),
    renderTicks,
    dispose() {
      disposed = true;
      queue.stop();
      clearInterval(timer);
      clearTimeout(toastTimer);
      clearTimeout(inputTimer);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', refresh);
    },
  };
}
