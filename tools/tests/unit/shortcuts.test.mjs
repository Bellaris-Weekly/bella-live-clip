import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeShortcut,matchesShortcut,isEditing} from '../../../src/ui/shortcuts.js';

test('快捷键要求功能修饰键并忽略单独修饰键',()=>{
 assert.equal(normalizeShortcut({code:'KeyZ'}),null);
 assert.equal(normalizeShortcut({code:'ShiftLeft',shiftKey:true}),null);
 assert.deepEqual(normalizeShortcut({code:'KeyZ',metaKey:true,shiftKey:true}),{
  code:'KeyZ',ctrlKey:false,altKey:false,shiftKey:true,metaKey:true,
 });
});

test('快捷键匹配排除重复、输入法和编辑目标',()=>{
 const shortcut={code:'KeyC',ctrlKey:false,altKey:true,shiftKey:true,metaKey:false};
 assert.equal(matchesShortcut({ ...shortcut,repeat:false,isComposing:false,defaultPrevented:false },shortcut),true);
 assert.equal(matchesShortcut({ ...shortcut,repeat:true,isComposing:false,defaultPrevented:false },shortcut),false);
 assert.equal(isEditing({target:{tagName:'TEXTAREA'}}),true);
 assert.equal(isEditing({target:{tagName:'DIV'},composedPath:()=>[{isContentEditable:true}]}),true);
});
