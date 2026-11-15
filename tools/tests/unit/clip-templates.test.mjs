import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromTemplate,
  matchingTemplate,
  liveValue,
  liveValues,
  neededVariables,
  substitute,
  titleWithSong,
  submissionSchedule,
  submissionFields,
} from '../../../src/preview/templates.js';

const event = (ids, extra = {}) => ({participants: ids.map(id => ({id})), ...extra});

test('template auto-match requires equal participant sets regardless of order, with no fallback template', () => {
  const solo = {payload: {liveParticipants: ['bella']}},
    joint = {payload: {liveParticipants: ['diana', 'bella']}},
    all = {payload: {liveParticipants: ['bella', 'diana', 'eileen']}};
  const templates = [{payload: {}}, {payload: {liveParticipants: 'bella'}}, solo, joint, all];
  assert.equal(matchingTemplate(templates, event(['bella'])), solo);
  assert.equal(matchingTemplate(templates, event(['bella', 'diana'])), joint);
  assert.equal(matchingTemplate(templates, event(['eileen', 'bella', 'diana'])), all);
  assert.equal(matchingTemplate(templates, event(['bella', 'eileen'])), null);
  assert.equal(matchingTemplate(templates, event([])), null);
  assert.equal(matchingTemplate(templates, null), null);
});

test('live placeholder uses UTC+8 event date, unpadded month/day, two spaces and literal replacement values', () => {
  const live = liveValue({start: Date.parse('2026-01-02T16:01:00Z') / 1000, title: '跨日直播 $&'});
  assert.equal(live, '2026.1.3  跨日直播 $&');
  assert.equal(
    substitute('{clipper} {live}\n{live}', {live, clipper: '$&署名'}),
    '$&署名 2026.1.3  跨日直播 $&\n2026.1.3  跨日直播 $&',
  );
  assert.equal(substitute('{live}', {live: '任意完整信息', clipper: '成员'}), '任意完整信息');
  assert.equal(substitute('{live} {clipper}', {live: '', clipper: ''}), '{live} {clipper}');
});

test('schedule lookup matches the record independently and walks empty months for the last five started Bella events', async () => {
  const now = Date.parse('2026-11-01T01:00:00Z') / 1000;
  const record = {room: 7, start: Date.parse('2026-03-31T15:59:00Z') / 1000};
  const matched = event(['bella'], {...record, uid: 'record', title: '旧录像'});
  const recent = Array.from({length: 6}, (_, i) =>
    event(i % 2 ? ['bella', 'eileen'] : ['bella'], {
      uid: `event-${i}`,
      room: 7,
      title: `直播${i}`,
      start: now - (i + 1) * 86400,
      type: i % 2 ? '联动' : '其他',
    }),
  );
  const calls = [];
  const calendars = {
    '2026-03': [matched],
    '2026-04': [matched],
    '2026-11': [event(['bella'], {uid: 'future', start: now + 1})],
    '2026-10': [],
    '2026-09': [...recent, recent[0], event(['diana'], {uid: 'other', start: now})],
  };
  const result = await submissionSchedule(
    record,
    {
      calendar: async month => {
        calls.push(month);
        assert.ok(month in calendars, month);
        return calendars[month];
      },
    },
    new AbortController().signal,
    now,
  );
  assert.equal(result.matched, matched);
  assert.deepEqual(result.recent, recent.slice(0, 5));
  assert.deepEqual(calls, ['2026-03', '2026-04', '2026-11', '2026-10', '2026-09']);
  assert.equal(result.failed, false);
});

