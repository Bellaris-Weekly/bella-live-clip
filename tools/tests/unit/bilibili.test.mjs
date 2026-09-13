import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MEMBERS} from '../../../src/domain/records.js';
import {createRequest,BiliApi} from '../../../src/services/bilibili.js';

test('媒体匿名请求，账号请求只允许直播接口',async()=>{
 const seen=[];const request=createRequest(options=>{seen.push(options);queueMicrotask(()=>options.onload({status:200,responseText:'ok'}));return {abort(){}};});
 await request('https://x.bilivideo.com/media');await request('https://api.live.bilibili.com/test',{auth:true});
 assert.equal(seen[0].anonymous,true);assert.equal(seen[1].anonymous,false);
 await assert.rejects(request('https://example.com',{auth:true}));assert.equal(seen.length,2);
});

test('请求窄时间段，保留所有录像部分',async()=>{
 let url;const api=new BiliApi(async value=>{url=new URL(value);return {data:JSON.stringify({code:0,data:{list:[{start_time:120},{start_time:110}]}})};});
 const result=await api.clips({uid:1,key:'987654321098765432',start:100},10.1,20.2);
 assert.equal(url.searchParams.get('live_key'),'987654321098765432');assert.equal(url.searchParams.get('start_time'),'110');assert.equal(url.searchParams.get('end_time'),'121');assert.equal(result.length,2);assert.equal(result[0].start_time,110);
});

test('新增成员按配置查询回放并保留身份字段',async()=>{
 for(const member of MEMBERS.filter(({id})=>['xinyi','sinuo'].includes(id))){
  let requested;
  const api=new BiliApi(async value=>{requested=new URL(value);return {data:JSON.stringify({code:0,data:{replay_info:[{live_key:'987654321098765432',start_time:100,end_time:200,room_id:member.room,live_info:{title:'回放'}}],pagination:{total:1}}})};});
  const records=await api.history(member);
  assert.equal(requested.searchParams.get('live_uid'),member.uid);
  assert.equal(records[0].uid,member.uid);assert.equal(records[0].room,member.room);assert.equal(records[0].member,member.name);
 }
});

test('optional current lookup treats offline and looping rooms as absent while direct entry explains absence',async()=>{
 for(const live_status of [0,2]){
  const api=new BiliApi(async()=>({data:`<script>window.__NEPTUNE_IS_MY_WAIFU__=${JSON.stringify({roomInfoRes:{code:0,data:{room_info:{live_status}}}})};</script>`}));
  assert.equal(await api.current(MEMBERS[0],undefined,{allowOffline:true}),null);
  await assert.rejects(api.current(MEMBERS[0]),/当前没有直播/);
 }
});

test('current lookup uses each member room and preserves full live identity',async()=>{
 for(const member of [MEMBERS[0],MEMBERS[4]]){
  const info={live_status:1,live_id_str:'987654321098765432',live_start_time:100,uid:member.uid,room_id:member.room,title:'当前直播'};
  const api=new BiliApi(async url=>{assert.equal(url,`https://live.bilibili.com/${member.room}`);return {data:`<script>window.__NEPTUNE_IS_MY_WAIFU__=${JSON.stringify({roomInfoRes:{code:0,data:{room_info:info}}})};</script>`};});
  const result=await api.current(member,undefined,{allowOffline:true});
  assert.equal(result.key,info.live_id_str);assert.equal(result.member,member.name);assert.equal(result.room,member.room);assert.equal(result.live,true);
 }
 const broken=new BiliApi(async()=>({data:'unavailable'}));
 await assert.rejects(broken.current(MEMBERS[0],undefined,{allowOffline:true}),/未找到直播场次信息/);
});
