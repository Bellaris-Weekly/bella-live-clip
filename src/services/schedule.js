import {SCHEDULE_MEMBERS, hasSchedule, roomIdFromUrl} from '../domain/records.js';
import {endOf, restartGroups, titlesAlike} from '../domain/sessions.js';

const CALENDAR = 'https://calendar.bk0717.us.ci';
const WINDOW = 30 * 60;
const CACHE_TIME = 60 * 60 * 1000;

function decodeText(value) {
  return value.replace(/\\([nN,;\\])/g, (_, escaped) => (/[nN]/.test(escaped) ? '\n' : escaped));
}

function eventStart(property, value) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) return null;
  const utc = Boolean(match[7]);
  if (!utc && !/(?:^|;)TZID="?Asia\/Shanghai"?(?:;|$)/i.test(property)) return null;
  const [, year, month, day, hour, minute, second] = match;
  const time = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  // Invalid source dates must not roll into an unrelated day's recording.
  if (new Date(time).toISOString().replace(/[-:]/g, '').slice(0, 15) !== value.slice(0, 15)) return null;
  return time / 1000 - (utc ? 0 : 8 * 3600);
}

function parseEvent(fields) {
  if (fields.STATUS?.value === 'CANCELLED') return null;
  const start = fields.DTSTART && eventStart(fields.DTSTART.property, fields.DTSTART.value);
  if (start == null) return null;
  const description = decodeText(fields.DESCRIPTION?.value || '');
  const [type, names] = description
    .split('\n')[0]
    .split('|')
    .map(part => part.trim());
  if (!type || !names) return null;
  // The source appends status notes after whitespace (e.g. end time or not started).
  const participantNames = names.split(/[、,，;；]/).map(name => name.trim().split(/\s+/)[0]);
  const participants = SCHEDULE_MEMBERS.filter(member => participantNames.includes(member.name));
  let room = null;
  const roomUrl = fields.URL?.value || description.match(/直播间[：:]\s*(https?:\/\/\S+)/)?.[1];
  try {
    if (roomUrl) room = roomIdFromUrl(roomUrl);
  } catch {
    return null;
  }
  if (!hasSchedule(room)) return null;
  return {
    uid: fields.UID?.value || null,
    start,
    room,
    type,
    participants,
    title: decodeText(fields.SUMMARY?.value || ''),
  };
}

export function parseCalendar(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  if (!lines.includes('BEGIN:VCALENDAR') || !lines.includes('END:VCALENDAR')) {
    throw new Error('日程没有返回有效的日历数据。');
  }
  const events = [];
  let fields = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      fields = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (fields) {
        const event = parseEvent(fields);
        if (event) events.push(event);
      }
      fields = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (!fields || colon < 0) continue;
    const property = line.slice(0, colon);
    fields[property.split(';')[0].toUpperCase()] = {property, value: line.slice(colon + 1)};
  }
  return events;
}

export function scheduleMonths(start) {
  return [
    ...new Set([-WINDOW, WINDOW].map(offset => new Date((start + offset + 8 * 3600) * 1000).toISOString().slice(0, 7))),
  ];
}

export function matchSchedule(record, events) {
  let nearest = null,
    distance = Infinity,
    ambiguous = false;
  const seen = new Set();
  for (const event of events) {
    if (event.uid && seen.has(event.uid)) continue;
    if (event.uid) seen.add(event.uid);
    const delta = Math.abs(record.start - event.start);
    if (Number(record.room) !== event.room || delta > WINDOW) continue;
    if (delta < distance) {
      nearest = event;
      distance = delta;
      ambiguous = false;
    } else if (delta === distance) ambiguous = true;
  }
  return ambiguous ? null : nearest;
}

