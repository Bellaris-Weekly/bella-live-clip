import { createApp } from './app/application.js';
import { BiliApi, createRequest } from './services/bilibili.js';
import {createSubmissionRequest} from './services/submission-request.js';
if (!document.getElementById('bella-live-clip-host')) {
  const app = createApp({ api: new BiliApi(createRequest(GM_xmlhttpRequest)),
    submissionRequest: createSubmissionRequest(unsafeWindow.fetch.bind(unsafeWindow)),
    // Native Window methods need the page window, not the userscript sandbox receiver.
    saveFilePicker: typeof unsafeWindow.showSaveFilePicker === 'function' ? unsafeWindow.showSaveFilePicker.bind(unsafeWindow) : null,
    get: (key,fallback) => GM_getValue(`biliClip.${key}`,fallback),
    set: (key,value) => GM_setValue(`biliClip.${key}`,value) });
  GM_registerMenuCommand('打开贝报切片助手',app.open);
}
