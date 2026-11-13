import {clamp} from '../shared/math.js';
import {constrainRect} from '../ui/panel-geometry.js';
import {bindWindowDrag, createFloatingWindow} from './floating-window.js';

// Everything about where the panel and launcher sit: dragging, resizing and
// keeping both on screen. Positions persist across pages.
export function createPanelWindow({root, get, set}) {
  const $ = id => root.getElementById(id);
  const viewport = () => ({width: innerWidth, height: innerHeight});
  // The editor shows the picture, the timeline and (internally) the marks side by side, so
  // the panel opens large; people who want it smaller resize it once and it stays that way.
  const defaults = () => {
    const width = Math.min(1320, innerWidth - 40),
      height = Math.min(920, innerHeight - 40);
    return constrainRect({left: (innerWidth - width) / 2, top: (innerHeight - height) / 2, width, height}, viewport());
  };
  createFloatingWindow({
    element: $('panel'),
    header: $('header'),
    get,
    set,
    key: 'windowV3',
    defaults,
    enabled: () => !$('panel').hasAttribute('data-logged-out'),
  });
  let launcherMoved = false,
    launcherStart;
  const savedLauncher = get('launcher', null);
  function moveLauncher(left, top) {
    const {width, height} = $('launcher').getBoundingClientRect();
    Object.assign($('launcher').style, {
      left: `${clamp(left, 0, innerWidth - width)}px`,
      top: `${clamp(top, 0, innerHeight - height)}px`,
      right: 'auto',
      bottom: 'auto',
    });
  }
  if (savedLauncher) moveLauncher(savedLauncher.left, savedLauncher.top);
  $('launcher').addEventListener('pointerdown', () => {
    launcherMoved = false;
    launcherStart = $('launcher').getBoundingClientRect();
  });
  bindWindowDrag($('launcher'), {
    move(dx, dy) {
      if (Math.abs(dx) + Math.abs(dy) > 4) launcherMoved = true;
      if (launcherMoved) moveLauncher(launcherStart.left + dx, launcherStart.top + dy);
    },
    end() {
      if (launcherMoved) {
        const b = $('launcher').getBoundingClientRect();
        set('launcher', {left: b.left, top: b.top});
      }
    },
  });
  window.addEventListener('resize', () => {
    const b = $('launcher').getBoundingClientRect();
    if (b.right > innerWidth || b.bottom > innerHeight) moveLauncher(b.left, b.top);
  });
  return {
    launcherDragged: () => launcherMoved,
    bindMiniWindow: element =>
      createFloatingWindow({
        element,
        header: element.querySelector('.mini-head'),
        get,
        set,
        key: 'miniMarksWindow',
        defaults: () => ({left: innerWidth - 342, top: innerHeight - 404, width: 320, height: 300}),
        minimum: {width: 280, height: 200},
      }),
  };
}
