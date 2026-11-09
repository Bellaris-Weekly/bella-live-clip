import {installLiveScreenshot} from '../ui/live-screenshot.js';

function selectVideo(root) {
  return (
    [...root.querySelectorAll('video')]
      .filter(video => video.readyState >= 2 && video.videoWidth && video.videoHeight)
      .map(video => {
        const rect = video.getBoundingClientRect();
        const style = video.ownerDocument.defaultView.getComputedStyle(video);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0;
        return {video, area: visible ? rect.width * rect.height : 0};
      })
      .filter(item => item.area > 0)
      .sort((a, b) => b.area - a.area)[0]?.video || null
  );
}

function getIdentity(document) {
  const roomId = document.defaultView.location.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/)?.[1] || '';
  const owner = document.querySelector('.room-owner-username')?.textContent?.trim();
  const titleParts = document.title
    .split(' - ')
    .map(part => part.trim())
    .filter(Boolean);
  const titleOwner = titleParts.length >= 3 ? titleParts[titleParts.length - 2] : '';
  return {streamerName: owner || titleOwner, roomId};
}

// Runs in live player frames too; the editor and menu stay in the top window.
export function startLiveScreenshot(document, studio) {
  if (typeof __PREVIEW__ !== 'undefined' && __PREVIEW__) {
    const style = document.createElement('style');
    const update = () => {
      style.textContent = studio.identity() ? '' : '.web-player-icon-feedback {display:none!important}';
    };
    update();
    studio.subscribe(update);
    document.documentElement.append(style);
  }
  return installLiveScreenshot({
    rootDocument: document,
    selectVideo:
      typeof __PREVIEW__ !== 'undefined' && __PREVIEW__
        ? root => (studio.identity() ? selectVideo(root) : null)
        : selectVideo,
    getIdentity: () => getIdentity(document),
    download: (blob, name) => downloadScreenshot(document, blob, name),
  });
}

export function downloadScreenshot(document, blob, name) {
  const view = document.defaultView;
  const url = view.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 60000);
}
