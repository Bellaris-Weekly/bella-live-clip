import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatTime,formatPlaybackTime,formatTimeRange} from '../../../src/shared/format.js';

test('时间格式覆盖分钟、小时及毫秒',()=>{
 for(const [value,expected] of [[65.25,'00:01:05.250'],[3661.125,'01:01:01.125']])assert.equal(formatTime(value,true),expected);
});

test('播放器时间省略毫秒和多余小时，覆盖分钟与小时边界',()=>{
 for(const [value,expected] of [[0,'0:00'],[59.999,'0:59'],[60,'1:00'],[1174.775,'19:34'],[3599.999,'59:59'],[3600,'1:00:00'],[4970,'1:22:50'],[36000,'10:00:00']])assert.equal(formatPlaybackTime(value),expected);
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
