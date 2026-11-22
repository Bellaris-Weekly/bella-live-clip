import {SCHEDULE_MEMBERS} from './records.js';

// One stream can go off and on again, each time under a new live key. Real restarts took up to
// 2.2 minutes, while two different streams left under one title were only 3.2 minutes apart.
const RESTART_GAP = 3 * 60;

export function endOf(record, now) {
  const end = record.end ?? record.start;
  return record.live ? Math.max(end, now) : end;
}

// Same room, same title, off air for no longer than a restart takes. Each group is oldest first.
export function restartGroups(records, now = Date.now() / 1000) {
  const groups = [],
    latest = new Map();
  for (const record of [...records].sort((a, b) => a.start - b.start)) {
    const id = `${record.room}\n${record.title}`;
    let group = latest.get(id);
    if (!group || record.start - group.end > RESTART_GAP) {
      group = {parts: [], end: -Infinity};
      latest.set(id, group);
      groups.push(group);
    }
    group.parts.push(record);
    group.end = Math.max(group.end, endOf(record, now));
  }
  return groups.map(group => group.parts);
}

// 「【团播】A-SOUL夜谈: 冬日阳光方案」 is titled 「冬日阳光方案」, as in the studio.
export const scheduleTitle = title => title.match(/^【[^】]+】[^:：\n]*[:：]\s*(.+)$/s)?.[1].trim() || title;

const COMMON_WORDS = new RegExp(
  ['突击', '单播', '双播', '团播', '直播', '3d', ...SCHEDULE_MEMBERS.map(m => m.name)].join('|'),
  'g',
);
const keywords = title =>
  title
    .toLowerCase()
    .replace(COMMON_WORDS, ' ')
    .split(/[^\p{L}\p{N}]+/u);
// Three characters in a row, other than the words nearly every title has.
export function titlesAlike(title = '', scheduled = '') {
  const targets = keywords(scheduleTitle(scheduled));
  return keywords(title).some(word => {
    for (let i = 0; i + 3 <= word.length; i++) {
      const piece = word.slice(i, i + 3);
      if (targets.some(target => target.includes(piece))) return true;
    }
    return false;
  });
}

// What the library shows as one card, in the order of the list it was given. Until the schedule
// has placed every record in a session, restarts alone decide.
export function librarySessions(records, now = Date.now() / 1000) {
  let groups;
  if (records.every(record => record.session)) {
    const byKey = new Map();
    for (const record of records) byKey.set(record.session, [...(byKey.get(record.session) || []), record]);
    groups = [...byKey.values()].map(parts => parts.sort((a, b) => a.start - b.start));
  } else groups = restartGroups(records, now);
  const position = parts => Math.min(...parts.map(part => records.indexOf(part)));
  return groups
    .sort((a, b) => position(a) - position(b))
    .map(parts => {
      let length = 0,
        until = -Infinity;
      for (const part of parts) {
        length += Math.max(0, part.end - Math.max(part.start, until));
        until = Math.max(until, part.end);
      }
      // A card opens the stream on air, or else its longest recording.
      const main =
        parts.findLast(part => part.live) ||
        parts.reduce((best, part) => (part.end - part.start > best.end - best.start ? part : best));
      return {parts, main, start: parts[0].start, length};
    });
}
