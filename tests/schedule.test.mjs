import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, matchSchedule, scheduleMonths, ScheduleService } from '../src/schedule.js';

const calendar = (...events) => ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n');
const event = ({ start = '20260605T120000Z', room = 22632424, description = '双播 | 贝拉、乃琳',
  property = 'DTSTART', uid = '', extra = '', url = true } = {}) => [
  'BEGIN:VEVENT', 'SUMMARY:原标题以外的日程标题', `${property}:${start}`, 'DURATION:PT1H',
  `DESCRIPTION:${description}\\n\\n直播间：https://live.bilibili.com/${room}`,
  ...(url ? [`URL:https://live.bilibili.com/${room}`] : []), ...(uid ? [`UID:${uid}`] : []),
  extra, 'END:VEVENT',
].join('\r\n');
const record = (time = '2026-06-05T12:02:00Z', room = 22632424) => ({
  key: time, room, start: Date.parse(time) / 1000, end: Date.parse(time) / 1000 + 7200, title: '录像原标题',
});
const face = uid => JSON.stringify({ code: 0, data: { info: { face: `https://i0.hdslb.com/${uid}.jpg` } } });
function requester(ics = calendar(event())) {
  const calls = [];
  return { calls, request: async (url, options) => {
    calls.push({ url, options });
    return { data: url.endsWith('.ics') ? ics : face(new URL(url).searchParams.get('uid')) };
  } };
}

test('parses folded Chinese descriptions, escaped delimiters and description room URLs', () => {
  const events = parseCalendar(calendar(
    event({ url: false, description: '双播 | 贝拉、\r\n 乃琳 结束于 14:05' }).replace('22632424', '22632\r\n 424'),
    event({ room: 22637261, description: '联动\\;特别场 | 嘉然\\,贝拉\\n补充：C:\\\\live' }),
    event({ room: 22637261, description: '突击 | 嘉然  未开播' }),
    event({ room: 22625027, description: '特别 | 乃琳  新状态说明' }),
  ));
  assert.equal(events.length, 4);
  assert.equal(events[0].room, 22632424);
  assert.deepEqual(events[0].participants.map(member => member.id), ['bella', 'eileen']);
  assert.equal(events[1].type, '联动;特别场');
  assert.deepEqual(events[1].participants.map(member => member.id), ['bella', 'diana']);
  assert.deepEqual(events[2].participants.map(member => member.id), ['diana']);
  assert.deepEqual(events[3].participants.map(member => member.id), ['eileen']);
});

test('normalizes UTC and Shanghai time and rejects unsupported or invalid dates and cancelled events', () => {
  const events = parseCalendar(calendar(event(),
    event({ property: 'DTSTART;TZID=Asia/Shanghai', start: '20260605T200000' }),
    event({ property: 'DTSTART;TZID="Asia/Shanghai"', start: '20260605T200000' }),
    event({ property: 'DTSTART;TZID=America/New_York', start: '20260605T200000' }),
    event({ start: '20260230T120000Z' }), event({ start: '20260605' }),
    event({ extra: 'STATUS:CANCELLED' }),
  ));
  assert.equal(events.length, 3);
  assert.ok(events.every(item => item.start === Date.parse('2026-06-05T12:00:00Z') / 1000));
});

test('matches unique closest same-room event, including multiple shows on one day', () => {
  const events = parseCalendar(calendar(event({ start: '20260605T040000Z' }), event(),
    event({ start: '20260605T120200Z', room: 22637261 }),
    event({ start: '20260605T123000Z', description: '单播 | 贝拉' })));
  assert.equal(matchSchedule(record(), events).type, '双播');
  assert.equal(matchSchedule(record('2026-06-05T12:28:00Z'), events).type, '单播');
  assert.equal(matchSchedule(record('2026-06-05T10:00:00Z'), events), null);
  assert.equal(matchSchedule(record('2026-06-05T11:30:00Z'), events).type, '双播');
  assert.equal(matchSchedule(record('2026-06-05T12:15:00Z'), events), null);
  assert.equal(matchSchedule(record(), [events[1], events[1]]), null);
  assert.equal(matchSchedule(record(), [{ ...events[1], uid: 'same' }, { ...events[1], uid: 'same' }]).type, '双播');
});

test('month requests use Beijing boundaries including adjacent year, independent of host timezone', () => {
  assert.deepEqual(scheduleMonths(Date.parse('2026-06-01T00:10:00+08:00') / 1000), ['2026-05', '2026-06']);
  assert.deepEqual(scheduleMonths(Date.parse('2026-12-31T23:50:00+08:00') / 1000), ['2026-12', '2027-01']);
  assert.deepEqual(scheduleMonths(Date.parse('2026-06-05T23:50:00Z') / 1000), ['2026-06']);
});

