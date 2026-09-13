export const DEFAULT_SHORTCUT = Object.freeze({
  code: 'KeyC', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false,
});

export function normalizeShortcut(value) {
  if (!value?.code || /^(Control|Alt|Shift|Meta|OS|Fn)(Left|Right)?$/.test(value.code)) return null;
  if (!value.ctrlKey && !value.altKey && !value.metaKey) return null;
  return Object.fromEntries(['code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey']
    .map(key => [key, key === 'code' ? value.code : Boolean(value[key])]));
}

export function formatShortcut(shortcut) {
  return [shortcut.ctrlKey && 'Ctrl', shortcut.altKey && 'Alt', shortcut.shiftKey && 'Shift',
    shortcut.metaKey && '⌘', shortcut.code.replace(/^Key|^Digit/, '')].filter(Boolean).join('+');
}

export function matchesShortcut(event, shortcut) {
  return !event.repeat && !event.isComposing && !event.defaultPrevented
    && ['code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey'].every(key => event[key] === shortcut[key]);
}

export function isEditing(event) {
  return [event.target, ...(event.composedPath?.() || [])].some(target =>
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable);
}
