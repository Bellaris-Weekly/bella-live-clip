const FEEDBACK_SELECTOR = '.web-player-icon-feedback';
const INSTALLED_ATTRIBUTE = 'data-bella-live-screenshot-installed';
const SCREENSHOT_LABEL = '截图';
const CAMERA_ICON = '<svg data-bella-screenshot-icon viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="display:block;margin:8px;pointer-events:none;filter:drop-shadow(0 1px 2px #000a)"><path fill="white" fill-rule="evenodd" d="M8 5l1.5-2h5L16 5h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M12 8a4.5 4.5 0 1 0 0 9a4.5 4.5 0 0 0 0-9z"/></svg>';

// Walk only this control's ancestors so another player/editor cannot supply the frame.
function findScreenshotVideo(control, selectVideo) {
  for (let parent = control.parentElement; parent && parent !== control.ownerDocument?.body; parent = parent.parentElement) {
    if (parent.querySelector('video')) return selectVideo(parent);
  }
  return null;
}

function captureVideoPng(video, rootDocument) {
  if (!video || video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) {
    return Promise.reject(new Error('暂无画面，请稍后重试'));
  }
  // Draw synchronously in the click handler, before PNG encoding or any other await.
  return new Promise((resolve, reject) => {
    const canvas = rootDocument.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('截图失败，请重试');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      canvas.width = canvas.height = 0;
      if (blob) resolve(blob);
      else reject(new Error('截图失败，请重试'));
    }, 'image/png');
  });
}

function formatScreenshotFileName(date, identity) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`;
  const source = String(identity.streamerName || identity.roomId || '直播间').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return `${source}_${stamp}.png`;
}

function installLiveScreenshot({ rootDocument, selectVideo, getIdentity, download }) {
  // DOM attributes are shared across userscript sandboxes; globals are not.
  // Claim synchronously before observing or binding any controls. Each iframe owns its document.
  const root = rootDocument.documentElement;
  if (root.hasAttribute(INSTALLED_ATTRIBUTE)) return false;
  root.setAttribute(INSTALLED_ATTRIBUTE, '');
  const view = rootDocument.defaultView;
  const controls = new WeakSet();
  let notice = null;
  let noticeTimer = null;

  const clearNotice = () => {
    notice?.remove();
    notice = null;
    view.clearTimeout(noticeTimer);
  };

  const showNotice = (control, message) => {
    // Encoding may finish after the player has been replaced. The download still completes.
    if (!control.isConnected) return;
    clearNotice();
    notice = rootDocument.createElement('div');
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    notice.style.cssText = 'position:absolute;top:44px;right:12px;z-index:101;max-width:calc(100% - 24px);padding:8px 12px;border-radius:6px;background:#000c;color:#fff;font:13px/1.5 sans-serif;pointer-events:none;';
    control.parentElement.appendChild(notice);
    noticeTimer = view.setTimeout(clearNotice, 3500);
  };

  const enhance = (control) => {
    if (!control.querySelector('[data-bella-screenshot-icon]')) control.innerHTML = CAMERA_ICON;
    control.title = SCREENSHOT_LABEL;
    control.setAttribute('aria-label', SCREENSHOT_LABEL);
    control.setAttribute('role', 'button');
    control.tabIndex = 0;
    if (controls.has(control)) return;
    controls.add(control);
    let busy = false;
    const capture = async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) return;
      clearNotice();
      busy = true;
      control.setAttribute('aria-busy', 'true');
      try {
        const video = findScreenshotVideo(control, selectVideo);
        const fileName = formatScreenshotFileName(new Date(), getIdentity());
        const blob = await captureVideoPng(video, rootDocument);
        download(blob, fileName);
      } catch (error) {
        showNotice(control, error.name === 'SecurityError'
          ? '浏览器不允许截图'
          : error.message);
      } finally {
        busy = false;
        control.removeAttribute('aria-busy');
      }
    };
    // Capture phase prevents the site's original feedback click from firing.
    control.addEventListener('click', capture, true);
    control.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.repeat) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      capture(event);
    }, true);
  };

  const scan = (root) => {
    if (root.nodeType !== 1) return;
    if (root.matches(FEEDBACK_SELECTOR)) enhance(root);
    root.querySelectorAll(FEEDBACK_SELECTOR).forEach(enhance);
  };
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      const control = record.target.closest?.(FEEDBACK_SELECTOR);
      if (control) enhance(control);
      record.addedNodes.forEach(scan);
    }
  });
  // Also runs inside the player's iframe, before the main editor's top-window guard.
  observer.observe(rootDocument.documentElement, { childList: true, subtree: true });
  scan(rootDocument.documentElement);
  return true;
}

export { captureVideoPng, findScreenshotVideo, formatScreenshotFileName, installLiveScreenshot };
