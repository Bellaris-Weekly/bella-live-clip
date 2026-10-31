// Frames keep their shape: portrait broadcasts and videos are letterboxed
// rather than stretched into a landscape thumbnail.
export function fittedRect(sourceWidth, sourceHeight, width, height) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) return {x: 0, y: 0, width, height};
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const fittedWidth = sourceWidth * scale, fittedHeight = sourceHeight * scale;
  return {x: (width - fittedWidth) / 2, y: (height - fittedHeight) / 2, width: fittedWidth, height: fittedHeight};
}

export function drawFitted(context, draw, sourceWidth, sourceHeight, width, height) {
  context.fillStyle = '#000';
  context.fillRect?.(0, 0, width, height);
  const rect = fittedRect(sourceWidth, sourceHeight, width, height);
  draw(rect.x, rect.y, rect.width, rect.height);
}
