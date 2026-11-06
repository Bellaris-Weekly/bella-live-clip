import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MEMBERS} from '../../../src/domain/records.js';
import {createRequest, BiliApi} from '../../../src/services/bilibili.js';

test('媒体匿名请求，账号请求只允许直播接口', async () => {
  const seen = [];
  const request = createRequest(options => {
    seen.push(options);
    queueMicrotask(() => options.onload({status: 200, responseText: 'ok'}));
    return {abort() {}};
  });
  await request('https://x.bilivideo.com/media');
  await request('https://api.live.bilibili.com/test', {auth: true});
  assert.equal(seen[0].anonymous, true);
  assert.equal(seen[1].anonymous, false);
  await assert.rejects(request('https://example.com', {auth: true}));
  assert.equal(seen.length, 2);
});

test('请求窄时间段，保留所有录像部分', async () => {
  let url;
  const api = new BiliApi(async value => {
    url = new URL(value);
    return {data: JSON.stringify({code: 0, data: {list: [{start_time: 120}, {start_time: 110}]}})};
  });
  const result = await api.clips({uid: 1, key: '987654321098765432', start: 100}, 10.1, 20.2);
  assert.equal(url.searchParams.get('live_key'), '987654321098765432');
  assert.equal(url.searchParams.get('start_time'), '110');
  assert.equal(url.searchParams.get('end_time'), '121');
  assert.equal(result.length, 2);
  assert.equal(result[0].start_time, 110);
});

test('新增成员按配置查询回放并保留身份字段', async () => {
  for (const member of MEMBERS.filter(({id}) => ['xinyi', 'sinuo'].includes(id))) {
    let requested;
    const api = new BiliApi(async value => {
      requested = new URL(value);
      return {
        data: JSON.stringify({
          code: 0,
          data: {
            replay_info: [
              {
                live_key: '987654321098765432',
                start_time: 100,
                end_time: 200,
                room_id: member.room,
                live_info: {title: '回放'},
              },
            ],
            pagination: {total: 1},
          },
        }),
      };
    });
    const records = await api.history(member);
    assert.equal(requested.searchParams.get('live_uid'), member.uid);
    assert.equal(records[0].uid, member.uid);
    assert.equal(records[0].room, member.room);
    assert.equal(records[0].member, member.name);
  }
});

const activityRoom = {
  live_status: 1,
  live_id_str: '742106027349433696',
  live_time: '2026-10-31 19:50:47',
  uid: MEMBERS[4].uid,
  room_id: 30858592,
  title: '【3D出道周年纪念直播】执笔入梦',
};
const baseResponse = (info, room = info.room_id) => ({
  data: JSON.stringify({code: 0, data: {by_room_ids: {[room]: info}}}),
});
const htmlResponse = info => ({
  data: `<script>window.__NEPTUNE_IS_MY_WAIFU__=${JSON.stringify({roomInfoRes: {code: 0, data: {room_info: info}}})};</script>`,
});

test('room lookup works independently of page templates for every member and an unconfigured room', async () => {
  for (const member of [...MEMBERS, {room: 123456, name: '当前直播间'}]) {
    const calls = [];
    const signal = new AbortController().signal;
    const info = {...activityRoom, room_id: member.room, uid: member.uid || 123};
    const api = new BiliApi(async (url, options) => {
      calls.push({url: new URL(url), options});
      return baseResponse({...info, live_id: Number(info.live_id_str)});
    });
    const result = await api.current(member, signal, {allowOffline: true});
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url.origin, 'https://api.live.bilibili.com');
    assert.equal(call.url.pathname, '/xlive/web-room/v1/index/getRoomBaseInfo');
    assert.equal(call.url.searchParams.get('room_ids'), String(member.room));
    assert.equal(call.url.searchParams.get('req_biz'), 'web_room_componet');
    assert.equal(call.options.auth, true);
    assert.equal(call.options.signal, signal);
    assert.equal(result.key, '742106027349433696');
    assert.equal(result.start, 1793447447);
    assert.equal(result.room, member.room);
    assert.equal(result.uid, info.uid);
    assert.equal(result.member, member.name);
    assert.equal(result.live, true);
  }
});

test('offline and looping API results never trigger a page lookup', async () => {
  for (const live_status of [0, 2]) {
    let calls = 0;
    const api = new BiliApi(async () => {
      calls++;
      return baseResponse({...activityRoom, live_status, live_time: '0000-00-00 00:00:00'});
    });
    assert.equal(await api.current(MEMBERS[4], undefined, {allowOffline: true}), null);
    await assert.rejects(api.current(MEMBERS[4]), /当前没有直播/);
    assert.equal(calls, 2);
  }
});

test('failed, malformed or incomplete API responses use validated room HTML', async () => {
  const failures = [
    () => {
      throw new Error('HTTP 503');
    },
    () => ({data: 'not JSON'}),
    () => ({data: JSON.stringify({code: -352})}),
    () => baseResponse({...activityRoom, live_id_str: undefined}),
    () => baseResponse({...activityRoom, live_id_str: '0'}),
    () => baseResponse({...activityRoom, live_time: undefined}),
    () => baseResponse({...activityRoom, uid: undefined}),
    () => baseResponse({...activityRoom, room_id: 123}, 30858592),
  ];
  for (const failure of failures) {
    const calls = [];
    const signal = new AbortController().signal;
    const api = new BiliApi(async (url, options) => {
      calls.push({url, options});
      return url.startsWith('https://live.') ? htmlResponse({...activityRoom, live_start_time: 1793447447}) : failure();
    });
    const result = await api.current(MEMBERS[4], signal);
    assert.equal(result.key, activityRoom.live_id_str);
    assert.equal(result.start, 1793447447);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map(call => call.options.auth),
      [true, false, undefined],
    );
    assert.equal(calls[2].url, 'https://live.bilibili.com/30858592');
    assert.ok(calls.every(call => call.options.signal === signal));
  }
});

