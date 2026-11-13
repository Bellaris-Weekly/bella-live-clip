import {VideoSample} from 'mediabunny';
import {loadComments} from './archive.js';
import {loadEmotes, textTokens, emoteFrame} from './emotes.js';
import {DanmakuLayout, visibleComment} from './layout.js';
import {createSpriteCache} from './sprite-cache.js';
import {PREROLL} from './clock.js';

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const EMOJI_RUN =
  /(\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;
const FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export const danmakuFontSize = height => (40 * height) / 1080;

export async function createDanmakuCompositor(
  record,
  {origin, start, end, sourceTime, width, height, adjustment, signal, fetcher, prepared},
) {
  if (width * height > 3840 * 2160) throw new Error('弹幕压制画面超过 4K 内存预算，请选择更低画质。');
  const events = await loadComments(record, {
    origin,
    start: sourceTime(start) - PREROLL,
    end: sourceTime(end),
    adjustment,
    signal,
    fetcher,
    prepared,
  });
  prepared = undefined;
  const fontSize = danmakuFontSize(height);
  const resources = await loadEmotes(events.filter(visibleComment), record.room, fontSize, {signal, fetcher});
  return createDanmakuPainter(events, resources, {start, sourceTime, width, height, signal});
}

export function createDanmakuPainter(events, resources, {start, sourceTime, width, height, signal, metrics}) {
  if (width * height > 3840 * 2160) throw new Error('弹幕压制画面超过 4K 内存预算，请选择更低画质。');
  const fontSize = danmakuFontSize(height);
  try {
    const overlay = new OffscreenCanvas(width, height);
    const ink = overlay.getContext('2d');
    let canvas, context;
    if (!ink) {
      resources.close();
      throw new Error('无法创建弹幕合成画布，可能内存不足。');
    }
    ink.font = `600 ${fontSize}px ${FONT}`;
    ink.textBaseline = 'top';
    ink.lineJoin = 'round';
    ink.lineWidth = (2 * height) / 1080;
    ink.strokeStyle = '#000';
    ink.shadowBlur = (2 * height) / 1080;
    ink.shadowOffsetX = ink.shadowOffsetY = height / 1080;
    // Include the soft shadow in both dirty-row clearing and compositing.
    const shadowPadding = Math.ceil(ink.shadowBlur * 2 + Math.abs(ink.shadowOffsetY));
    const cache = new Map();
    const sprites = createSpriteCache({metrics});
    function drawText(target, item, part, x, y) {
      target.font = part.font;
      target.fillStyle = `#${(Number(item.color ?? 0xffffff) & 0xffffff).toString(16).padStart(6, '0')}`;
      if (!part.emoji) {
        target.shadowColor = 'rgba(0, 0, 0, 0.5)';
        target.strokeText(part.text, x, y);
        target.shadowColor = 'transparent';
      }
      target.fillText(part.text, x, y);
    }
    function raster(item, part, x, y, maxBytes) {
      // Preserve the first draw's subpixel phase. Fixed comments then use an
      // integer bitmap translation instead of filtering an integer-phase glyph.
      const phase = x - Math.floor(x);
      const left = Math.floor(part.left + phase) - phase,
        top = Math.floor(y + part.top) - y;
      const w = Math.ceil(part.right - left),
        h = Math.ceil(part.bottom - top);
      const bytes = w * h * 4;
      // Pathological long comments fall back to clipped canvas text.
      if (!(w > 0 && h > 0) || w > 16384 || bytes > maxBytes) return null;
      const surface = new OffscreenCanvas(w, h),
        target = surface.getContext('2d');
      target.textBaseline = 'top';
      target.lineJoin = 'round';
      target.lineWidth = ink.lineWidth;
      target.strokeStyle = '#000';
      target.shadowBlur = ink.shadowBlur;
      target.shadowOffsetX = target.shadowOffsetY = height / 1080;
      drawText(target, item, part, -left, -top);
      // Complete deferred glyph/shadow rasterization once for this item part.
      const image = surface.transferToImageBitmap();
      return {image, left, top, bytes};
    }
    function measure(event) {
      if (cache.has(event.text)) return cache.get(event.text);
      const parts = [];
      let width = 0,
        height = fontSize * 1.2;
      for (const text of textTokens(event.text)) {
        const asset = resources.assets.get(text.normalize('NFC'));
        if (asset && !asset.failed) {
          parts.push({asset, x: width});
          width += asset.width;
          height = Math.max(height, asset.height);
        } else {
          for (const run of text.split(EMOJI_RUN).filter(Boolean)) {
            const emoji = EMOJI_RUN.test(run);
            const font = `${emoji ? '400' : '600'} ${fontSize}px ${emoji ? EMOJI_FONT : FONT}`;
            ink.font = font;
            const metrics = ink.measureText(run);
            parts.push({
              text: run,
              font,
              emoji,
              x: width,
              left: -metrics.actualBoundingBoxLeft - ink.lineWidth - 2 - (emoji ? 0 : shadowPadding),
              right: metrics.actualBoundingBoxRight + ink.lineWidth + 2 + (emoji ? 0 : shadowPadding),
              top: -metrics.actualBoundingBoxAscent - ink.lineWidth - 2 - (emoji ? 0 : shadowPadding),
              bottom: metrics.actualBoundingBoxDescent + ink.lineWidth + 2 + (emoji ? 0 : shadowPadding),
            });
            width += metrics.width;
          }
        }
      }
      const content = {width, height, parts};
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(event.text, content);
      return content;
    }
    const layout = new DanmakuLayout(events, {width, height, measure, start: sourceTime(start) - PREROLL});
    let previous = [],
      regions = [];
    return {
      layout,
      clearMeasurements() {
        cache.clear();
        sprites.clear();
        previous = [];
      },
      renderOverlay(timestamp) {
        signal?.throwIfAborted();
        const time = sourceTime(timestamp);
        const commands = [];
        const finishLayout = metrics?.start('layout');
        let active;
        try {
          active = layout.advance(time);
        } finally {
          finishLayout?.();
        }
        sprites.retain(active);
        for (const item of active) {
          if (item.parts.some(part => part.asset?.failed)) {
            sprites.delete(item);
            cache.delete(item.text);
            Object.assign(item, measure(item));
          }
          const x = layout.x(item, time);
          for (const part of item.parts) {
            const y = item.top + (item.height - (part.asset?.height ?? fontSize * 1.2)) / 2;
            commands.push({
              item,
              part,
              x: x + part.x,
              y,
              frame: part.asset ? emoteFrame(part.asset, time - item.started) : null,
            });
          }
        }
        // Fixed comments and unchanged animation frames reuse the existing ink.
        const changed =
          commands.length !== previous.length ||
          commands.some((command, i) => {
            const old = previous[i];
            return (
              command.item !== old.item ||
              command.part !== old.part ||
              command.x !== old.x ||
              command.y !== old.y ||
              command.frame !== old.frame
            );
          });
        if (changed) {
          metrics?.add('overlayRedraws');
          const finishOverlay = metrics?.start('overlayDraw');
          try {
            for (const [top, bottom] of regions) ink.clearRect(0, top, width, bottom - top);
            const rows = [];
            for (const {item, part, x, y, frame} of commands) {
              const top = Math.max(0, Math.floor(y + (frame ? -2 : part.top)));
              const bottom = Math.min(height, Math.ceil(y + (frame ? part.asset.height + 2 : part.bottom)));
              if (Number.isFinite(top) && Number.isFinite(bottom)) {
                if (bottom > top) rows.push([top, bottom]);
              } else rows.push([0, height]);
              if (frame) ink.drawImage(frame, x, y);
              else {
                const sprite = sprites.get(item, part, limit => raster(item, part, x, y, limit));
                if (sprite) ink.drawImage(sprite.image, x + sprite.left, y + sprite.top);
                else drawText(ink, item, part, x, y);
              }
            }
            regions = [];
            for (const row of rows.sort((a, b) => a[0] - b[0])) {
              const last = regions.at(-1);
              if (last && row[0] <= last[1]) last[1] = Math.max(last[1], row[1]);
              else regions.push(row);
            }
            previous = commands;
          } finally {
            finishOverlay?.();
          }
        } else metrics?.add('overlayReuses');
        return overlay;
      },
      render(sample, timestamp) {
        this.renderOverlay(timestamp);
        canvas ??= new OffscreenCanvas(width, height);
        context ??= canvas.getContext('2d', {alpha: false});
        // The export entry rejects rotation. Avoid the generic per-frame
        // save/translate/rotate path while keeping the same full-frame scaling.
        const finishVideo = metrics?.start('videoDraw');
        try {
          context.drawImage(sample.toCanvasImageSource(), 0, 0, width, height);
        } finally {
          finishVideo?.();
        }
        if (regions.length) {
          const finishComposite = metrics?.start('overlayComposite');
          try {
            context.save();
            context.globalAlpha = 0.65;
            // One clipped layer preserves opacity across overlapping comments
            // and avoids uploading a separate canvas for each occupied strip.
            context.beginPath();
            for (const [top, bottom] of regions) context.rect(0, top, width, bottom - top);
            context.clip();
            context.drawImage(overlay, 0, 0);
            context.restore();
          } finally {
            finishComposite?.();
          }
        }
        const finishSnapshot = metrics?.start('frameSnapshot');
        try {
          return new VideoSample(canvas, {timestamp: sample.timestamp, duration: sample.duration});
        } finally {
          finishSnapshot?.();
        }
      },
      close() {
        resources.close();
        sprites.clear();
        cache.clear();
        previous = regions = [];
        if (canvas) canvas.width = canvas.height = 1;
        overlay.width = overlay.height = 1;
      },
    };
  } catch (error) {
    resources.close();
    throw error;
  }
}
