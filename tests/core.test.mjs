import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, formatTime, validateRange, recordFromRoom, roomFromHtml, constrainRect, resizeRect, normalizeShortcut } from '../src/core.js';
import { parsePlaylist, mapConcurrent } from '../src/hls.js';
import { createRequest, BiliApi } from '../src/network.js';
test('时间解析覆盖不同长度与毫秒，拒绝非法范围',()=>{
 for(const [s,n] of [['1:02:03.456',3723.456],['12:34.5',754.5],['75.25',75.25]]) assert.equal(parseTime(s),n);
 for(const s of ['1:60','-1','1:99:00','abc']) assert.throws(()=>parseTime(s));
 assert.equal(formatTime(3661.125,true),'01:01:01.125'); assert.throws(()=>validateRange(5,4,10)); assert.throws(()=>validateRange(0,11,10));
});
test('直播编号原样保留，不经过浮点数',()=>{
 for(const key of ['734979151883758285','987654321098765432']) {
 const info={live_status:1,live_id_str:key,live_start_time:100,uid:1,room_id:2,title:'示例'};
 const html=`<script>window.__NEPTUNE_IS_MY_WAIFU__=${JSON.stringify({roomInfoRes:{code:0,data:{room_info:info}}})};</script>`;
 assert.equal(recordFromRoom(roomFromHtml(html),{name:'测试'},200).key,key);
 }
});
test('窗口在拖动和四角缩放后仍处于视口',()=>{
 const v={width:800,height:600}; const r=constrainRect({left:900,top:-20,width:510,height:780},v);
 assert.deepEqual(r,{left:280,top:10,width:510,height:580});
 const small=resizeRect(r,'nw',900,900,v); assert.equal(small.width,360); assert.equal(small.height,480);
 assert.equal(normalizeShortcut({code:'KeyZ'}),null);
});
test('HLS 保留签名并按不连续时间线分组',()=>{
 const p=parsePlaylist('#EXTM3U\n#EXTINF:4,\na.m4s?token=a%2Bb&x=1\n#EXT-X-DISCONTINUITY\n#EXTINF:3,\nhttps://b.example/v.m4s?k=9','https://a.example/path/list.m3u8?old=1');
 assert.equal(p.groups.length,2); assert.equal(p.duration,7); assert.equal(p.groups[0].segments[0].url,'https://a.example/path/a.m4s?token=a%2Bb&x=1');
});
test('HLS 同一文件字节区间与初始化段变化',()=>{
 const p=parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:20@10\na.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:30\na.mp4\n#EXT-X-MAP:URI="other.mp4"\n#EXTINF:1,\nb.mp4','https://example.com/list');
 assert.equal(p.groups.length,2);assert.deepEqual(p.groups[0].segments[1].range,{offset:30,length:30});
 assert.throws(()=>parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:1,\na','https://example.com'));
});
test('并发下载保序且遵守并发上限',async()=>{
 let active=0,max=0; const result=await mapConcurrent([3,1,2,4,5],2,async n=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,n));active--;return n*2;});
 assert.equal(max,2); assert.deepEqual(result,[6,2,4,8,10]);
 const c=new AbortController();c.abort();await assert.rejects(mapConcurrent([1],2,async n=>n,c.signal),{name:'AbortError'});
});
test('媒体匿名请求，账号请求只允许直播接口',async()=>{
 const seen=[]; const request=createRequest(options=>{seen.push(options);queueMicrotask(()=>options.onload({status:200,responseText:'ok'}));return {abort(){}};});
 await request('https://x.bilivideo.com/media'); await request('https://api.live.bilibili.com/test',{auth:true});
 assert.equal(seen[0].anonymous,true);assert.equal(seen[1].anonymous,false);
 await assert.rejects(request('https://example.com',{auth:true}));assert.equal(seen.length,2);
});
test('请求窄时间段，保留所有录像部分',async()=>{
 let url;const api=new BiliApi(async u=>{url=new URL(u);return {data:JSON.stringify({code:0,data:{list:[{start_time:120},{start_time:110}]}})};});
 const result=await api.clips({uid:1,key:'987654321098765432',start:100},10.1,20.2);
 assert.equal(url.searchParams.get('live_key'),'987654321098765432');assert.equal(url.searchParams.get('start_time'),'110');assert.equal(url.searchParams.get('end_time'),'121');assert.equal(result.length,2);assert.equal(result[0].start_time,110);
});

test('时间轴放大固定光标位置，覆盖长场与短片',async()=>{
 const {zoomWindow,panWindow}=await import('../src/core.js');
 for(const total of [7200,23.62]){
 const before={start:0,end:total};const after=zoomWindow(before,total,.5,.25);
 assert.equal(after.start+(after.end-after.start)*.25,total*.25);
 assert.ok(after.end<total);assert.equal(panWindow(after,total,total).end,total);
 assert.deepEqual(zoomWindow(after,total,100),before);
 }
});
