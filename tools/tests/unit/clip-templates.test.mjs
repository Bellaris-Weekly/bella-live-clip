import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromTemplate,
  matchingTemplate,
  liveValue,
  substitute,
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
    substitute('{clipper} {live}\n{live}', live, '$&署名'),
    '$&署名 2026.1.3  跨日直播 $&\n2026.1.3  跨日直播 $&',
  );
  assert.equal(substitute('{live}', '任意完整信息', '成员'), '任意完整信息');
  assert.equal(substitute('{live} {clipper}', '', ''), '{live} {clipper}');
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
  const request = submissionFields(draft, '直播', '编辑署名', Date.parse('2026-01-01'));
  assert.equal(request.title, '直播');
  assert.equal(request.desc, '编辑署名');
  assert.equal(request.desc_v2[0].raw_text, '编辑署名');
  assert.equal(request.human_type2, 100);
  assert.equal(request.mission_id, 99);
  assert.equal(request.dtime, new Date(payload.scheduleAt).getTime() / 1000);
  assert.equal(request.is_only_self, true);
  for (const key of ['targetSeason', 'liveParticipants', 'cover_url', 'scheduleAt', 'isOnlySelf'])
    assert.ok(!(key in request));
  assert.deepEqual(payload, original);
  assert.equal(draft.desc, '{clipper}');
  assert.equal(draftFromTemplate({copyright: 'invalid'}).copyright, null);
  assert.equal(draftFromTemplate({}).tid, 27);
});

test('other braces are ordinary text; only {live}/{clipper} are placeholders', () => {
  const draft = draftFromTemplate({title: '标题 {笑}', desc: '{(>_<)} {live} {clipper}', tags: ['tag']});
  const fields = submissionFields(draft, '场次', '成员');
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
    assert.throws(() => submissionFields(draft, live, clipper), /占位符/);
  }
  assert.throws(() => submissionFields(draft, '长'.repeat(81), '成员'), /80/);
  assert.throws(() => submissionFields(draft, '场次', '长'.repeat(2001)), /2000/);
  assert.throws(
    () => submissionFields({...draft, desc_v2: [{type_id: 1, raw_text: '{clipper}', biz_id: ''}]}, '场次', ''),
    /占位符/,
  );
});
