import metadataText from './header.txt';
import {readScriptMetadata} from './services/updates.js';
import {createDiagnosticReporter} from './services/diagnostics.js';
import {createApp} from './app/application.js';
import {BiliApi, createRequest} from './services/bilibili.js';
import {createSubmissionRequest} from './services/submission-request.js';
import {createMediaRequest} from './services/media-request.js';
import {startLiveScreenshot} from './app/live-screenshot.js';

if (location.hostname === 'live.bilibili.com') startLiveScreenshot(document);

if (window.top === window && !document.getElementById('bella-live-clip-host')) {
  const diagnostics = createDiagnosticReporter({
    endpoint: typeof __LOG_SERVICE_ENDPOINT__ === 'string' ? __LOG_SERVICE_ENDPOINT__ : '',
    request: GM_xmlhttpRequest,
    version: readScriptMetadata(metadataText).version,
    userAgent: navigator.userAgent,
  });
  const request = createRequest(GM_xmlhttpRequest);
  const app = createApp({
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
