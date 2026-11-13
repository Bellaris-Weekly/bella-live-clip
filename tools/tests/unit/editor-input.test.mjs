import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {bindEditorInput} from '../../../src/app/editor-input.js';

function fixture(t, whole = false) {
  const dom = new JSDOM(
    '<!doctype html><div id="editPage"><div id="timeline" tabindex="0"></div><button id="startHandle" data-handle="start"></button><button id="endHandle" data-handle="end"></button><button id="markStart"></button><input id="selectionStart"><input id="selectionEnd"></div>',
  );
  t.after(() => dom.window.close());
  const root = dom.window.document;
  const calls = [];
  bindEditorInput({
    root,
    timeline: {
      handleKeyDown() {},
      getSelection: () => ({start: 20, end: 60}),
      setSelection: () => calls.push('selection'),
    },
    status() {},
    getPlayer: () => ({position: () => 40}),
    togglePlayback: () => calls.push('playback'),
    isActive: () => true,
    isWhole: () => whole,
  });
  return {
    calls,
    key(target, key, extra = {}) {
      const event = new dom.window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...extra});
      root.getElementById(target).dispatchEvent(event);
      return event;
    },
  };
}

test('空格在时间轴和出入点上播放暂停，保留普通按钮及输入框的原生行为', t => {
  const f = fixture(t);
  for (const target of ['timeline', 'startHandle', 'endHandle']) {
    assert.equal(f.key(target, ' ').defaultPrevented, true);
  }
  assert.deepEqual(f.calls, ['playback', 'playback', 'playback']);
  for (const target of ['markStart', 'selectionStart']) assert.equal(f.key(target, ' ').defaultPrevented, false);
  assert.equal(f.calls.length, 3);
});

test('长按空格只切换一次，输入法和系统组合键不触发编辑器动作', t => {
  const f = fixture(t);
  f.key('timeline', ' ');
  assert.equal(f.key('timeline', ' ', {repeat: true}).defaultPrevented, true);
  for (const key of [' ', 'i', 'o']) {
    for (const extra of [{isComposing: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}]) {
      assert.equal(f.key('timeline', key, extra).defaultPrevented, false);
    }
  }
  assert.deepEqual(f.calls, ['playback']);
});

test('整场模式保留空格播放暂停，但禁止快捷键改变出入点', t => {
  const f = fixture(t, true);
  assert.equal(f.key('timeline', ' ').defaultPrevented, true);
  for (const key of ['i', 'o']) assert.equal(f.key('timeline', key).defaultPrevented, false);
  assert.deepEqual(f.calls, ['playback']);
});
