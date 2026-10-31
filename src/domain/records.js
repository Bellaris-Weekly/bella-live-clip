export const MEMBERS = Object.freeze([
  { id: 'bella', name: '贝拉', uid: 672353429, room: 22632424, color: '#b97259' },
  { id: 'diana', name: '嘉然', uid: 672328094, room: 22637261, color: '#c7829c' },
  { id: 'eileen', name: '乃琳', uid: 672342685, room: 22625027, color: '#7b85ad' },
  { id: 'xinyi', name: '心宜', uid: '3537115310721181', room: 30849777, color: '#c93773' },
  { id: 'sinuo', name: '思诺', uid: '3537115310721781', room: 30858592, color: '#7252c0' },
]);

// A poster is decoration: anything but a platform image is simply not shown.
function imageUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.replace(/^\/\//, 'https://'));
    url.protocol = 'https:';
    return url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com') ? url.href : null;
  } catch { return null; }
}

export function recordFromReplay(item, member) {
  if (typeof item.live_key !== 'string') throw new Error('场次编号格式异常，请刷新场次列表。');
  return {
    key: item.live_key, title: item.live_info.title, start: item.start_time,
    end: item.end_time, live: false, uid: member.uid, member: member.name, room: item.room_id,
    poster: imageUrl(item.live_info.cover),
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

export function roomFromBaseInfo(data, room) {
  const info = data?.by_room_ids?.[room];
  if (!info || ![0, 1, 2].includes(info.live_status)) {
    throw new Error('直播间暂未返回场次信息。');
  }
  if (info.live_status !== 1) return info;
  // This endpoint returns Beijing wall time, without a timezone suffix.
  const time = info.live_time;
  const start = typeof time === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)
    ? Date.parse(`${time.replace(' ', 'T')}+08:00`) / 1000 : NaN;
  if (!Number.isFinite(start) || start <= 0) {
    throw new Error('直播开播时间不可用，请稍后重新检查。');
  }
  return { ...info, live_start_time: start };
}

export function recordFromRoom(info, member, now = Date.now() / 1000) {
  if (info.live_status !== 1) throw new Error('当前没有直播。可以切换到历史回放，选择已结束的场次。');
  if (typeof info.live_id_str !== 'string' || !/^\d+$/.test(info.live_id_str) || !/[1-9]/.test(info.live_id_str)) {
    throw new Error('直播场次编号不可用，请刷新直播间。');
  }
  if (!Number.isFinite(info.live_start_time) || info.live_start_time <= 0 ||
      !Number.isSafeInteger(Number(info.uid)) || Number(info.uid) <= 0 ||
      !Number.isSafeInteger(Number(info.room_id)) || Number(info.room_id) <= 0) {
    throw new Error('直播场次信息不完整，请重新检查。');
  }
  return {
    key: info.live_id_str, title: info.title, start: info.live_start_time,
    end: Math.floor(now), live: true, uid: info.uid, member: member.name, room: info.room_id,
    poster: imageUrl(info.keyframe) || imageUrl(info.cover),
  };
}

export function roomIdFromUrl(value) {
  const url = new URL(value);
  if (url.hostname !== 'live.bilibili.com') return null;
  const match = url.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}
