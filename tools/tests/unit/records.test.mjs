import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MEMBERS,recordFromReplay,recordFromRoom,roomFromHtml,roomIdFromUrl} from '../../../src/domain/records.js';

test('直播编号原样保留，不经过浮点数',()=>{
 for(const key of ['734979151883758285','987654321098765432']) {
  const info={live_status:1,live_id_str:key,live_start_time:100,uid:1,room_id:2,title:'示例'};
  const html=`<script>window.__NEPTUNE_IS_MY_WAIFU__=${JSON.stringify({roomInfoRes:{code:0,data:{room_info:info}}})};</script>`;
  assert.equal(recordFromRoom(roomFromHtml(html),{name:'测试'},200).key,key);
 }
});

test('成员配置与回放转换保留 UID、直播间和姓名',()=>{
 for(const [id,uid,room,name,color] of [
  ['xinyi','3537115310721181',30849777,'心宜','#c93773'],
  ['sinuo','3537115310721781',30858592,'思诺','#7252c0'],
 ]){
  const member=MEMBERS.find(item=>item.id===id);
  assert.deepEqual(member,{id,uid,room,name,color});
  assert.deepEqual(recordFromReplay({live_key:'987654321098765432',start_time:100,end_time:200,room_id:room,live_info:{title:'回放'}},member),{
   key:'987654321098765432',title:'回放',start:100,end:200,live:false,uid,member:name,room,
  });
 }
});

test('直播间链接只接受标准与 blanc 数字路径',()=>{
 assert.equal(roomIdFromUrl('https://live.bilibili.com/22632424'),22632424);
 assert.equal(roomIdFromUrl('https://live.bilibili.com/blanc/22632424?foo=1'),22632424);
 assert.equal(roomIdFromUrl('https://www.bilibili.com/22632424'),null);
});
