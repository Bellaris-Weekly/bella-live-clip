import {DEFAULT_SHORTCUT, normalizeShortcut, formatShortcut, matchesShortcut, isEditing} from '../ui/shortcuts.js';

// The field that records the panel shortcut, and the shortcut itself.
export function bindShortcut({root, get, set, onPress}) {
  const $ = id => root.getElementById(id);
  let shortcut = normalizeShortcut(get('shortcut', DEFAULT_SHORTCUT)) || DEFAULT_SHORTCUT;
  $('shortcut').value = formatShortcut(shortcut);
  $('shortcut').onfocus = () => {
    $('shortcut').classList.add('recording');
    $('shortcut').value = '按下快捷键';
  };
  $('shortcut').onblur = () => {
    $('shortcut').classList.remove('recording');
    $('shortcut').value = formatShortcut(shortcut);
  };
  $('shortcut').onkeydown = e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return $('shortcut').blur();
    const value = normalizeShortcut(e);
    if (value) {
      shortcut = value;
      set('shortcut', value);
      $('shortcut').blur();
    }
  };
  document.addEventListener('keydown', e => {
    if (!isEditing(e) && matchesShortcut(e, shortcut)) {
      e.preventDefault();
      onPress();
    }
  });
}
