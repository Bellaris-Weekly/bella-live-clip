// Read the actual download and computed hover styles without replacing app handlers.
export function observePreviewScreenshots(app) {
  const root = app.root,
    wrap = root.getElementById('playerWrap'),
    button = root.getElementById('previewScreenshot');
  const report = document.getElementById('result');
  const result = {downloads: 0, hoverShown: false, leaveHidden: false};
  const show = () => {
    report.textContent = JSON.stringify(result);
  };
  for (const event of ['pointerenter', 'pointerleave'])
    wrap.addEventListener(event, () =>
      setTimeout(() => {
        const style = getComputedStyle(button);
        if (event === 'pointerenter') result.hoverShown = style.opacity === '1' && style.pointerEvents === 'auto';
        else result.leaveHidden = style.opacity === '0' && style.pointerEvents === 'none';
        show();
      }, 250),
    );
  new MutationObserver(records => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (node.nodeName !== 'A' || !node.download.endsWith('.png')) continue;
        void (async () => {
          const video = root.getElementById('fullVideo');
          const blob = await (await fetch(node.href)).blob();
          const bitmap = await createImageBitmap(blob);
          Object.assign(result, {
            downloads: result.downloads + 1,
            png: blob.type === 'image/png',
            width: bitmap.width,
            height: bitmap.height,
            nativeSize: bitmap.width === video.videoWidth && bitmap.height === video.videoHeight,
            name: node.download,
          });
          bitmap.close();
          show();
          await fetch('/artifact/preview-screenshot-browser-results.json', {
            method: 'POST',
            body: JSON.stringify(result),
          });
        })();
      }
  }).observe(document.body, {childList: true});
  show();
}
