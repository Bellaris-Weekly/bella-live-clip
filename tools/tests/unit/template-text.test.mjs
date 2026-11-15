// Same cases as the studio's lib/templateText.test.ts, so both editors behave alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editTemplate,
  rawPosition,
  rawSelection,
  shownPosition,
  templateView,
} from '../../../src/preview/template-text.js';

const values = {live: '2026.11.11  烧不烧心大促？！', clipper: '挨兔'};
const source = '贝拉kira  {live}\n视频二创组——{clipper}';
const caret = position => ({start: position, end: position});

test('previews split stream variables and preserves them when editing fixed text', () => {
  const raw = '{live_title}｜{live_date}\n署名：{clipper}';
  const split = {...values, live_date: '2026.11.11', live_title: '烧不烧心大促？！'};
  const view = templateView(raw, split);
  assert.equal(view.text, '烧不烧心大促？！｜2026.11.11\n署名：挨兔');
  assert.equal(templateView(raw, split, caret(2)).text, '{live_title}｜2026.11.11\n署名：挨兔');
  assert.equal(
    templateView(raw, split, caret(raw.indexOf('{live_date}') + 2)).text,
    '烧不烧心大促？！｜{live_date}\n署名：挨兔',
  );
  const at = view.text.indexOf('署名');
  assert.equal(
    editTemplate(view, view.text.slice(0, at) + '新' + view.text.slice(at), caret(at + 1), caret(at)).raw,
    '{live_title}｜{live_date}\n新署名：{clipper}',
  );
  assert.equal(templateView('{live_date}/{live_title}', values).text, '{live_date}/{live_title}');
});

test('previews all variables when blurred or editing fixed text', () => {
  const expected = `贝拉kira  ${values.live}\n视频二创组——挨兔`;
  assert.equal(templateView(source, values).text, expected);
  assert.equal(templateView(source, values, caret(2)).text, expected);
  assert.equal(templateView(source, values, caret(source.indexOf('视频') + 2)).text, expected);
});

test('exposes only the variable under the caret, including just after a final closing brace', () => {
  assert.equal(
    templateView(source, values, caret(source.indexOf('{live}') + 2)).text,
    '贝拉kira  {live}\n视频二创组——挨兔',
  );
  assert.equal(
    templateView(source, values, caret(source.indexOf('{clipper}') + 2)).text,
    `贝拉kira  ${values.live}\n视频二创组——{clipper}`,
  );
  assert.equal(
    templateView(source, values, caret(source.length)).text,
    `贝拉kira  ${values.live}\n视频二创组——{clipper}`,
  );
});

test('keeps a variable resolved at its closing boundary when fixed text follows', () => {
  const raw = source + ' 出品';
  assert.equal(templateView(raw, values, caret(source.length)).text, `贝拉kira  ${values.live}\n视频二创组——挨兔 出品`);
  assert.equal(templateView(raw, values, caret(raw.length)).text, `贝拉kira  ${values.live}\n视频二创组——挨兔 出品`);
  assert.ok(templateView(raw, values, caret(source.length - 1)).text.includes('{clipper} 出品'));
});

test('maps positions across differently sized variables and repeated occurrences', () => {
  const raw = '{live}前{clipper}后{live}';
  const view = templateView(raw, values);
  for (const position of [0, 6, 7, 16, 17, raw.length])
    assert.equal(rawPosition(view, shownPosition(view, position)), position);
  const inside = values.live.length + 1 + 1;
  const cursor = rawSelection(view, caret(inside));
  assert.equal(templateView(raw, values, cursor).text, values.live + '前{clipper}后' + values.live);
});

test('preserves raw variables when editing fixed text before or after their rendered values', () => {
  const view = templateView(source, values);
  const beginning = editTemplate(view, '你好' + view.text, caret(2), caret(0));
  assert.equal(beginning.raw, '你好' + source);
  const at = view.text.indexOf('视频') + 2;
  const middle = editTemplate(view, view.text.slice(0, at) + '二次' + view.text.slice(at), caret(at + 2), caret(at));
  assert.equal(middle.raw, source.replace('视频', '视频二次'));
  const end = editTemplate(view, view.text + ' 出品', caret(view.text.length + 3), caret(view.text.length));
  assert.equal(end.raw, source + ' 出品');
});

test('uses actual caret positions to disambiguate deletion/insertion among repeated text', () => {
  const view = templateView('a{clipper}a', {...values, clipper: 'a'});
  assert.equal(editTemplate(view, 'aa', caret(0), caret(1)).raw, '{clipper}a');
  assert.equal(editTemplate(view, 'aa', caret(2), caret(3)).raw, 'a{clipper}');
  assert.equal(editTemplate(view, 'aaaa', caret(1), caret(0)).raw, 'aa{clipper}a');
});

