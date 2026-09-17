import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileName} from '../../../src/media/file-name.js';

test('录像文件名包含北京时间与选区并清理跨平台非法字符',()=>{
 const record={member:'贝拉',title:'标题:测试/片段?',start:1757689200};
 const name=fileName(record,65,3661,'_第2段');
 assert.match(name,/^贝拉_\d{4}-\d{2}-\d{2}_标题_测试_片段__00-01-05-01-01-01_第2段\.mp4$/);
 assert.equal(/[<>:"/\\|?*]/.test(name),false);
});

test('投稿文件名保留当前分 P 与选区，不依赖直播日期',()=>{
 for(const record of [
  {kind:'submission',title:'视频:一',part:1,partTitle:''},
  {kind:'submission',title:'视频/二',part:3,partTitle:'第三段?内容'},
 ]){
  const name=fileName(record,1.25,12.5);
  assert.ok(name.endsWith('_00-00-01-00-00-12.mp4'));
  assert.equal(/[<>:"/\\|?*]/.test(name),false);
  assert.equal(name.includes('_P3_'),record.part===3);
  assert.equal(name.includes('undefined'),false);
 }
});
