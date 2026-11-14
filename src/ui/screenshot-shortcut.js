// Keep this protocol in sync with bella-live-clip/src/ui/screenshot-shortcut.js.
// Only DOM strings cross userscript sandboxes. No storage-event/cross-tab listener.
const SCREENSHOT_PREF_KEY = 'bellaScreenshotShortcutV1';
const CONFIG = 'data-bella-screenshot-shortcut-v1';
const OWNER = 'data-bella-screenshot-keys-v1';
const CHANGE = 'bella-screenshot-shortcut-change-v1';
const ACTION = 'data-bella-shortcut-action-';
const CHANNEL = 'bella-screenshot-shortcut-v1';
const DEFAULT_SCREENSHOT_SHORTCUT = Object.freeze({
  code: 'KeyP',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
});

function normalizeScreenshotShortcut(value) {
  if (
    typeof value?.code !== 'string' ||
    !value.code ||
    value.code.length > 40 ||
    /^(Control|Alt|Shift|Meta|OS|Fn)(Left|Right)?$/.test(value.code) ||
    ['Escape', 'Unidentified'].includes(value.code)
  )
    return null;
  return Object.fromEntries(
    ['code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey'].map(key => [
      key,
      key === 'code' ? value.code : Boolean(value[key]),
    ]),
  );
}

function sameShortcut(left, right) {
  return Boolean(
    left && right && ['code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey'].every(key => left[key] === right[key]),
  );
}

function readRecord(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const shortcut = normalizeScreenshotShortcut(parsed?.shortcut);
    if (
      !shortcut ||
      !Number.isSafeInteger(parsed.updatedAt) ||
      parsed.updatedAt < 0 ||
      typeof parsed.source !== 'string' ||
      parsed.source.length > 80
    )
      return null;
    return {shortcut, updatedAt: parsed.updatedAt, source: parsed.source};
  } catch (_) {
    return null;
  }
}

function newer(left, right) {
  return (
    left &&
    (!right || left.updatedAt > right.updatedAt || (left.updatedAt === right.updatedAt && left.source > right.source))
  );
}

