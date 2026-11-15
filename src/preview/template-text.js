// Ported from the studio's lib/templateText.ts: a text field shows its template variables resolved,
// except the one being edited, and edits to the shown text map back onto the template source.
const PATTERN = /\{(live_date|live_title|live|clipper)\}/g;

/** Show a variable's source while editing it or the whitespace just after it at the end of its line. */
export function templateView(raw, values, selection = null) {
  let text = '',
    offset = 0;
  const variables = [];
  for (const match of raw.matchAll(PATTERN)) {
    const start = match.index,
      end = start + match[0].length;
    text += raw.slice(offset, start);
    const suffix = raw.slice(end).split(/\r\n|\r|\n/, 1)[0];
    const editing =
      selection &&
      ((selection.start >= start && selection.start < end && selection.end <= end) ||
        (!suffix.trim() && selection.start >= end && selection.end <= end + suffix.length));
    const value = values[match[1]] ?? '';
    const shown = !editing && value.trim() ? value : match[0];
    variables.push({
      start,
      end,
      shownStart: text.length,
      shownEnd: text.length + shown.length,
      expanded: shown !== match[0],
    });
    text += shown;
    offset = end;
  }
  return {raw, text: text + raw.slice(offset), variables};
}

export function rawPosition(view, position) {
  let offset = 0;
  for (const item of view.variables) {
    if (position < item.shownStart) break;
    if (position <= item.shownEnd) {
      if (position === item.shownStart) return item.start;
      if (position === item.shownEnd) return item.end;
      return item.start + Math.min(position - item.shownStart, item.end - item.start - 1);
    }
    offset = item.end - item.shownEnd;
  }
  return Math.max(0, Math.min(view.raw.length, position + offset));
}
export function shownPosition(view, position) {
  let offset = 0;
  for (const item of view.variables) {
    if (position < item.start) break;
    if (position <= item.end) {
      if (position === item.end) return item.shownEnd;
      return item.shownStart + Math.min(position - item.start, item.shownEnd - item.shownStart);
    }
    offset = item.shownEnd - item.end;
  }
  return Math.max(0, Math.min(view.text.length, position + offset));
}
export function rawSelection(view, selection) {
  return {...selection, start: rawPosition(view, selection.start), end: rawPosition(view, selection.end)};
}

/** Apply a native edit to the source, preserving every variable outside the edited range. */
export function editTemplate(view, next, after, before) {
  // Bound the diff by the actual selection, so repeated text doesn't move the edit to a different occurrence.
  const prefixLimit = Math.min(view.text.length, next.length, before?.start ?? Infinity, after.start);
  let start = 0;
  while (start < prefixLimit && view.text[start] === next[start]) start++;
  const suffixLimit = Math.min(
    view.text.length - start,
    next.length - start,
    before ? view.text.length - before.end : Infinity,
    next.length - after.end,
  );
  let suffix = 0;
  while (suffix < suffixLimit && view.text[view.text.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const end = view.text.length - suffix;
  let patchStart = start,
    patchEnd = end;
  // IME, drag/drop or browser edits can bypass selection events. Materialize only the touched variable then.
  for (const variable of view.variables) {
    if (!variable.expanded) continue;
    if (start > variable.shownStart && start < variable.shownEnd) patchStart = variable.shownStart;
    if (end > variable.shownStart && end < variable.shownEnd) patchEnd = variable.shownEnd;
  }
  const from = rawPosition(view, patchStart),
    to = rawPosition(view, patchEnd);
  const insertion =
    view.text.slice(patchStart, start) + next.slice(start, next.length - suffix) + view.text.slice(end, patchEnd);
  const raw = view.raw.slice(0, from) + insertion + view.raw.slice(to);
  const caret = Math.min(raw.length, from + after.start - patchStart);
  return {raw, selection: {start: caret, end: caret + after.end - after.start, direction: after.direction}};
}

const selectionOf = element => ({
  start: element.selectionStart ?? 0,
  end: element.selectionEnd ?? 0,
  direction: element.selectionDirection ?? 'none',
});

/**
 * Binds a native input/textarea to a template source. The control shows the resolved text; `value`
 * is the source with its variables. `values()` supplies the current variable values.
 */
export function bindTemplateField(element, values, {maxLength = 2000, onChange = () => {}} = {}) {
  let raw = '',
    cursor = null,
    before,
    composing = null,
    view = templateView('', {});
  // The panel lives in a shadow root, where document.activeElement is only the host.
  const focused = () => element.getRootNode().activeElement === element;
  function render() {
    view = templateView(raw, values(), cursor);
    if (element.value !== view.text) element.value = view.text;
    if (cursor && focused()) {
      const start = shownPosition(view, cursor.start),
        end = shownPosition(view, cursor.end);
      if (element.selectionStart !== start || element.selectionEnd !== end)
        element.setSelectionRange(start, end, cursor.direction);
    }
  }
  function commit(base, text, after, prior) {
    if (text === base.text) return;
    const change = editTemplate(base, text, after, prior);
    if (change.raw.length > maxLength && change.raw.length > raw.length) {
      element.value = view.text;
      return;
    }
    raw = change.raw;
    cursor = change.selection;
    render();
    onChange(raw);
  }
  function select() {
    if (composing || !focused() || element.value !== view.text) return;
    const next = rawSelection(view, selectionOf(element));
    if (next.start === cursor?.start && next.end === cursor?.end) return;
    cursor = next;
    render();
  }
  element.addEventListener('beforeinput', () => {
    before = selectionOf(element);
  });
  element.addEventListener('input', event => {
    if (composing || event.isComposing) return;
    commit(view, element.value, selectionOf(element), before);
    before = undefined;
  });
  element.addEventListener('compositionstart', () => {
    composing = {view, before: selectionOf(element)};
  });
  element.addEventListener('compositionend', () => {
    const composition = composing;
    composing = null;
    if (composition) commit(composition.view, element.value, selectionOf(element), composition.before);
    before = undefined;
  });
  for (const type of ['select', 'keyup', 'mouseup', 'focus'])
    element.addEventListener(type, () => queueMicrotask(select));
  element.addEventListener('blur', () => {
    cursor = null;
    before = undefined;
    render();
  });
  return {
    get value() {
      return raw;
    },
    set value(next) {
      raw = next;
      cursor = null;
      render();
    },
    // Variable values changed (live picked, clipper typed): show them. Never mid-composition: the
    // field's own input events bubble to the form, and redrawing would wipe the text being composed.
    refresh() {
      if (!composing) render();
    },
    get shown() {
      return view.text;
    },
  };
}
