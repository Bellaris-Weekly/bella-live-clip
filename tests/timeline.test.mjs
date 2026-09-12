import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitSelection,dragSelection} from '../src/timeline.js';
import {parsePlaylist,selectPlaylistRange} from '../src/hls.js';
test('松手适配完整选区，短片和两小时场次均保留上下文',()=>{for(const [a,b,total]of[[600,620,7200],[0,3,24],[21,24,24]]){const v=fitSelection(a,b,total);assert.ok(v.start<=a&&v.end>=b);assert.ok(v.start>=0&&v.end<=total);assert.ok(v.end-v.start<=(b-a)*1.12+.00001);}});
test('边界拖动以按下时视野计算，允许向外扩大',()=>{const s={start:600,end:620};const drag={type:'start',x:100,anchor:600,view:{start:598.8,end:621.2}};const n=dragSelection(drag,0,200,s,7200);assert.ok(n.start<drag.view.start);assert.equal(n.end,620);assert.ok(fitSelection(n.start,n.end,7200).end-fitSelection(n.start,n.end,7200).start>22.4);});
test('起点终点不交叉，鼠标起始偏移不产生跳动',()=>{for(const type of ['start','end']){const s={start:3,end:9},drag={type,x:73,anchor:s[type],view:{start:0,end:20}};assert.deepEqual(dragSelection(drag,73,100,s,20),s);const n=dragSelection(drag,type==='start'?200:-200,100,s,20);assert.ok(n.end>n.start);}});
test('整场清单仅下载选区相交分片，正确换算片内切点',()=>{const p=parsePlaylist('#EXTM3U\n#EXTINF:4,\na\n#EXTINF:4,\nb\n#EXTINF:4,\nc\n#EXTINF:4,\nd','https://example.com/list');for(const [start,end,count,trim]of[[5,10,2,1],[8,11,1,0]]){const plans=selectPlaylistRange(p,start,end);assert.equal(plans[0].segments.length,count);assert.equal(plans[0].start,trim);assert.equal(plans[0].end-plans[0].start,end-start);}});
test('跨断流选区保留独立输出，不吞掉后续分段',()=>{const p=parsePlaylist('#EXTM3U\n#EXTINF:4,\na\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nb','https://example.com/list');const plans=selectPlaylistRange(p,3,7);assert.equal(plans.length,2);assert.equal(plans[0].end-plans[0].start,1);assert.equal(plans[1].end-plans[1].start,3);});
