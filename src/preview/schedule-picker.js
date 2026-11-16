import {
  beijingSchedule,
  calendarDays,
  padTime,
  parseSchedule,
  scheduleLabel,
  shiftMonth,
  videoTimePresets,
} from './schedule.js';
import {iconMarkup} from '../ui/icon.jsx';

// Lives in the plugin shadow root so it inherits the same controls and theme as the form.
export function createSchedulePicker(host) {
  host.classList.add('schedule-picker');
  host.innerHTML = `<input type="hidden" data-scheduleAt>
    <div class="schedule-trigger-row">
      <button type="button" class="schedule-trigger" aria-label="定时投稿" aria-haspopup="dialog" aria-expanded="false">${iconMarkup('calendar')}<span></span>${iconMarkup('down')}</button>
      <button type="button" class="icon small" data-schedule-clear aria-label="清除定时" title="清除" hidden>${iconMarkup('close')}</button>
    </div>
    <div class="schedule-presets" role="group" aria-label="快捷时间"></div>
    <div class="schedule-popover" role="dialog" aria-label="选择投稿时间" tabindex="-1" hidden>
      <header class="schedule-month">
        <button type="button" class="icon small" data-schedule-prev aria-label="上个月">${iconMarkup('chevron')}</button><strong></strong>
        <button type="button" class="icon small" data-schedule-next aria-label="下个月">${iconMarkup('chevron')}</button>
      </header>
      <table class="schedule-calendar"><thead><tr>${['一', '二', '三', '四', '五', '六', '日'].map(day => `<th scope="col">${day}</th>`).join('')}</tr></thead><tbody></tbody></table>
      <div class="schedule-clock"><span>北京时间</span><div>
        <input type="text" inputmode="numeric" maxlength="2" aria-label="小时"> <b>:</b>
        <input type="text" inputmode="numeric" maxlength="2" aria-label="分钟">
      </div></div>
      <p class="inline-error" data-schedule-error hidden>请选择未来 15 天内的时间</p>
      <footer class="schedule-actions"><button type="button" class="link" data-schedule-cancel>取消定时</button>
        <button type="button" class="primary small" data-schedule-apply>确定</button></footer>
    </div>`;
  let popup;
  const find = selector => host.querySelector(selector) || popup?.querySelector(selector);
  const value = find('[data-scheduleAt]'),
    trigger = find('.schedule-trigger'),
    clear = find('[data-schedule-clear]');
  popup = find('.schedule-popover');
  const scrollRoot = host.getRootNode();
  const hour = find('[aria-label="小时"]'),
    minute = find('[aria-label="分钟"]');
  const previous = find('[data-schedule-prev]'),
    next = find('[data-schedule-next]'),
    apply = find('[data-schedule-apply]');
  const hasPopover = typeof popup.showPopover === 'function';
  if (hasPopover) popup.setAttribute('popover', 'manual');
  popup.id = `clip-schedule-${crypto.randomUUID()}`;
  trigger.setAttribute('aria-controls', popup.id);
  let opened = false,
    draft = '',
    month = '',
    picked = null,
    timer;
  const now = () => Date.now() / 1000;
  const allowed = time => time !== null && time > now() && time <= now() + 15 * 86400;
  const dayAllowed = day =>
    parseSchedule(`${day}T23:59:59`) > now() && day <= beijingSchedule(now() + 15 * 86400).slice(0, 10);
  function refresh() {
    trigger.querySelector('span').textContent = scheduleLabel(value.value);
    trigger.classList.toggle('has-value', Boolean(value.value));
    clear.hidden = !value.value;
    for (const button of host.querySelectorAll('[data-preset]')) {
      button.setAttribute(
        'aria-pressed',
        String(picked?.value === value.value && picked.label === button.dataset.preset),
      );
    }
  }
  function choose(text) {
    value.value = text;
    refresh();
    value.dispatchEvent(new Event('input', {bubbles: true}));
  }
  function close(focus = false) {
    const wasOpen = opened;
    opened = false;
    if (wasOpen && hasPopover) popup.hidePopover();
    popup.hidden = true;
    if (popup.parentNode !== host) host.append(popup);
    clearInterval(timer);
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }
  function validate() {
    const invalid = !allowed(parseSchedule(draft));
    apply.disabled = invalid;
    find('[data-schedule-error]').hidden = !invalid;
  }
  function draw() {
    const today = beijingSchedule(now()).slice(0, 10),
      day = draft.slice(0, 10);
    const clock = draft.split('T')[1] || '00:00';
    [hour.value, minute.value] = clock.split(':');
    previous.disabled = shiftMonth(month, -1) < today.slice(0, 7);
    next.disabled = shiftMonth(month, 1) > beijingSchedule(now() + 15 * 86400).slice(0, 7);
    find('strong').textContent = `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;
    const body = find('tbody');
    body.replaceChildren();
    const days = calendarDays(month);
    for (let row = 0; row < 6; row++) {
      const tr = document.createElement('tr');
      for (const date of days.slice(row * 7, row * 7 + 7)) {
        const td = document.createElement('td'),
          button = document.createElement('button');
        button.type = 'button';
        button.dataset.day = date;
        button.textContent = String(Number(date.slice(8)));
        button.disabled = !dayAllowed(date);
        button.setAttribute(
          'aria-label',
          `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`,
        );
        button.setAttribute('aria-pressed', String(date === day));
        if (date === today) button.setAttribute('aria-current', 'date');
        button.classList.toggle('is-other-month', date.slice(0, 7) !== month);
        const select = target => {
          draft = `${target}T${clock}`;
          month = target.slice(0, 7);
          draw();
          find(`[data-day="${target}"]`)?.focus();
        };
        button.onclick = () => select(date);
        button.onkeydown = event => {
          const offset = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[event.key];
          if (!offset) return;
          event.preventDefault();
          const target = beijingSchedule(parseSchedule(`${date}T12:00`) + offset * 86400).slice(0, 10);
          if (dayAllowed(target)) select(target);
        };
        td.append(button);
        tr.append(td);
      }
      body.append(tr);
    }
    validate();
  }
  function place(event) {
    if (!opened || (event?.type === 'scroll' && popup.contains(event.target))) return;
    const rect = trigger.getBoundingClientRect(),
      width = Math.min(344, innerWidth - 24);
    popup.style.width = `${width}px`;
    const height = Math.min(popup.offsetHeight || 420, innerHeight - 24);
    const top = innerHeight - rect.bottom - 12 >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
    Object.assign(popup.style, {
      left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`,
      top: `${top}px`,
      maxHeight: `${innerHeight - top - 12}px`,
    });
  }
  trigger.onclick = () => {
    if (opened) {
      close();
      return;
    }
    draft = allowed(parseSchedule(value.value)) ? value.value : beijingSchedule(Math.ceil((now() + 60) / 60) * 60);
    month = draft.slice(0, 7);
    opened = true;
    popup.hidden = false;
    draw();
    if (hasPopover) popup.showPopover();
    else {
      // Older browsers lack the top layer: stay in the shadow root but outside the clipped panel.
      popup.style.zIndex = '2147483640';
      scrollRoot.append(popup);
    }
    place();
    popup.focus();
    trigger.setAttribute('aria-expanded', 'true');
    timer = setInterval(() => {
      validate();
      refresh();
    }, 30000);
  };
  for (const preset of videoTimePresets()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.dataset.preset = preset.label;
    button.textContent = preset.label;
    button.onclick = () => {
      picked = videoTimePresets().find(item => item.label === preset.label);
      choose(picked.value);
      close();
    };
    find('.schedule-presets').append(button);
  }
  for (const input of [hour, minute]) {
    input.onfocus = () => input.select();
    input.oninput = () => {
      draft = `${draft.slice(0, 10)}T${hour.value}:${minute.value}`;
      validate();
    };
    input.onblur = () => {
      hour.value = padTime(Math.min(23, Math.max(0, Number(hour.value) || 0)));
      minute.value = padTime(Math.min(59, Math.max(0, Number(minute.value) || 0)));
      draft = `${draft.slice(0, 10)}T${hour.value}:${minute.value}`;
      validate();
    };
  }
  previous.onclick = () => {
    month = shiftMonth(month, -1);
    draw();
  };
  next.onclick = () => {
    month = shiftMonth(month, 1);
    draw();
  };
  clear.onclick = find('[data-schedule-cancel]').onclick = () => {
    picked = null;
    choose('');
    close(true);
  };
  apply.onclick = () => {
    if (!allowed(parseSchedule(draft))) {
      validate();
      return;
    }
    picked = null;
    choose(draft);
    close(true);
  };
  popup.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    // Enter in the clock confirms the date, never submits the outer archive form.
    if (event.key === 'Enter' && [hour, minute].includes(event.target)) {
      event.preventDefault();
      apply.click();
    }
  };
  popup.onfocusout = event => {
    if (event.relatedTarget && !popup.contains(event.relatedTarget)) close();
  };
  const outside = event => {
    const path = event.composedPath();
    if (opened && !path.includes(host) && !path.includes(popup)) close();
  };
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', place);
  scrollRoot.addEventListener('scroll', place, true);
  refresh();
  return {
    get value() {
      return value.value;
    },
    set value(text) {
      picked = null;
      value.value = text;
      close();
      refresh();
    },
    close,
    dispose() {
      close();
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', place);
      scrollRoot.removeEventListener('scroll', place, true);
    },
  };
}
