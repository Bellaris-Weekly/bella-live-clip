import {clamp} from '../shared/math.js';
import {constrainRect, resizeRect} from '../ui/panel-geometry.js';

// Everything about where the panel and launcher sit: dragging, resizing and
// keeping both on screen. Positions persist across pages.
export function createPanelWindow({root, get, set}) {
  const $ = id => root.getElementById(id);
  const viewport = () => ({width: innerWidth, height: innerHeight});
  const defaults = () => constrainRect({left: innerWidth - 820, top: 20, width: 800, height: 880}, viewport());
  let rect = constrainRect(get('windowV2', defaults()), viewport());
  const applyRect = () =>
    Object.assign($('panel').style, Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, `${v}px`])));
  applyRect();
  function drag(element, onMove, onEnd) {
    element.addEventListener('pointerdown', e => {
      if (e.button !== 0 || (e.target.closest('button,input,select,a') && element !== $('launcher'))) return;
      const x = e.clientX,
        y = e.clientY,
        initial = {...rect};
      element.setPointerCapture(e.pointerId);
      e.preventDefault();
      const move = ev => onMove(ev.clientX - x, ev.clientY - y, initial);
      const finish = () => {
        element.removeEventListener('pointermove', move);
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
          element.removeEventListener(name, finish);
        onEnd?.();
      };
      element.addEventListener('pointermove', move);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(name, finish);
    });
  }
  drag(
    $('header'),
    (dx, dy, r) => {
      rect = constrainRect({...r, left: r.left + dx, top: r.top + dy}, viewport());
      applyRect();
    },
    () => set('windowV2', rect),
  );
  root.querySelectorAll('[data-edge]').forEach(el =>
    drag(
      el,
      (dx, dy, r) => {
        rect = resizeRect(r, el.dataset.edge, dx, dy, viewport());
        applyRect();
      },
      () => set('windowV2', rect),
    ),
  );
  let launcherMoved = false,
    launcherStart;
  const savedLauncher = get('launcher', null);
  function moveLauncher(left, top) {
    Object.assign($('launcher').style, {
      left: `${clamp(left, 0, innerWidth - 58)}px`,
      top: `${clamp(top, 0, innerHeight - 62)}px`,
      right: 'auto',
      bottom: 'auto',
    });
  }
  if (savedLauncher) moveLauncher(savedLauncher.left, savedLauncher.top);
  $('launcher').addEventListener('pointerdown', () => {
    launcherMoved = false;
    launcherStart = $('launcher').getBoundingClientRect();
  });
  drag(
    $('launcher'),
    (dx, dy) => {
      if (Math.abs(dx) + Math.abs(dy) > 4) launcherMoved = true;
      if (launcherMoved) moveLauncher(launcherStart.left + dx, launcherStart.top + dy);
    },
    () => {
      if (launcherMoved) {
        const b = $('launcher').getBoundingClientRect();
        set('launcher', {left: b.left, top: b.top});
      }
    },
  );
  window.addEventListener('resize', () => {
    rect = constrainRect(rect, viewport());
    applyRect();
    const b = $('launcher').getBoundingClientRect();
    if (b.right > innerWidth || b.bottom > innerHeight) moveLauncher(b.left, b.top);
  });
  return {launcherDragged: () => launcherMoved};
}
