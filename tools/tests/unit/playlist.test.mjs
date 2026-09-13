import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePlaylist,mapConcurrent,selectPlaylistRange} from '../../../src/media/playlist.js';

test('HLS 保留签名并按不连续时间线分组',()=>{
 const parsed=parsePlaylist('#EXTM3U\n#EXTINF:4,\na.m4s?token=a%2Bb&x=1\n#EXT-X-DISCONTINUITY\n#EXTINF:3,\nhttps://b.example/v.m4s?k=9','https://a.example/path/list.m3u8?old=1');
 assert.equal(parsed.groups.length,2);assert.equal(parsed.duration,7);assert.equal(parsed.groups[0].segments[0].url,'https://a.example/path/a.m4s?token=a%2Bb&x=1');
});

test('HLS 同一文件字节区间与初始化段变化',()=>{
 const parsed=parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:20@10\na.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:30\na.mp4\n#EXT-X-MAP:URI="other.mp4"\n#EXTINF:1,\nb.mp4','https://example.com/list');
 assert.equal(parsed.groups.length,2);assert.deepEqual(parsed.groups[0].segments[1].range,{offset:30,length:30});
 assert.throws(()=>parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:1,\na','https://example.com'));
});

test('并发下载保序且遵守并发上限',async()=>{
 let active=0,max=0;const result=await mapConcurrent([3,1,2,4,5],2,async value=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,value));active--;return value*2;});
 assert.equal(max,2);assert.deepEqual(result,[6,2,4,8,10]);
 const controller=new AbortController();controller.abort();await assert.rejects(mapConcurrent([1],2,async value=>value,controller.signal),{name:'AbortError'});
});

test('整场清单仅下载选区相交分片，正确换算片内切点',()=>{
 const parsed=parsePlaylist('#EXTM3U\n#EXTINF:4,\na\n#EXTINF:4,\nb\n#EXTINF:4,\nc\n#EXTINF:4,\nd','https://example.com/list');
 for(const [start,end,count,trim]of[[5,10,2,1],[8,11,1,0]]){const plans=selectPlaylistRange(parsed,start,end);assert.equal(plans[0].segments.length,count);assert.equal(plans[0].start,trim);assert.equal(plans[0].end-plans[0].start,end-start);}
});

test('跨断流选区保留独立输出，不吞掉后续分段',()=>{
 const parsed=parsePlaylist('#EXTM3U\n#EXTINF:4,\na\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nb','https://example.com/list');const plans=selectPlaylistRange(parsed,3,7);
 assert.equal(plans.length,2);assert.equal(plans[0].end-plans[0].start,1);assert.equal(plans[1].end-plans[1].start,3);
});
