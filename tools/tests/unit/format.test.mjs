import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatTime,formatTimeRange,parseTime} from '../../../src/shared/format.js';

test('时间格式覆盖分钟、小时及毫秒',()=>{
 for(const [value,expected] of [[65.25,'00:01:05.250'],[3661.125,'01:01:01.125']])assert.equal(formatTime(value,true),expected);
});

test('成对时间共享小时列与位数，省略共同为零的小时且不改变秒边界',()=>{
 for(const [start,end,expected] of [
  [0,0,'00:00 — 00:00'],[10.704,80.602,'00:10 — 01:20'],
  [3226.704,4229.602,'00:53:46 — 01:10:29'],
  [3600,59.999,'01:00:00 — 00:00:59'],
  [3599.999,3599.999,'59:59 — 59:59'],
  [36000,3600,'10:00:00 — 01:00:00'],
  [360000,1,'100:00:00 — 000:00:01']
 ]){
  assert.equal(formatTimeRange(start,end),expected);
  assert.equal(formatTimeRange(start,end,' / '),expected.replace(' — ',' / '));
  const pair=formatTimeRange(start,end).split(' — ');assert.equal(pair[0].length,pair[1].length);
 }
});

test('手动输入的时间接受常见写法，其余返回空',()=>{
 for(const [text,expected] of [['1:02:03',3723],['02:03',123],['62.5',62.5],[' 0:05 ',5],['1：30',90],['00:00:01.25',1.25]])assert.equal(parseTime(text),expected);
 for(const text of ['','abc','1:','::','1:2:3:4','-5'])assert.equal(parseTime(text),null);
});
