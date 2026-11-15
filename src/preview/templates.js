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
  draft.includeAntiCollision = flag(fields.includeAntiCollision);
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

const PLACEHOLDER = /\{(live_date|live_title|live|clipper)\}/g;
const liveDate = seconds => {
  const date = new Date((seconds + 8 * 3600) * 1000);
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
};
// As the studio does: 「【团播】A-SOUL夜谈: 冬日阳光方案」 is titled 「冬日阳光方案」.
const showTitle = title => title.match(/^【[^】]+】[^:：\n]*[:：]\s*(.+)$/s)?.[1].trim() || title;
// One live's {live} text, compared without the schedule kind prefix that early versions kept in it.
export function sameLive(a, b) {
  const key = text => {
    const [date, ...title] = (text || '').split('  ');
    return `${date}  ${showTitle(title.join('  '))}`.trim();
  };
  return Boolean(a && b) && key(a) === key(b);
}
export function liveValue(event) {
  return event ? `${liveDate(event.start)}  ${showTitle(event.title)}` : '';
}
// The studio's template variables. Without a schedule event, the date (YYYY-MM-DD) and title are typed in.
export function liveValues(event, {date = '', title = ''} = {}) {
  if (event) return {live: liveValue(event), live_date: liveDate(event.start), live_title: showTitle(event.title)};
  const live_date = date ? date.split('-').map(Number).join('.') : '';
  return {live: [live_date, title].filter(value => value.trim()).join('  '), live_date, live_title: title};
}

// Which variables the texts use, so only the inputs they need are shown (as in the studio).
export function neededVariables(...texts) {
  const uses = token => texts.some(text => text.includes(token));
  const live = uses('{live}');
  const date = live || uses('{live_date}'),
    title = live || uses('{live_title}');
  return {live: date || title, date, title, clipper: uses('{clipper}')};
}

export function substitute(value, values) {
  return value.replace(PLACEHOLDER, (placeholder, key) => values[key] || placeholder);
}

export function assertResolved(...values) {
  if (values.some(value => new RegExp(PLACEHOLDER.source).test(value)))
    throw new Error('标题或简介仍有未填写的占位符，请补全直播、二创署名或模板内容');
}

// Song collections list each song in 『』: fill the template's empty pair, else add a pair after the last.
// Mirrors the studio's append endpoint.
export const isCollection = title => title.includes('『』');
export function titleWithSong(title, song) {
  if (title.includes('『』')) return title.replace('『』', () => `『${song}』`);
  const end = title.lastIndexOf('』') + 1;
  return end ? `${title.slice(0, end)}『${song}』${title.slice(end)}` : title;
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

export function submissionFields(draft, values, now = Date.now()) {
  const {scheduleAt, isOnlySelf, includeAntiCollision, ...fields} = draft;
  fields.title = substitute(fields.title, values).trim();
  fields.desc = substitute(fields.desc, values);
  fields.source = substitute(fields.source, values);
  fields.dynamic = substitute(fields.dynamic || '', values);
  if (fields.desc_v2)
    fields.desc_v2 = fields.desc_v2.map(row => ({...row, raw_text: substitute(row.raw_text, values)}));
  // Every text the studio treats as a template field: staff roles and tags too.
  if (fields.staff) fields.staff = fields.staff.map(row => ({...row, title: substitute(row.title, values)}));
  fields.tags = fields.tags.map(tag => substitute(tag, values));
  assertResolved(
    fields.title,
    fields.desc,
    fields.source,
    fields.dynamic,
    ...(fields.desc_v2 || []).map(row => row.raw_text),
    ...(fields.staff || []).map(row => row.title),
    ...fields.tags,
  );
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
  // As in the studio, a template's time is a studio-held scheduled submission (submit_at) on the
  // Beijing wall clock, whatever the browser's time zone; Bilibili's own dtime is not used.
  let submit_at = null;
  if (scheduleAt) {
    submit_at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(scheduleAt)
      ? Date.parse(`${scheduleAt}+08:00`) / 1000
      : NaN;
    if (!Number.isInteger(submit_at) || submit_at <= 0 || submit_at > 0xffffffff)
      throw new Error('请选择有效的定时投稿时间');
    if (submit_at * 1000 <= now || submit_at * 1000 > now + 15 * 86400_000)
      throw new Error('请选择未来 15 天内的定时投稿时间');
  }
  // The values used, so the studio can resolve anything left and record what was used.
  const template_variables = Object.fromEntries(
    ['live', 'live_date', 'live_title', 'clipper'].map(key => [key, values[key] || '']),
  );
  return {...fields, dtime: null, submit_at, is_only_self: isOnlySelf, template_variables};
}