test('schedule includes start equal to now, reports unavailable calendars and honors cancellation', async () => {
  const now = Date.parse('2026-11-02T00:00:00Z') / 1000;
  const started = event(['bella'], {uid: 'now', room: 7, start: now, title: '刚开始'});
  const controller = new AbortController();
  const result = await submissionSchedule(
    {room: 8, start: now},
    {
      calendar: async month => {
        if (month === '2026-11') return [started];
        throw new Error('missing');
      },
    },
    controller.signal,
    now,
  );
  assert.equal(result.matched, null);
  assert.deepEqual(result.recent, [started]);
  assert.equal(result.failed, true);
  controller.abort();
  await assert.rejects(
    submissionSchedule(
      {room: 7, start: now},
      {
        calendar: async () => {
          throw new Error('offline');
        },
      },
      controller.signal,
      now,
    ),
    {name: 'AbortError'},
  );
});

test('studio template normalization and request mapping retain editable archive fields without collection or template metadata', () => {
  const payload = {
    title: '{live}',
    desc: '{clipper}',
    tags: ' 标签，标签,另一个 ',
    tid: '8',
    copyright: '2',
    no_reprint: true,
    source: '直播间',
    dynamic: '动态',
    human_type2: '100',
    mission_id: '99',
    topic_id: 2,
    open_subtitle: 'true',
    no_disturbance: 'false',
    watermark: 1,
    dolby: true,
    lossless_music: '1',
    charging_pay: false,
    up_selection_reply: true,
    up_close_reply: false,
    up_close_danmu: true,
    is_360: false,
    staff: [{mid: '7', title: '剪辑'}],
    desc_v2: [{type: 2, raw_text: '{clipper}', biz_id: 7}],
    scheduleAt: '2030-01-01T12:00:00',
    isOnlySelf: 1,
    targetSeason: '2:3',
    liveParticipants: ['bella'],
    cover_url: 'ignored',
  };
  const original = structuredClone(payload);
  const draft = draftFromTemplate(payload);
  assert.equal(draft.tid, 8);
  assert.equal(draft.copyright, 2);
  assert.equal(draft.no_reprint, false);
  assert.equal(draft.no_disturbance, false);
  assert.deepEqual(draft.tags, ['标签', '另一个']);
  assert.deepEqual(draft.staff, [{mid: 7, title: '剪辑'}]);
  assert.deepEqual(draft.desc_v2, [{type_id: 2, raw_text: '{clipper}', biz_id: '7'}]);
  const request = submissionFields(draft, {live: '直播', clipper: '编辑署名'}, Date.parse('2029-12-25T00:00:00Z'));
  assert.equal(request.title, '直播');
  assert.equal(request.desc, '编辑署名');
  assert.equal(request.desc_v2[0].raw_text, '编辑署名');
  assert.equal(request.human_type2, 100);
  assert.equal(request.mission_id, 99);
  // A template time is a studio-held submission on the Beijing clock, in any browser time zone.
  assert.equal(request.dtime, null);
  assert.equal(request.submit_at, Date.parse('2030-01-01T04:00:00Z') / 1000);
  assert.throws(
    () => submissionFields(draft, {live: '直播', clipper: '编辑署名'}, Date.parse('2029-11-01T00:00:00Z')),
    /15 天/,
  );
  assert.equal(request.is_only_self, true);
  for (const key of ['targetSeason', 'liveParticipants', 'cover_url', 'scheduleAt', 'isOnlySelf'])
    assert.ok(!(key in request));
  assert.deepEqual(payload, original);
  assert.equal(draft.desc, '{clipper}');
  assert.equal(draftFromTemplate({copyright: 'invalid'}).copyright, null);
  assert.equal(draftFromTemplate({}).tid, 27);
});

test('other braces are ordinary text; only studio variables are placeholders', () => {
  const draft = draftFromTemplate({title: '标题 {笑}', desc: '{(>_<)} {live} {clipper}', tags: ['tag']});
  const fields = submissionFields(draft, {live: '场次', clipper: '成员'});
  assert.equal(fields.title, '标题 {笑}');
  assert.equal(fields.desc, '{(>_<)} 场次 成员');
});

