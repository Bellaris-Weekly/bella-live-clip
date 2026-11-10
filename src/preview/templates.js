import {matchSchedule, scheduleMonths} from '../services/schedule.js';

export const TEXT_FIELDS = ['title', 'desc', 'source', 'dynamic'];
export const FLAG_FIELDS = {
  no_reprint: '禁止转载',
  no_disturbance: '不推送动态',
  open_subtitle: '允许字幕',
  watermark: '水印',
  dolby: '杜比音效',
  lossless_music: '无损音频',
  charging_pay: '充电专属',
  up_selection_reply: '精选评论',
  up_close_reply: '关闭评论',
  up_close_danmu: '关闭弹幕',
  is_360: '全景视频',
};
export const ID_FIELDS = {mission_id: '活动 ID', topic_id: '话题 ID', human_type2: '新版分区 ID'};
const text = value => (typeof value === 'string' ? value : '');
const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const flag = value => value === true || value === 1 || value === '1' || value === 'true';
function positiveId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
export function tagsFrom(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : text(value).split(/[,，\n]/))
        .map(text)
        .map(tag => tag.trim())
        .filter(Boolean),
    ),
  ];
}

// Keep the studio archive draft defaults and its allowlist; collections are intentionally excluded.
export function draftFromTemplate(payload) {
  const fields = object(payload);
  const draft = {
    title: '',
    tid: 27,
    tags: [],
    desc: '',
    copyright: 1,
    source: '',
    no_reprint: true,
    scheduleAt: '',
    isOnlySelf: false,
  };
  for (const key of TEXT_FIELDS) if (key in fields) draft[key] = text(fields[key]);
  for (const key of Object.keys(FLAG_FIELDS)) if (key in fields) draft[key] = flag(fields[key]);
  for (const key of Object.keys(ID_FIELDS)) if (key in fields) draft[key] = positiveId(fields[key]);
  draft.tid = positiveId(fields.tid) ?? 27;
  if ('copyright' in fields) {
    const copyright = positiveId(fields.copyright);
    draft.copyright = copyright === 1 || copyright === 2 ? copyright : null;
  }
  if (draft.copyright === 2) draft.no_reprint = false;
  draft.tags = tagsFrom(fields.tags);
  draft.scheduleAt = text(fields.scheduleAt);
  draft.isOnlySelf = flag(fields.isOnlySelf);
  if (Array.isArray(fields.staff))
    draft.staff = fields.staff.map(value => {
      const row = object(value);
      return {mid: positiveId(row.mid) ?? 0, title: text(row.title)};
    });
  if (Array.isArray(fields.desc_v2))
    draft.desc_v2 = fields.desc_v2.map(value => {
      const row = object(value);
      return {
        type_id: positiveId(row.type_id ?? row.type) === 2 ? 2 : 1,
        raw_text: text(row.raw_text),
        biz_id: typeof row.biz_id === 'number' && positiveId(row.biz_id) ? String(row.biz_id) : text(row.biz_id),
      };
    });
  return draft;
}

export function matchingTemplate(templates, event) {
  if (!event?.participants.length) return null;
  const participants = new Set(event.participants.map(member => member.id));
  return (
    templates.find(template => {
      const ids = template.payload?.liveParticipants;
      return Array.isArray(ids) && new Set(ids).size === participants.size && ids.every(id => participants.has(id));
    }) ?? null
  );
}

