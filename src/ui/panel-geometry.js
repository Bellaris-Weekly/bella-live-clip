import {clamp} from '../shared/math.js';

export function constrainRect(rect, viewport) {
  const margin = 10;
  const maxW = Math.max(1, viewport.width - margin * 2);
  const maxH = Math.max(1, viewport.height - margin * 2);
  const width = clamp(rect.width, Math.min(360, maxW), maxW);
  const height = clamp(rect.height, Math.min(480, maxH), maxH);
  return { width, height, left: clamp(rect.left, margin, viewport.width - margin - width),
    top: clamp(rect.top, margin, viewport.height - margin - height) };
}

export function resizeRect(rect, edge, dx, dy, viewport) {
  let { left, top, width, height } = rect;
  const minW = Math.min(360, viewport.width - 20), minH = Math.min(480, viewport.height - 20);
  if (edge.includes('e')) width = clamp(width + dx, minW, viewport.width - 10 - left);
  if (edge.includes('s')) height = clamp(height + dy, minH, viewport.height - 10 - top);
  if (edge.includes('w')) { const shift = clamp(dx, 10 - left, width - minW); left += shift; width -= shift; }
  if (edge.includes('n')) { const shift = clamp(dy, 10 - top, height - minH); top += shift; height -= shift; }
  return { left, top, width, height };
}
