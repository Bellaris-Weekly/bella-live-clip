import {iconMarkup} from '../ui/icon.jsx';

// The studio's inline tags: Enter/comma keeps the input open, Escape returns to +.
export function createTagInput(host, changed = () => {}) {
  host.innerHTML = `<div class="tag-list" data-tag-list></div>
    <input data-tags aria-label="新标签" placeholder="输入标签" hidden>
    <button type="button" class="tag-add" aria-label="添加标签" title="添加标签">${iconMarkup('plus')}</button>`;
  const input = host.querySelector('input'),
    add = host.querySelector('button'),
    list = host.querySelector('[data-tag-list]');
  let tags = [];
  const chips = new Map();
  function draw() {
    for (const [tag, chip] of chips) {
      if (!tags.includes(tag)) {
        chip.remove();
        chips.delete(tag);
      }
    }
    tags.forEach((tag, index) => {
      let chip = chips.get(tag);
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.append(document.createTextNode(tag));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `删除标签 ${tag}`);
        remove.onclick = () => {
          tags = tags.filter(value => value !== tag);
          draw();
          changed();
          add.focus();
        };
        chip.append(remove);
        chips.set(tag, chip);
      }
      // Do not replace a remove button on input blur: the pending pointer click still needs it.
      if (list.children[index] !== chip) list.insertBefore(chip, list.children[index] || null);
    });
    add.disabled = tags.length >= 12;
    add.title = add.disabled ? '最多 12 个标签' : '添加标签';
  }
  function close(focus = false) {
    input.value = '';
    input.hidden = true;
    add.hidden = false;
    if (focus) add.focus();
  }
  function commit(keepEditing = false) {
    const next = input.value.split(/[,，\s]+/).filter(Boolean);
    tags = [...new Set([...tags, ...next])].slice(0, 12);
    input.value = '';
    if (!keepEditing || tags.length >= 12) close();
    draw();
    changed();
  }
  add.onclick = () => {
    add.hidden = true;
    input.hidden = false;
    input.focus();
  };
  input.onblur = () => commit();
  input.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (['Enter', ',', '，'].includes(event.key)) {
      event.preventDefault();
      commit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };
  return {
    get value() {
      return tags;
    },
    set value(next) {
      tags = [...next];
      close();
      draw();
    },
    commit,
  };
}
