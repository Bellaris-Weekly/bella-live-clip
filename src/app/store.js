import {signal} from '@preact/signals';

// Everything the panel shows. Controllers write here; components only read and call actions.
export function createStore({member, exportMode}) {
  return {
    open: signal(false),
    settingsOpen: signal(false),
    page: signal('library'),
    busy: signal(false),
    stopping: signal(false),
    ready: signal(false),
    status: signal({text: '', error: false}),
    // null hides the bar; NaN shows an indeterminate one; otherwise 0–100.
    progress: signal(null),
    downloads: signal([]),
    toasts: signal([]),
    version: signal({label: '', update: false, href: null, title: '', busy: false}),
    member: signal(member),
    records: signal([]),
    libraryLoaded: signal(false),
    libraryNote: signal(''),
    currentVideo: signal(false),
    offline: signal({title: '', reason: ''}),
    record: signal(null),
    recordMeta: signal(''),
    paused: signal(true),
    clock: signal('00:00 / 00:00'),
    segments: signal([]),
    segmentIndex: signal(0),
    whole: signal(false),
    exportMode: signal(exportMode),
    estimate: signal(''),
    duration: signal(''),
    zoom: signal(''),
    view: signal({start: 0, end: 1}),
    // Internal build only: {marks, composer}, set once they exist.
    extras: signal(null),
    identity: signal(null),
  };
}

let toastId = 0;
export function toast(store, text, {error = false, action = null, timeout = 4000} = {}) {
  const id = ++toastId;
  store.toasts.value = [...store.toasts.value.slice(-2), {id, text, error, action}];
  if (timeout) setTimeout(() => dismissToast(store, id), timeout);
  return id;
}
export function dismissToast(store, id) {
  store.toasts.value = store.toasts.value.filter(item => item.id !== id);
}