test('enrich copies recordings, preserves original metadata, and fetches avatars anonymously once', async () => {
  const mock = requester();
  const service = new ScheduleService(mock.request);
  const original = record();
  const result = await service.enrich([original, { ...original, key: 'second' }]);
  assert.equal(result.failed, false);
  assert.notEqual(result.records[0], original);
  assert.equal(original.schedule, undefined);
  assert.deepEqual({ ...result.records[0], schedule: undefined }, { ...original, schedule: undefined });
  assert.equal(result.records[0].end - result.records[0].start, 7200);
  assert.deepEqual(result.records[0].schedule.participants.map(item => Object.keys(item)),
    [['id', 'name', 'color', 'avatar'], ['id', 'name', 'color', 'avatar']]);
  assert.match(result.records[0].schedule.participants[0].avatar, /672353429\.jpg$/);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every(call => call.options.auth === false));
  await service.enrich([original]);
  assert.equal(mock.calls.length, 3);
  await service.enrich([original], { refresh: true });
  assert.equal(mock.calls.length, 4);
});

test('successful calendars expire after one hour', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-05T12:00:00Z') });
  const mock = requester();
  const service = new ScheduleService(mock.request);
  await service.enrich([record()]);
  t.mock.timers.tick(3599999);
  await service.enrich([record()]);
  assert.equal(mock.calls.filter(call => call.url.endsWith('.ics')).length, 1);
  t.mock.timers.tick(1);
  await service.enrich([record()]);
  assert.equal(mock.calls.filter(call => call.url.endsWith('.ics')).length, 2);
});

test('unsupported rooms and empty record lists make no requests; unmatched schedules stay null', async () => {
  const mock = requester(calendar(event({ description: '' })));
  const service = new ScheduleService(mock.request);
  assert.deepEqual(await service.enrich([]), { records: [], failed: false });
  assert.ok((await service.enrich([record(undefined, 30849777), record(undefined, 30858592)]))
    .records.every(item => item.schedule === null));
  assert.equal(mock.calls.length, 0);
  assert.equal((await service.enrich([record()])).records[0].schedule, null);
  assert.equal(mock.calls.length, 1);
});

test('cross-month recordings need complete candidate sets and can match prior-month events', async () => {
  let fail = true;
  const service = new ScheduleService(async url => {
    if (url.includes('2027-01')) {
      if (fail) throw new Error('unavailable');
      return { data: calendar() };
    }
    return { data: url.endsWith('.ics') ? calendar(event({ start: '20261231T155000Z' })) : face('test') };
  });
  const input = [record('2027-01-01T00:05:00+08:00')];
  const first = await service.enrich(input);
  assert.equal(first.failed, true);
  assert.equal(first.records[0].schedule, null);
  fail = false;
  assert.equal((await service.enrich(input)).records[0].schedule.type, '双播');
});

test('network and malformed calendar failures are retried; avatar failures preserve schedule and retry', async () => {
  for (const failure of [() => { throw new Error('offline'); }, () => ({ data: '<html>error</html>' })]) {
    let failedOnce = false;
    const service = new ScheduleService(async url => {
      if (!failedOnce) { failedOnce = true; return failure(); }
      return { data: url.endsWith('.ics') ? calendar(event()) : face('test') };
    });
    assert.equal((await service.enrich([record()])).failed, true);
    assert.equal((await service.enrich([record()])).records[0].schedule.type, '双播');
  }
  let badFace = true;
  const service = new ScheduleService(async url => ({ data: url.endsWith('.ics')
    ? calendar(event()) : badFace ? '{"code":-1}' : face('test') }));
  const result = await service.enrich([record()]);
  assert.equal(result.failed, false);
  assert.ok(result.records[0].schedule.participants.every(member => member.avatar === null));
  badFace = false;
  assert.ok((await service.enrich([record()])).records[0].schedule.participants.every(member => member.avatar));
});

test('cancellation is propagated before work, during calendars, and during avatars', async () => {
  for (const stage of ['before', 'calendar', 'avatar']) {
    const controller = new AbortController();
    let calls = 0;
    const service = new ScheduleService(async (url, { signal }) => {
      calls++;
      assert.equal(signal, controller.signal);
      if (stage === 'calendar' || (stage === 'avatar' && !url.endsWith('.ics'))) controller.abort();
      return { data: url.endsWith('.ics') ? calendar(event()) : face('test') };
    });
    if (stage === 'before') controller.abort();
    await assert.rejects(service.enrich([record()], { signal: controller.signal }), { name: 'AbortError' });
    if (stage === 'before') assert.equal(calls, 0);
  }
});