function createScreenshotShortcut({document: doc, clientId, read = () => null, write = () => {}}) {
  const view = doc.defaultView;
  const root = doc.documentElement;
  const listeners = new Set();
  let record = {shortcut: DEFAULT_SCREENSHOT_SHORTCUT, updatedAt: 0, source: ''};
  const persist = () => {
    if (!record.updatedAt) return;
    try {
      write(record);
    } catch (_) {
      /* Storage must not interrupt a screenshot. */
    }
    try {
      view.localStorage.setItem(SCREENSHOT_PREF_KEY, JSON.stringify(record));
    } catch (_) {
      /* Optional cache. */
    }
  };
  const accept = next => {
    if (!newer(next, record)) return false;
    record = next;
    persist();
    listeners.forEach(listener => listener(record.shortcut));
    return true;
  };
  const publish = next => {
    if (!accept(next)) return;
    root.setAttribute(CONFIG, JSON.stringify(record));
    root.dispatchEvent(new view.Event(CHANGE));
  };
  const receive = () => accept(readRecord(root.getAttribute(CONFIG)));
  root.addEventListener(CHANGE, receive);
  // Merge saved settings before publishing; an old instance never resets a newer edit.
  let initial = readRecord(root.getAttribute(CONFIG));
  try {
    const saved = readRecord(read());
    if (newer(saved, initial)) initial = saved;
  } catch (_) {
    /* Unavailable userscript storage. */
  }
  try {
    const saved = readRecord(view.localStorage.getItem(SCREENSHOT_PREF_KEY));
    if (newer(saved, initial)) initial = saved;
  } catch (_) {
    /* Optional cache. */
  }
  accept(initial);
  root.setAttribute(CONFIG, JSON.stringify(record));
  root.dispatchEvent(new view.Event(CHANGE));

  const conflicts = (value, except = 'screenshot') => {
    if (except !== 'screenshot' && sameShortcut(value, record.shortcut)) return true;
    return root
      .getAttributeNames()
      .filter(name => name.startsWith(ACTION) && name !== ACTION + except)
      .some(name => {
        try {
          return sameShortcut(value, JSON.parse(root.getAttribute(name)));
        } catch (_) {
          return false;
        }
      });
  };
  const api = {
    get: () => record.shortcut,
    set(value) {
      const shortcut = normalizeScreenshotShortcut(value);
      if (!shortcut || conflicts(shortcut)) return false;
      // Another tab may have saved while this page stayed open. Read only on explicit edit.
      let saved = null;
      try {
        saved = readRecord(view.localStorage.getItem(SCREENSHOT_PREF_KEY));
      } catch (_) {
        /* Optional cache. */
      }
      publish({
        shortcut,
        updatedAt: Math.max(Date.now(), record.updatedAt + 1, (saved?.updatedAt || 0) + 1),
        source: clientId,
      });
      return true;
    },
    conflicts,
    registerAction(name, value) {
      const shortcut = normalizeScreenshotShortcut(value);
      if (shortcut) root.setAttribute(ACTION + name, JSON.stringify(shortcut));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // Keyboard ownership is separate from button ownership, including old/new mixes.
  if (root.hasAttribute(OWNER)) return api;
  root.setAttribute(OWNER, '');

  const childFrames = new Set();
  const frameOrigin = frame => {
    try {
      return new view.URL(frame.src, doc.baseURI).origin;
    } catch (_) {
      return '';
    }
  };
  const allowedOrigin = origin => {
    if (origin === view.location.origin && origin !== 'null') return true;
    try {
      const url = new view.URL(origin);
      return url.protocol === 'https:' && ['www.bilibili.com', 'live.bilibili.com'].includes(url.hostname);
    } catch (_) {
      return false;
    }
  };
  const send = (target, origin, type, extra = {}) => {
    if (target && allowedOrigin(origin)) target.postMessage({channel: CHANNEL, type, ...extra}, origin);
  };
  let parentOrigin = '';
  try {
    parentOrigin = new view.URL(doc.referrer).origin;
  } catch (_) {
    /* Top document / no referrer. */
  }
  try {
    if (view.parent !== view) parentOrigin = view.parent.location.origin;
  } catch (_) {
    /* Cross origin. */
  }
  const relay = () => {
    if (view.parent !== view) send(view.parent, parentOrigin, 'config', {record});
    for (const frame of childFrames) {
      if (!frame.isConnected) childFrames.delete(frame);
      else send(frame.contentWindow, frameOrigin(frame), 'config', {record});
    }
  };
  root.addEventListener(CHANGE, relay);

  const visibleArea = element => {
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      ? rect.width * rect.height
      : 0;
  };
  const players = () =>
    [...doc.querySelectorAll('.web-player-icon-feedback')]
      .filter(control => control.querySelector('[data-bella-screenshot-icon]'))
      .map(control => {
        for (let parent = control.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
          const videos = [...parent.querySelectorAll('video')];
          if (videos.length) {
            const video = videos.sort((a, b) => visibleArea(b) - visibleArea(a))[0];
            return {control, video, area: visibleArea(video)};
          }
        }
        return null;
      })
      .filter(player => player && player.area > 0);
  let activeControl = null;
  const trackPlayer = event => {
    const target = event.composedPath?.()[0] || event.target;
    const player = players().find(item => {
      for (let parent = item.control.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
        if (parent.contains(item.video)) return target?.nodeType && parent.contains(target);
      }
      return false;
    });
    if (player) activeControl = player.control;
  };
  doc.addEventListener('pointerdown', trackPlayer, true);
  doc.addEventListener('focusin', trackPlayer, true);
  const chooseTarget = () => {
    const full = doc.fullscreenElement || doc.webkitFullscreenElement;
    const candidates = [
      ...players().map(player => ({...player, element: player.video})),
      ...[...childFrames]
        .filter(frame => frame.isConnected && visibleArea(frame) > 0)
        .map(frame => ({frame, element: frame, area: visibleArea(frame)})),
    ];
    if (full)
      return candidates
        .filter(item => full === item.element || full.contains(item.element))
        .sort((a, b) => b.area - a.area)[0];
    return (
      candidates.find(item => item.frame && item.frame === doc.activeElement) ||
      candidates.find(item => item.control === activeControl) ||
      candidates.sort((a, b) => b.area - a.area)[0]
    );
  };
  const capture = target => {
    if (!target) return;
    if (target.control) target.control.click();
    else send(target.frame.contentWindow, frameOrigin(target.frame), 'capture');
  };
  view.addEventListener('message', event => {
    if (event.data?.channel !== CHANNEL || !allowedOrigin(event.origin)) return;
    const fromParent = view.parent !== view && event.source === view.parent;
    const frame = [...doc.querySelectorAll('iframe')].find(
      item => item.contentWindow === event.source && frameOrigin(item) === event.origin,
    );
    if (!fromParent && !frame) return;
    if (fromParent) parentOrigin = event.origin;
    if (frame) childFrames.add(frame);
    if (event.data.type === 'hello') {
      send(event.source, event.origin, 'config', {record});
    } else if (event.data.type === 'config') {
      publish(readRecord(event.data.record));
    } else if (event.data.type === 'capture' && fromParent) {
      capture(chooseTarget());
    }
  });
  if (view.parent !== view) {
    if (allowedOrigin(parentOrigin)) send(view.parent, parentOrigin, 'hello');
    // A referrer-free iframe can announce itself without sending settings. The reply
    // still requires a trusted origin and the actual parent Window as its source.
    else view.parent.postMessage({channel: CHANNEL, type: 'hello'}, '*');
  }
  // A parent can start after its player frame. Both sides announce readiness.
  for (const frame of doc.querySelectorAll('iframe')) send(frame.contentWindow, frameOrigin(frame), 'hello');
  relay();
  view.addEventListener(
    'keydown',
    event => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      if (
        [event.target, ...(event.composedPath?.() || [])].some(
          target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable,
        )
      )
        return;
      if (!sameShortcut(event, record.shortcut) || conflicts(record.shortcut)) return;
      const target = chooseTarget();
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      capture(target);
    },
    true,
  );
  return api;
}

function bindScreenshotShortcut({input, shortcut, format, onConflict}) {
  let recording = false;
  const render = () => {
    input.value = recording ? '按下快捷键' : format(shortcut.get());
  };
  input.addEventListener('focus', () => {
    recording = true;
    input.classList.add('recording');
    render();
  });
  input.addEventListener('blur', () => {
    recording = false;
    input.classList.remove('recording');
    render();
  });
  input.addEventListener('keydown', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return input.blur();
    if (event.repeat || event.isComposing || event.keyCode === 229) return;
    const value = normalizeScreenshotShortcut(event);
    if (!value) return;
    if (!shortcut.set(value)) return onConflict();
    input.blur();
  });
  shortcut.subscribe(render);
  render();
}

export {SCREENSHOT_PREF_KEY, DEFAULT_SCREENSHOT_SHORTCUT, createScreenshotShortcut, bindScreenshotShortcut};
