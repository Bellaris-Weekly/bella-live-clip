import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitSelection,dragSelection} from '../../../src/ui/timeline.js';

test('松手适配完整选区，短片和两小时场次均保留上下文',()=>{for(const [start,end,total]of[[600,620,7200],[0,3,24],[21,24,24]]){const view=fitSelection(start,end,total);assert.ok(view.start<=start&&view.end>=end);assert.ok(view.start>=0&&view.end<=total);assert.ok(view.end-view.start<=(end-start)*1.12+.00001);}});
test('边界拖动以按下时视野计算，允许向外扩大',()=>{const selection={start:600,end:620};const drag={type:'start',x:100,anchor:600,view:{start:598.8,end:621.2}};const next=dragSelection(drag,0,200,selection,7200);assert.ok(next.start<drag.view.start);assert.equal(next.end,620);assert.ok(fitSelection(next.start,next.end,7200).end-fitSelection(next.start,next.end,7200).start>22.4);});
test('起点终点不交叉，鼠标起始偏移不产生跳动',()=>{for(const type of ['start','end']){const selection={start:3,end:9},drag={type,x:73,anchor:selection[type],view:{start:0,end:20}};assert.deepEqual(dragSelection(drag,73,100,selection,20),selection);const next=dragSelection(drag,type==='start'?200:-200,100,selection,20);assert.ok(next.end>next.start);}});
