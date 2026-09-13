import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileName} from '../../../src/media/file-name.js';

test('录像文件名包含北京时间与选区并清理跨平台非法字符',()=>{
 const record={member:'贝拉',title:'标题:测试/片段?',start:1757689200};
 const name=fileName(record,65,3661,'_第2段');
 assert.match(name,/^贝拉_\d{4}-\d{2}-\d{2}_标题_测试_片段__00-01-05-01-01-01_第2段\.mp4$/);
 assert.equal(/[<>:"/\\|?*]/.test(name),false);
});
