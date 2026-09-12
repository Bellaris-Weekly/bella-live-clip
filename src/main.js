import { createApp } from './app.js';
import { BiliApi, createRequest } from './network.js';
if (!document.getElementById('bella-live-clip-host')) {
  const app = createApp({ api: new BiliApi(createRequest(GM_xmlhttpRequest)),
    get: (key,fallback) => GM_getValue(`biliClip.${key}`,fallback),
    set: (key,value) => GM_setValue(`biliClip.${key}`,value) });
  GM_registerMenuCommand('打开贝报切片助手',app.open);
  GM_registerMenuCommand('重置窗口位置',app.resetWindow);
}