test('a signed-in room lookup rejected by the API is retried anonymously before the page', async () => {
  for (const live_status of [1, 2]) {
    const calls = [];
    const api = new BiliApi(async (url, options) => {
      calls.push({url, options});
      if (options.auth) return {data: JSON.stringify({code: -400, message: '请求错误'})};
      return live_status === 1
        ? baseResponse(activityRoom)
        : baseResponse({...activityRoom, live_status, live_time: '0000-00-00 00:00:00'});
    });
    const result = await api.current(MEMBERS[4], undefined, {allowOffline: true});
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url.startsWith('https://api.live.bilibili.com/')));
    if (live_status === 1) assert.equal(result.key, activityRoom.live_id_str);
    else assert.equal(result, null);
  }
  // Offline is an answer, not a failure: it must not fall through to the page.
  let page = 0;
  const offline = new BiliApi(async (url, options) => {
    if (url.startsWith('https://live.')) page++;
    if (options?.auth) return {data: JSON.stringify({code: -400})};
    return baseResponse({...activityRoom, live_status: 0, live_time: '0000-00-00 00:00:00'});
  });
  await assert.rejects(offline.current(MEMBERS[4]), /当前没有直播/);
  assert.equal(page, 0);
});

test('a failed room lookup keeps the first API error and records every fallback', async () => {
  const api = new BiliApi(async url =>
    url.startsWith('https://live.')
      ? {data: '<html></html>'}
      : {data: JSON.stringify({code: -400, message: '请求错误'})},
  );
  const error = await api.current(MEMBERS[4]).catch(error => error);
  assert.match(error.message, /B 站返回 -400：请求错误/);
  assert.equal(error.code, -400);
  assert.deepEqual(error.diagnostic, {endpoint: '/xlive/web-room/v1/index/getRoomBaseInfo', auth: true});
  assert.equal(error.suppressed.length, 2);
  assert.equal(error.suppressed[0].diagnostic.auth, false);
  assert.match(error.suppressed[1].message, /未找到直播场次信息/);
});

test('valid offline HTML remains usable when the API fails', async () => {
  for (const live_status of [0, 2]) {
    const api = new BiliApi(async url =>
      url.startsWith('https://live.') ? htmlResponse({...activityRoom, live_status}) : {data: 'unavailable'},
    );
    assert.equal(await api.current(MEMBERS[4], undefined, {allowOffline: true}), null);
    await assert.rejects(api.current(MEMBERS[4]), /当前没有直播/);
  }
});

test('activity HTML cannot hide the original API error and other rooms cannot supply the stream', async () => {
  for (const [response, message] of [
    [{code: -352, message: '-352'}, /B 站暂时限制了请求/],
    [{code: -101}, /请先在这个浏览器中登录/],
    [{code: 0, data: {by_room_ids: {}}}, /暂未返回场次信息/],
  ]) {
    for (const page of [
      {data: '<script>window.__BILIACT_EVAPAGEDATA__={};</script>'},
      htmlResponse({...activityRoom, live_start_time: 1793447447, room_id: 123}),
      htmlResponse({...activityRoom, live_start_time: 1793447447, live_id_str: undefined}),
    ]) {
      const api = new BiliApi(async url => (url.startsWith('https://live.') ? page : {data: JSON.stringify(response)}));
      await assert.rejects(api.current(MEMBERS[4], undefined, {allowOffline: true}), message);
    }
  }
});

test('short room IDs can resolve to their canonical room without changing the session', async () => {
  const api = new BiliApi(async () => baseResponse({...activityRoom, short_id: 123}, 123));
  const result = await api.current({room: 123, name: '当前直播间'});
  assert.equal(result.room, 30858592);
  assert.equal(result.key, activityRoom.live_id_str);
});

test('cancellation stops lookup even when a transport returns late data', async () => {
  for (const lateSuccess of [false, true]) {
    for (const abortAt of [1, 2]) {
      const controller = new AbortController();
      const error = new DOMException('已取消', 'AbortError');
      let calls = 0;
      const api = new BiliApi(async () => {
        calls++;
        if (calls === abortAt) {
          controller.abort(error);
          if (lateSuccess)
            return abortAt === 1
              ? baseResponse(activityRoom)
              : htmlResponse({...activityRoom, live_start_time: 1793447447});
          throw error;
        }
        throw new Error('network');
      });
      await assert.rejects(api.current(MEMBERS[4], controller.signal), e => e === error);
      assert.equal(calls, abortAt);
    }
  }
  const error = new DOMException('已取消', 'AbortError');
  let calls = 0;
  const api = new BiliApi(async () => {
    calls++;
    throw error;
  });
  await assert.rejects(api.current(MEMBERS[4]), e => e === error);
  assert.equal(calls, 1);
});