test('resolved title/description lengths and all remaining placeholders block submission', () => {
  const draft = draftFromTemplate({title: '{live}', desc: '{clipper}', tags: ['tag']});
  for (const [live, clipper] of [
    ['', '成员'],
    ['场次', ''],
    ['{clipper}', '成员'],
    ['场次', '{live}'],
  ]) {
    assert.throws(() => submissionFields(draft, {live: live, clipper: clipper}), /占位符/);
  }
  assert.throws(() => submissionFields(draft, {live: '长'.repeat(81), clipper: '成员'}), /80/);
  assert.throws(() => submissionFields(draft, {live: '场次', clipper: '长'.repeat(2001)}), /2000/);
  assert.throws(
    () =>
      submissionFields(
        {...draft, desc_v2: [{type_id: 1, raw_text: '{clipper}', biz_id: ''}]},
        {live: '场次', clipper: ''},
      ),
    /占位符/,
  );
});

test('split live variables follow the studio: date and title of the event, custom text stands in for the title', () => {
  const start = Date.parse('2026-11-01T12:00:00Z') / 1000;
  assert.deepEqual(liveValues({start, title: '我，同频，万圣节'}), {
    live: '2026.11.1  我，同频，万圣节',
    live_date: '2026.11.1',
    live_title: '我，同频，万圣节',
  });
  assert.deepEqual(liveValues(null, {date: '2026-11-01', title: '自填'}), {
    live: '2026.11.1  自填',
    live_date: '2026.11.1',
    live_title: '自填',
  });
  assert.deepEqual(liveValues(null, {title: '只有名字'}), {live: '只有名字', live_date: '', live_title: '只有名字'});
  assert.deepEqual(neededVariables('{live_title} 合集', '{clipper}'), {
    live: true,
    date: false,
    title: true,
    clipper: true,
  });
  assert.deepEqual(neededVariables('{live}'), {live: true, date: true, title: true, clipper: false});
  assert.deepEqual(neededVariables('纯文本'), {live: false, date: false, title: false, clipper: false});
  const draft = draftFromTemplate({
    title: '【A-SOUL】{live_title} 歌舞合集丨『』',
    desc: '{live}',
    tags: ['t'],
    includeAntiCollision: true,
  });
  assert.equal(draft.includeAntiCollision, true);
  const fields = submissionFields(draft, {...liveValues({start, title: '夜谈'}), clipper: ''});
  assert.equal(fields.title, '【A-SOUL】夜谈 歌舞合集丨『』');
  assert.ok(!('includeAntiCollision' in fields));
  assert.throws(() => submissionFields({...draft, title: '{live_date}'}, {live: 'x', clipper: ''}), /占位符/);
  // The reposted-from source takes variables too.
  const night = {...liveValues({start, title: '夜谈'}), clipper: ''};
  const reposted = submissionFields({...draft, copyright: 2, source: '{live}'}, night);
  assert.equal(reposted.source, night.live);
  assert.throws(() => submissionFields({...draft, copyright: 2, source: '{live}'}, {...night, live: ''}), /占位符/);
});

test('live titles drop the schedule kind prefix, as in the studio', () => {
  const start = Date.parse('2026-11-14T11:49:00Z') / 1000;
  const values = liveValues({start, title: '【团播】A-SOUL夜谈: 冬日阳光方案'});
  assert.equal(values.live_title, '冬日阳光方案');
  assert.equal(values.live, '2026.11.14  冬日阳光方案');
  assert.equal(liveValues({start, title: '普通标题：带冒号'}).live_title, '普通标题：带冒号');
});

test('each song gets its own 『』 in the collection title', () => {
  assert.equal(titleWithSong('合集丨『』', '青春纪念册'), '合集丨『青春纪念册』');
  assert.equal(titleWithSong('合集丨『A』', 'B'), '合集丨『A』『B』');
  assert.equal(titleWithSong('合集丨『』', '$&'), '合集丨『$&』');
});