// The library and submissions both place recordings through this. Restarts share a schedule event.
// Beyond the time window an event must fall during the stream, be claimed by no other, be the only
// such event and share words with the title: a wrong one would pick the wrong submission template.
export function matchSessions(records, calendars, now = Date.now() / 1000) {
  const byId = new Map();
  for (const event of [...calendars.values()].flat()) {
    const id = event.uid || Symbol();
    if (!byId.has(id)) byId.set(id, event);
  }
  const events = [...byId.values()],
    sessions = [];
  for (const parts of restartGroups(records, now)) {
    const complete = parts.every(part => scheduleMonths(part.start).every(month => calendars.has(month)));
    let session = null;
    for (const part of parts) {
      const own = complete ? matchSchedule(part, events) : null;
      // A title left over from the stream before: time and title both point at the next event.
      const next =
        own &&
        session?.event &&
        own !== session.event &&
        titlesAlike(part.title, own.title) &&
        !titlesAlike(part.title, session.event.title);
      if (!session || next) {
        session = {key: part.key, room: Number(part.room), title: part.title, start: part.start, complete, parts: []};
        sessions.push(session);
      }
      session.parts.push(part);
      session.end = Math.max(session.end ?? -Infinity, endOf(part, now));
      session.event ??= own;
    }
  }
  const claimed = new Set(sessions.map(session => session.event));
  const candidates = new Map();
  for (const session of sessions) {
    if (session.event || !session.complete) continue;
    const found = events.filter(
      event =>
        event.room === session.room &&
        event.start >= session.start &&
        event.start <= session.end &&
        !claimed.has(event) &&
        titlesAlike(session.title, event.title),
    );
    if (found.length === 1) candidates.set(session, found[0]);
  }
  const wanted = [...candidates.values()];
  for (const [session, event] of candidates)
    if (wanted.filter(other => other === event).length === 1) session.event = event;
  return new Map(sessions.flatMap(session => session.parts.map(part => [part, session])));
}

export class ScheduleService {
  constructor(request) {
    this.request = request;
    this.calendars = new Map();
    this.avatars = new Map();
  }

  async calendar(month, {signal, refresh}) {
    signal?.throwIfAborted();
    const cached = this.calendars.get(month);
    if (!refresh && cached && Date.now() - cached.time < CACHE_TIME) return cached.events;
    const {data} = await this.request(`${CALENDAR}/calendar-${month}.ics`, {auth: false, signal});
    signal?.throwIfAborted();
    const events = parseCalendar(data);
    this.calendars.set(month, {events, time: Date.now()});
    return events;
  }

  async avatar(member, signal) {
    signal?.throwIfAborted();
    if (this.avatars.has(member.id)) return this.avatars.get(member.id);
    try {
      const {data} = await this.request(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${member.uid}`, {
        auth: false,
        signal,
      });
      signal?.throwIfAborted();
      const response = JSON.parse(data);
      const face = response.code === 0 ? response.data?.info?.face : null;
      if (typeof face !== 'string' || !/^https?:\/\//.test(face)) return null;
      this.avatars.set(member.id, face);
      return face;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'AbortError') throw error;
      return null;
    }
  }

  async enrich(records, {signal, refresh = false} = {}) {
    signal?.throwIfAborted();
    const eligible = records.filter(record => hasSchedule(record.room));
    const months = [...new Set(eligible.flatMap(record => scheduleMonths(record.start)))];
    const calendars = new Map();
    let failed = false;
    await Promise.all(
      months.map(async month => {
        try {
          calendars.set(month, await this.calendar(month, {signal, refresh}));
        } catch (error) {
          signal?.throwIfAborted();
          if (error.name === 'AbortError') throw error;
          failed = true;
        }
      }),
    );
    signal?.throwIfAborted();
    const sessions = matchSessions(records, calendars);
    const participants = [
      ...new Map(
        [...sessions.values()]
          .map(session => session.event)
          .filter(Boolean)
          .flatMap(event => event.participants)
          .map(member => [member.id, member]),
      ).values(),
    ];
    const avatars = new Map(
      await Promise.all(participants.map(async member => [member.id, await this.avatar(member, signal)])),
    );
    signal?.throwIfAborted();
    return {
      failed,
      records: records.map(record => {
        const {key, event: match} = sessions.get(record);
        return {
          ...record,
          session: key,
          schedule: match
            ? {
                type: match.type,
                participants: match.participants.map(member => ({
                  id: member.id,
                  name: member.name,
                  color: member.color,
                  avatar: avatars.get(member.id),
                })),
              }
            : null,
        };
      }),
    };
  }
}
