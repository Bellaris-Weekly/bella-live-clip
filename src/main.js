import metadataText from './header.txt';
import {readScriptMetadata} from './services/updates.js';
import {createDiagnosticReporter} from './services/diagnostics.js';
import {createApp} from './app/application.js';
import {BiliApi, createRequest} from './services/bilibili.js';
import {createSubmissionRequest} from './services/submission-request.js';
import {createMediaRequest} from './services/media-request.js';
import {startLiveScreenshot} from './app/live-screenshot.js';
import {SCREENSHOT_PREF_KEY, createScreenshotShortcut} from './ui/screenshot-shortcut.js';
import {startPageBridge} from './services/page-bridge.js';
import {createStudioClient, startLink, TOKEN_KEY} from './preview/studio.js';

let studio;
const screenshotShortcut =
  location.hostname === 'studio.bk0717.com'
    ? null
    : createScreenshotShortcut({
        document,
        clientId: 'clip',
        read: () => GM_getValue(SCREENSHOT_PREF_KEY, null),
        write: value => GM_setValue(SCREENSHOT_PREF_KEY, value),
      });
if (typeof __PREVIEW__ !== 'undefined' && __PREVIEW__) {
  const get = (key, fallback) => GM_getValue(`biliClip.${key}`, fallback);
  const set = (key, value) => GM_setValue(`biliClip.${key}`, value);
  if (location.hostname === 'studio.bk0717.com') {
    startLink({target: unsafeWindow, location, set, version: readScriptMetadata(metadataText).version});
  } else {
    studio = createStudioClient({get, set, request: GM_xmlhttpRequest});
    const check = () => void studio.check().catch(() => {});
    GM_addValueChangeListener(`biliClip.${TOKEN_KEY}`, (_key, old, value) => {
      if (old?.token !== value?.token) check();
    });
    window.addEventListener('focus', check);
    check();
  }
}

if (location.hostname === 'live.bilibili.com')
  startLiveScreenshot(document, typeof __PREVIEW__ !== 'undefined' && __PREVIEW__ ? studio : null);

if (location.hostname === 'studio.bk0717.com') {
  startPageBridge({
    name: 'bella-live-clip',
    version: readScriptMetadata(metadataText).version,
    request: GM_xmlhttpRequest,
    target: unsafeWindow,
  });
} else if (window.top === window && !document.getElementById('bella-live-clip-host')) {
  const diagnostics = createDiagnosticReporter({
    endpoint: typeof __LOG_SERVICE_ENDPOINT__ === 'string' ? __LOG_SERVICE_ENDPOINT__ : '',
    request: GM_xmlhttpRequest,
    version: readScriptMetadata(metadataText).version,
    userAgent: navigator.userAgent,
  });
  const request = createRequest(GM_xmlhttpRequest);
  const app = createApp({
    screenshotShortcut,
    ...(typeof __PREVIEW__ !== 'undefined' && __PREVIEW__
      ? {
          studio,
          storageKeys: () =>
            GM_listValues()
              .filter(key => key.startsWith('biliClip.'))
              .map(key => key.slice(9)),
        }
      : {}),
    diagnostics,
    api: new BiliApi(request),
    mediaRequest: createMediaRequest({pageFetch: unsafeWindow.fetch.bind(unsafeWindow), fallback: request}),
    submissionRequest: createSubmissionRequest(unsafeWindow.fetch.bind(unsafeWindow)),
    // Native Window methods need the page window, not the userscript sandbox receiver.
    saveFilePicker:
      typeof unsafeWindow.showSaveFilePicker === 'function' ? unsafeWindow.showSaveFilePicker.bind(unsafeWindow) : null,
    storage: unsafeWindow.navigator?.storage,
    get: (key, fallback) => GM_getValue(`biliClip.${key}`, fallback),
    set: (key, value) => GM_setValue(`biliClip.${key}`, value),
  });
  GM_registerMenuCommand('打开贝报切片助手', app.open);
}
