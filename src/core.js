export const MEMBERS = Object.freeze([
  { id: 'bella', name: '贝拉', uid: 672353429, room: 22632424, color: '#b97259' },
  { id: 'diana', name: '嘉然', uid: 672328094, room: 22637261, color: '#c7829c' },
  { id: 'eileen', name: '乃琳', uid: 672342685, room: 22625027, color: '#7b85ad' },
  { id: 'xinyi', name: '心宜', uid: '3537115310721181', room: 30849777, color: '#c93773' },
  { id: 'sinuo', name: '思诺', uid: '3537115310721781', room: 30858592, color: '#7252c0' },
]);

export const DEFAULT_SHORTCUT = Object.freeze({
  code: 'KeyC', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false,
});
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function formatTime(seconds, fractional = false) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${fractional ? '.' + String(ms % 1000).padStart(3, '0') : ''}`;
}

export function formatPlaybackTime(seconds) {
  const whole=Math.floor(Math.max(0,seconds));
  const h=Math.floor(whole/3600),m=Math.floor(whole/60)%60,s=whole%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

export function formatTimeRange(start,end,separator=' — ') {
  const values=[start,end].map(value=>Math.floor(Math.max(0,value)));
  const hours=values.map(value=>Math.floor(value/3600));
  const showHours=hours.some(value=>value>0);
  const hourWidth=Math.max(2,...hours.map(value=>String(value).length));
  return values.map((value,i)=>{
    const minutes=String(Math.floor(value/60)%60).padStart(2,'0');
    const seconds=String(value%60).padStart(2,'0');
    return `${showHours?String(hours[i]).padStart(hourWidth,'0')+':':''}${minutes}:${seconds}`;
  }).join(separator);
}

export function formatCompactTime(seconds) {
  const ms=Math.round(Math.max(0,seconds)*1000);
  const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  const sec=`${String(s).padStart(h||m?2:1,'0')}.${String(ms%1000).padStart(3,'0')}`;
  return h ? `${h}:${String(m).padStart(2,'0')}:${sec}` : m ? `${m}:${sec}` : sec;
}

export function formatDuration(seconds) {
  const tenths=Math.round(Math.max(0,seconds)*10);
  const h=Math.floor(tenths/36000),m=Math.floor(tenths/600)%60,s=(tenths%600)/10;
  return `${h ? h+'时' : ''}${h||m ? m+'分' : ''}${s.toFixed(1)}秒`;
}

export function formatDate(unix, withSeconds = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).format(new Date(unix * 1000));
}

export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export function validateRange(start, end, duration) {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end <= start) {
    throw new Error('结束时间必须晚于开始时间。');
  }
  if (end > duration + 0.001) throw new Error(`结束时间超出范围，最晚为 ${formatTime(duration, true)}。`);
  return { start, end };
}

export function recordFromReplay(item, member) {
  if (typeof item.live_key !== 'string') throw new Error('场次编号格式异常，请刷新场次列表。');
  return {
    key: item.live_key, title: item.live_info.title, start: item.start_time,
    end: item.end_time, live: false, uid: member.uid, member: member.name, room: item.room_id,
  };
}

export function roomFromHtml(html) {
  // Parse only the JSON assignment in a script element, never execute page code.
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .find(text => /^\s*window\.__NEPTUNE_IS_MY_WAIFU__\s*=/.test(text));
  if (!script) throw new Error('未找到直播场次信息，请刷新直播间后重试。');
  const raw = script.replace(/^\s*window\.__NEPTUNE_IS_MY_WAIFU__\s*=\s*/, '').trim().replace(/;\s*$/, '');
  const info = JSON.parse(raw).roomInfoRes;
  if (info?.code !== 0 || !info.data?.room_info) throw new Error('直播间暂未返回场次信息。');
  return info.data.room_info;
}

export function recordFromRoom(info, member, now = Date.now() / 1000) {
  if (info.live_status !== 1) throw new Error('当前没有直播。可以切换到历史回放，选择已结束的场次。');
  if (typeof info.live_id_str !== 'string' || !/^\d+$/.test(info.live_id_str)) {
    throw new Error('直播场次编号不可用，请刷新直播间。');
  }
  return {
    key: info.live_id_str, title: info.title, start: info.live_start_time,
    end: Math.floor(now), live: true, uid: info.uid, member: member.name, room: info.room_id,
  };
}

export function roomIdFromUrl(value) {
  const url = new URL(value);
  if (url.hostname !== 'live.bilibili.com') return null;
  const match = url.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

export function normalizeShortcut(value) {
  if (!value?.code || /^(Control|Alt|Shift|Meta|OS|Fn)(Left|Right)?$/.test(value.code)) return null;
  if (!value.ctrlKey && !value.altKey && !value.metaKey) return null;
  return Object.fromEntries(['code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey']
    .map(key => [key, key === 'code' ? value.code : Boolean(value[key])]));
}

export function formatShortcut(shortcut) {
  return [shortcut.ctrlKey && 'Ctrl', shortcut.altKey && 'Alt', shortcut.shiftKey && 'Shift',
    shortcut.metaKey && '⌘', shortcut.code.replace(/^Key|^Digit/, '')].filter(Boolean).join('+');
}

export function matchesShortcut(event, shortcut) {
  return !event.repeat && !event.isComposing && !event.defaultPrevented
    && ['code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey'].every(key => event[key] === shortcut[key]);
}

export function isEditing(event) {
  return [event.target, ...(event.composedPath?.() || [])].some(target =>
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable);
}

export function constrainRect(rect, viewport) {
  const margin = 10;
  const maxW = Math.max(1, viewport.width - margin * 2);
  const maxH = Math.max(1, viewport.height - margin * 2);
  const width = clamp(rect.width, Math.min(360, maxW), maxW);
  const height = clamp(rect.height, Math.min(480, maxH), maxH);
  return { width, height, left: clamp(rect.left, margin, viewport.width - margin - width),
    top: clamp(rect.top, margin, viewport.height - margin - height) };
}

export function resizeRect(rect, edge, dx, dy, viewport) {
  let { left, top, width, height } = rect;
  const minW = Math.min(360, viewport.width - 20), minH = Math.min(480, viewport.height - 20);
  if (edge.includes('e')) width = clamp(width + dx, minW, viewport.width - 10 - left);
  if (edge.includes('s')) height = clamp(height + dy, minH, viewport.height - 10 - top);
  if (edge.includes('w')) { const shift = clamp(dx, 10 - left, width - minW); left += shift; width -= shift; }
  if (edge.includes('n')) { const shift = clamp(dy, 10 - top, height - minH); top += shift; height -= shift; }
  return { left, top, width, height };
}

export function fileName(record, start, end, part = '') {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(record.start * 1000));
  const label = `${record.member}_${date}_${record.title}_${formatTime(start).replaceAll(':', '-')}-${formatTime(end).replaceAll(':', '-')}${part}`;
  return label.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) + '.mp4';
}

// Keep the time under the pointer stationary while zooming; pan never exceeds the media.
export function zoomWindow(view, total, factor, anchor = .5) {
  const span = view.end-view.start, width = clamp(span*factor,Math.min(.25,total),total);
  const pivot = view.start+span*clamp(anchor,0,1);
  const start = clamp(pivot-width*anchor,0,total-width);
  return {start,end:start+width};
}
export function panWindow(view,total,delta) {
  const width=view.end-view.start, start=clamp(view.start+delta,0,total-width);
  return {start,end:start+width};
}
