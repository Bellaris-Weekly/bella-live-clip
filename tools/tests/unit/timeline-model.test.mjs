import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRange,zoomWindow,panWindow} from '../../../src/ui/timeline-model.js';

test('选区校验覆盖有效边界与同类非法数值',()=>{
 for(const range of [[5,4,10],[0,11,10],[-1,5,10],[0,Infinity,10],[NaN,5,10]])assert.throws(()=>validateRange(...range));
 for(const range of [[0,10,10],[1.25,3.75,10]])assert.deepEqual(validateRange(...range),{start:range[0],end:range[1]});
});

test('时间轴放大固定光标位置，覆盖长场与短片',()=>{
 for(const total of [7200,23.62]){
  const before={start:0,end:total};const after=zoomWindow(before,total,.5,.25);
  assert.equal(after.start+(after.end-after.start)*.25,total*.25);
  assert.ok(after.end<total);assert.equal(panWindow(after,total,total).end,total);
  assert.deepEqual(zoomWindow(after,total,100),before);
 }
});
