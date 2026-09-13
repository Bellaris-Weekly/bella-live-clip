export const MEMBERS = Object.freeze([
  { id: 'bella', name: '贝拉', uid: 672353429, room: 22632424, color: '#b97259' },
  { id: 'diana', name: '嘉然', uid: 672328094, room: 22637261, color: '#c7829c' },
  { id: 'eileen', name: '乃琳', uid: 672342685, room: 22625027, color: '#7b85ad' },
  { id: 'xinyi', name: '心宜', uid: '3537115310721181', room: 30849777, color: '#c93773' },
  { id: 'sinuo', name: '思诺', uid: '3537115310721781', room: 30858592, color: '#7252c0' },
]);

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
