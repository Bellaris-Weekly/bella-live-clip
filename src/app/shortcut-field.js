import {DEFAULT_SHORTCUT, normalizeShortcut, formatShortcut, matchesShortcut, isEditing} from '../ui/shortcuts.js';

// The field that records the panel shortcut, and the shortcut itself.
export function bindShortcut({
  root,
  get,
  set,
  onPress,
  field = 'shortcut',
  key = 'shortcut',
  fallback = DEFAULT_SHORTCUT,
  accepts = () => true,
  onChange = () => {},
}) {
  const $ = id => root.getElementById(id);
  let shortcut = normalizeShortcut(get(key, fallback)) || fallback;
  $(field).value = formatShortcut(shortcut);
  onChange(formatShortcut(shortcut));
  $(field).onfocus = () => {
    $(field).classList.add('recording');
    $(field).value = '按下快捷键';
  };
  $(field).onblur = () => {
    $(field).classList.remove('recording');
    $(field).value = formatShortcut(shortcut);
  };
  $(field).onkeydown = e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return $(field).blur();
    const value = normalizeShortcut(e);
    if (value && accepts(value)) {
      shortcut = value;
      set(key, value);
      onChange(formatShortcut(value));
      $(field).blur();
    }
  };
  document.addEventListener('keydown', e => {
    if (!isEditing(e) && accepts(shortcut) && matchesShortcut(e, shortcut)) {
      e.preventDefault();
      onPress();
    }
  });
}
