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