export function liveValue(event) {
  if (!event) return '';
  const date = new Date((event.start + 8 * 3600) * 1000);
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}  ${event.title}`;
}

export function substitute(value, live, clipper) {
  return value.replace(/\{(live|clipper)\}/g, (placeholder, key) => (key === 'live' ? live : clipper) || placeholder);
}

export function assertResolved(...values) {
  if (values.some(value => /\{(live|clipper)\}/.test(value)))
    throw new Error('标题或简介仍有未填写的占位符，请补全直播、二创署名或模板内容');
}

export async function submissionSchedule(record, schedules, signal, now = Date.now() / 1000) {
  const calendars = new Map();
  let failed = false;
  async function read(month) {
    if (!calendars.has(month))
      calendars.set(
        month,
        (async () => {
          try {
            return await schedules.calendar(month, {signal, refresh: false});
          } catch {
            signal.throwIfAborted();
            failed = true;
            return null;
          }
        })(),
      );
    return calendars.get(month);
  }
  const matchedCalendars = await Promise.all(scheduleMonths(record.start).map(read));
  const matched = matchedCalendars.every(Boolean) ? matchSchedule(record, matchedCalendars.flat()) : null;
  const recent = new Map();
  const month = new Date((now + 8 * 3600) * 1000);
  month.setUTCDate(1);
  // Walk back at most six monthly files until five started Bella events are found.
  for (let walked = 0; recent.size < 5 && walked < 6; walked++) {
    const events = await read(month.toISOString().slice(0, 7));
    if (!events) break;
    for (const event of events)
      if (event.start <= now && event.participants.some(member => member.id === 'bella')) {
        recent.set(event.uid || `${event.room}:${event.start}`, event);
      }
    month.setUTCMonth(month.getUTCMonth() - 1);
  }
  signal.throwIfAborted();
  return {matched, recent: [...recent.values()].sort((a, b) => b.start - a.start).slice(0, 5), failed};
}

export function submissionFields(draft, live, clipper, now = Date.now()) {
  const {scheduleAt, isOnlySelf, ...fields} = draft;
  fields.title = substitute(fields.title, live, clipper).trim();
  fields.desc = substitute(fields.desc, live, clipper);
  if (fields.desc_v2)
    fields.desc_v2 = fields.desc_v2.map(row => ({...row, raw_text: substitute(row.raw_text, live, clipper)}));
  assertResolved(fields.title, fields.desc, ...(fields.desc_v2 || []).map(row => row.raw_text));
  const length = value => [...value].length;
  if (!fields.title || length(fields.title) > 80) throw new Error('标题必填，最多 80 字');
  if (!positiveId(fields.tid) || fields.tid > 65535) throw new Error('请选择模板或填写有效分区 ID');
  if (!fields.tags.length || fields.tags.length > 12 || fields.tags.some(tag => length(tag) > 20))
    throw new Error('请填写 1–12 个标签，每个标签最多 20 字');
  if (fields.copyright !== 1 && fields.copyright !== 2) throw new Error('请选择稿件类型（自制或转载）');
  if (fields.copyright === 2) {
    fields.no_reprint = false;
    if (!fields.source.trim()) throw new Error('转载需要填写来源');
  }
  if (length(fields.desc) > 2000) throw new Error('简介不能超过 2000 个字');
  if (length(fields.source) > 200) throw new Error('转载来源不能超过 200 个字');
  if (length(fields.dynamic || '') > 233) throw new Error('同步动态不能超过 233 个字');
  for (const [key, label] of Object.entries(ID_FIELDS))
    if (fields[key] != null && (!positiveId(fields[key]) || (key === 'mission_id' && fields[key] > 0xffffffff)))
      throw new Error(`${label} 必须是有效的正整数，或留空`);
  const staff = fields.staff || [];
  if (
    staff.length > 10 ||
    staff.some(row => !positiveId(row.mid) || !row.title.trim() || length(row.title) > 20) ||
    new Set(staff.map(row => row.mid)).size !== staff.length
  )
    throw new Error('请填写有效且不重复的合作成员 UID 和 1–20 字的分工（最多 10 位）');
  const credits = fields.desc_v2 || [];
  if (
    credits.length > 100 ||
    credits.some(
      row => !row.raw_text || !/^[0-9]*$/.test(row.biz_id) || (row.type_id === 2 && !/[1-9]/.test(row.biz_id)),
    ) ||
    credits.reduce((sum, row) => sum + length(row.raw_text) + Number(row.type_id === 2), 0) > 2000
  )
    throw new Error('请补全简介片段及 @ 用户的有效 UID（最多 100 段、2000 字）');
  let dtime = null;
  if (scheduleAt) {
    const date = new Date(scheduleAt);
    dtime = date.getTime() / 1000;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(scheduleAt) ||
      !positiveId(dtime) ||
      dtime > 0xffffffff ||
      new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, scheduleAt.length) !==
        scheduleAt
    )
      throw new Error('请选择有效的定时发布时间');
    if (dtime * 1000 < now + 4 * 3600_000) throw new Error('定时发布必须晚于当前时间 4 小时');
  }
  return {...fields, dtime, is_only_self: isOnlySelf};
}
