import {fittedRect} from '../shared/fit.js';

// object-fit rounds the element's box, not the picture inside its black bars.
// Clip each fitted picture, without changing its size or the overlay alignment.
export function bindPreviewCorners(container) {
  const layers = [...container.querySelectorAll('#fullVideo, #pageMirror, #danmakuPreview, #videoStill')];
  if (!layers.length) return () => {};
  let width = container.clientWidth,
    height = container.clientHeight;
  const update = () => {
    if (!(width > 0 && height > 0)) return;
    for (const layer of layers) {
      const sourceWidth = layer.videoWidth ?? layer.naturalWidth ?? layer.width;
      const sourceHeight = layer.videoHeight ?? layer.naturalHeight ?? layer.height;
      const {x, y} = fittedRect(sourceWidth, sourceHeight, width, height);
      layer.style.setProperty('--picture-inset', `${y}px ${x}px`);
    }
  };
  const resize = new ResizeObserver(([entry]) => {
    ({width, height} = entry.contentRect);
    update();
  });
  resize.observe(container);
  const dimensions = new MutationObserver(update);
  const events = ['loadedmetadata', 'resize', 'load'];
  for (const layer of layers) {
    dimensions.observe(layer, {attributes: true, attributeFilter: ['width', 'height']});
    for (const event of events) layer.addEventListener(event, update);
  }
  update();
  return () => {
    resize.disconnect();
    dimensions.disconnect();
    for (const layer of layers) for (const event of events) layer.removeEventListener(event, update);
  };
}