test('edits the exposed variable text literally', () => {
  const at = source.indexOf('{clipper}') + 1;
  const view = templateView(source, values, caret(at));
  const shown = shownPosition(view, at);
  const change = editTemplate(
    view,
    view.text.slice(0, shown) + 'x' + view.text.slice(shown),
    caret(shown + 1),
    caret(shown),
  );
  assert.equal(change.raw, source.replace('{clipper}', '{xclipper}'));
});

test('supports whole-field replacement and selection spanning resolved variables', () => {
  const view = templateView(source, values);
  assert.equal(editTemplate(view, '新简介', caret(3), {start: 0, end: view.text.length}).raw, '新简介');
  const start = view.text.indexOf(values.live),
    end = view.text.indexOf('视频');
  const change = editTemplate(view, view.text.slice(0, start) + '新场次\n' + view.text.slice(end), caret(start + 4), {
    start,
    end,
  });
  assert.equal(change.raw, '贝拉kira  新场次\n视频二创组——{clipper}');
});

test('materializes only the edited variable if a browser edit bypasses selection events', () => {
  const view = templateView('前{clipper}后{live}', values);
  const change = editTemplate(view, view.text.replace('挨兔', '挨猫'), caret(3), {start: 2, end: 3});
  assert.equal(change.raw, '前挨猫后{live}');
});

test('keeps unresolved variables visible and replacement contents non-recursive', () => {
  assert.equal(templateView('{live}/{clipper}', {live: '', clipper: '  '}).text, '{live}/{clipper}');
  assert.equal(templateView('{live}/{clipper}', {live: '{clipper}', clipper: '$&'}).text, '{clipper}/$&');
});

for (const newline of ['\n', '\n\n', '\r\n'])
  test(`exposes a variable at the end of a line before ${JSON.stringify(newline)} and fixed text on later lines`, () => {
    const raw = '贝拉kira  {live}' + newline + '贝拉kira' + newline + '视频二创组——{clipper}';
    const end = raw.indexOf('{live}') + '{live}'.length;
    assert.equal(
      templateView(raw, values, caret(end)).text,
      '贝拉kira  {live}' + newline + '贝拉kira' + newline + '视频二创组——挨兔',
    );
    assert.equal(
      templateView(raw, values, caret(end + newline.length + 1)).text,
      '贝拉kira  ' + values.live + newline + '贝拉kira' + newline + '视频二创组——挨兔',
    );
  });

test('treats trailing spaces as line-end whitespace, but not fixed suffix text', () => {
  const raw = '贝拉kira  {live}  \n固定文字';
  const end = raw.indexOf('{live}') + '{live}'.length;
  for (const at of [end, end + 1, end + 2]) assert.equal(templateView(raw, values, caret(at)).text, raw);
  const withSuffix = raw.replace('  \n', '  直播回顾\n');
  assert.equal(templateView(withSuffix, values, caret(end)).text, withSuffix.replace('{live}', values.live));
});

test('a bound field in a shadow root shows values, exposes the variable under the caret and keeps the source', async () => {
  const {JSDOM} = await import('jsdom');
  const {bindTemplateField} = await import('../../../src/preview/template-text.js');
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {pretendToBeVisual: true});
  const root = dom.window.document.getElementById('host').attachShadow({mode: 'open'});
  root.innerHTML = '<textarea></textarea>';
  const element = root.querySelector('textarea');
  const live = {live: '2026.11.14  冬日阳光方案', clipper: '埃兔'};
  const changes = [];
  const field = bindTemplateField(element, () => live, {onChange: value => changes.push(value)});
  field.value = '{live}\n视频二创组——{clipper}';
  assert.equal(element.value, '2026.11.14  冬日阳光方案\n视频二创组——埃兔');
  element.focus();
  element.setSelectionRange(2, 2);
  element.dispatchEvent(new dom.window.Event('select'));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(element.value, '{live}\n视频二创组——埃兔');
  // Typing fixed text keeps both variables in the source.
  const end = element.value.length;
  element.setSelectionRange(end, end);
  element.dispatchEvent(new dom.window.Event('select'));
  await new Promise(resolve => queueMicrotask(resolve));
  element.value = element.value + '！';
  element.setSelectionRange(element.value.length, element.value.length);
  element.dispatchEvent(new dom.window.Event('input'));
  assert.equal(field.value, '{live}\n视频二创组——{clipper}！');
  assert.deepEqual(changes, ['{live}\n视频二创组——{clipper}！']);
  element.blur();
  assert.equal(element.value, '2026.11.14  冬日阳光方案\n视频二创组——埃兔！');
  dom.window.close();
});
