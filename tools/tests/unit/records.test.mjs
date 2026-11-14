import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBERS,
  recordFromReplay,
  recordFromRoom,
  roomFromHtml,
  roomFromBaseInfo,
  roomIdFromUrl,
} from '../../../src/domain/records.js';
import {avatarUrl} from '../../../src/danmaku/avatars.js';

test('直播编号原样保留，不经过浮点数', () => {
  for (const key of ['734979151883758285', '987654321098765432']) {
    const info = {live_status: 1, live_id_str: key, live_start_time: 100, uid: 1, room_id: 2, title: '示例'};
    const html = `<script>window.__NEPTUNE_IS_MY_WAIFU__=${JSON.stringify({roomInfoRes: {code: 0, data: {room_info: info}}})};</script>`;
    assert.equal(recordFromRoom(roomFromHtml(html), {name: '测试'}, 200).key, key);
  }
});

test('成员配置与回放转换保留 UID、直播间和姓名', () => {
  for (const [id, uid, room, name, color] of [
    ['xinyi', '3537115310721181', 30849777, '心宜', '#c93773'],
    ['sinuo', '3537115310721781', 30858592, '思诺', '#7252c0'],
  ]) {
    const member = MEMBERS.find(item => item.id === id);
    assert.deepEqual({...member, face: undefined}, {id, uid, room, name, color, face: undefined});
    assert.ok(avatarUrl(member.face));
    assert.deepEqual(
      recordFromReplay(
        {live_key: '987654321098765432', start_time: 100, end_time: 200, room_id: room, live_info: {title: '回放'}},
        member,
      ),
      {
        key: '987654321098765432',
        title: '回放',
        start: 100,
        end: 200,
        live: false,
        uid,
        member: name,
        room,
        poster: null,
      },
    );
  }
});

test('直播间链接只接受标准与 blanc 数字路径', () => {
  assert.equal(roomIdFromUrl('https://live.bilibili.com/22632424'), 22632424);
  assert.equal(roomIdFromUrl('https://live.bilibili.com/blanc/22632424?foo=1'), 22632424);
  assert.equal(roomIdFromUrl('https://www.bilibili.com/22632424'), null);
});

test('房间基础信息不把缺失场次数据当作未开播，不使用浮点场次编号', () => {
  for (const data of [null, {}, {by_room_ids: {}}, {by_room_ids: {30858592: {}}}]) {
    assert.throws(() => roomFromBaseInfo(data, 30858592), /暂未返回场次信息/);
  }
  // eslint-disable-next-line no-loss-of-precision -- the API really returns a number too large for JavaScript
  const info = {live_status: 1, live_time: '2026-10-31 19:50:47', live_id: 742106027349433696};
  const normalized = roomFromBaseInfo({by_room_ids: {30858592: info}}, 30858592);
  assert.equal(normalized.live_start_time, 1793447447);
  assert.throws(() => recordFromRoom(normalized, MEMBERS[4]), /直播场次编号不可用/);
  for (const time of [undefined, 0, 'invalid', '2026-10-31 19:50:47Z', '2026-99-31 19:50:47', '0000-00-00 00:00:00']) {
    assert.throws(
      () => roomFromBaseInfo({by_room_ids: {30858592: {...info, live_time: time}}}, 30858592),
      /直播开播时间不可用/,
    );
  }
});
