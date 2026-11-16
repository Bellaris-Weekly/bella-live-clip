// Kept in step with bellaris-studio frontend/src/lib/schedule.ts.
const BEIJING_OFFSET = 8 * 3600;
const padTime = value => String(value).padStart(2, '0');
function beijingSchedule(seconds, withSeconds = false) {
  return new Date((seconds + BEIJING_OFFSET) * 1e3).toISOString().slice(0, withSeconds ? 19 : 16);
}
function parseSchedule(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const timestamp = Date.parse(`${value}+08:00`) / 1e3;
  if (!Number.isInteger(timestamp) || timestamp <= 0 || timestamp > 4294967295) return null;
  return beijingSchedule(timestamp, value.length === 19) === value ? timestamp : null;
}
function scheduleLabel(value, now = Date.now() / 1e3) {
  const timestamp = parseSchedule(value);
  if (timestamp === null) return value ? '请选择有效时间' : '选择投稿时间';
  const today = beijingSchedule(now).slice(0, 10);
  const tomorrow = beijingSchedule(now + 86400).slice(0, 10);
  const [day, time] = value.split('T');
  const [year, month, date] = day.split('-').map(Number);
  const prefix = day === today ? '今天' : day === tomorrow ? '明天' : `${month}月${date}日`;
  const yearPrefix = year !== Number(today.slice(0, 4)) ? `${year}年` : '';
  const clock = time.length === 8 && time.endsWith(':00') ? time.slice(0, 5) : time;
  return `${yearPrefix}${prefix} ${clock}`;
}
const VIDEO_TIME_PRESETS = [
  {label: '10 分钟', minutes: 10},
  {label: '20 分钟', minutes: 20},
  {label: '30 分钟', minutes: 30},
  {label: '07:17', time: '07:17'},
  {label: '11:30', time: '11:30'},
  {label: '12:00', time: '12:00'},
];
function videoTimePresets(now = Date.now() / 1e3) {
  const today = beijingSchedule(now).slice(0, 10);
  const tomorrow = beijingSchedule(now + 86400).slice(0, 10);
  return VIDEO_TIME_PRESETS.map(preset => ({
    label: preset.label,
    value:
      'minutes' in preset
        ? beijingSchedule(Math.floor(now) + preset.minutes * 60, true)
        : `${parseSchedule(`${today}T${preset.time}`) > now ? today : tomorrow}T${preset.time}`,
  }));
}
function calendarDays(month) {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  return Array.from({length: 42}, (_, index) =>
    new Date(first.getTime() + (index - offset) * 864e5).toISOString().slice(0, 10),
  );
}
function shiftMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}
export {
  VIDEO_TIME_PRESETS,
  beijingSchedule,
  calendarDays,
  padTime,
  parseSchedule,
  scheduleLabel,
  shiftMonth,
  videoTimePresets,
};
