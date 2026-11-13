import {constrainRect, resizeRect} from '../ui/panel-geometry.js';

// Shared pointer lifecycle for panels and the launcher; cleanup also ends an active drag.
export function bindWindowDrag(element, {start = () => true, move, end}) {
  let finish;
  const down = event => {
    if (event.button !== 0 || !start(event)) return;
    finish?.();
    const x = event.clientX,
      y = event.clientY;
    const target = event.target.closest('button') ?? element;
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    const onMove = next => {
      if (next.pointerId === event.pointerId) move(next.clientX - x, next.clientY - y);
    };
    finish = next => {
      if (next && next.pointerId !== event.pointerId) return;
      element.removeEventListener('pointermove', onMove);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
        element.removeEventListener(name, finish);
      finish = null;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      end?.();
    };
    element.addEventListener('pointermove', onMove);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(name, finish);
  };
  element.addEventListener('pointerdown', down);
  return () => {
    finish?.();
    element.removeEventListener('pointerdown', down);
  };
}

export function createFloatingWindow({element, header, get, set, key, defaults, minimum, enabled = () => true}) {
  const viewport = () => ({width: innerWidth, height: innerHeight});
  let rect = constrainRect(get(key, defaults()), viewport(), minimum);
  const apply = () =>
    Object.assign(element.style, Object.fromEntries(Object.entries(rect).map(([name, value]) => [name, `${value}px`])));
  apply();
  const bind = (handle, resize) => {
    let initial;
    return bindWindowDrag(handle, {
      start(event) {
        if (!enabled() || event.target.closest('button,input,textarea,select,a,[contenteditable]')) return false;
        initial = {...rect};
        return true;
      },
      move(dx, dy) {
        rect = resize
          ? resizeRect(initial, handle.dataset.edge, dx, dy, viewport(), minimum)
          : constrainRect({...initial, left: initial.left + dx, top: initial.top + dy}, viewport(), minimum);
        apply();
      },
      end: () => set(key, {...rect}),
    });
  };
  const cleanup = [bind(header, false), ...[...element.querySelectorAll('[data-edge]')].map(el => bind(el, true))];
  const onResize = () => {
    rect = constrainRect(rect, viewport(), minimum);
    apply();
  };
  window.addEventListener('resize', onResize);
  return () => {
    cleanup.forEach(dispose => dispose());
    window.removeEventListener('resize', onResize);
  };
}
