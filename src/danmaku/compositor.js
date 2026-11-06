import {VideoSample} from 'mediabunny';
import {loadComments} from './archive.js';
import {loadEmotes, textTokens, emoteFrame} from './emotes.js';
import {DanmakuLayout, visibleComment} from './layout.js';
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
    const canvas = new OffscreenCanvas(width, height),
      overlay = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', {alpha: false}),
      ink = overlay.getContext('2d');
    if (!context || !ink) {
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
    function measure(event) {
      if (cache.has(event.text)) return cache.get(event.text);
      const parts = [];
      let width = 0,
        height = fontSize * 1.2;
      for (const text of textTokens(event.text)) {
        const asset = resources.assets.get(text.normalize('NFC'));
        if (asset) {
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
      },
      render(sample, timestamp) {
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
        for (const item of active) {
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
              ink.fillStyle = `#${(Number(item.color ?? 0xffffff) & 0xffffff).toString(16).padStart(6, '0')}`;
              if (frame) ink.drawImage(frame, x, y);
              else {
                ink.font = part.font;
                if (!part.emoji) {
                  ink.shadowColor = 'rgba(0, 0, 0, 0.5)';
                  ink.strokeText(part.text, x, y);
                  ink.shadowColor = 'transparent';
                }
                ink.fillText(part.text, x, y);
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
            context.beginPath();
            for (const [top, bottom] of regions) context.rect(0, top, width, bottom - top);
            context.clip();
            context.globalAlpha = 0.65;
            // Keep the original image transform: slicing drawImage's source can
            // change browser sampling/rounding even at apparently identical size.
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
        cache.clear();
        previous = regions = [];
        canvas.width = overlay.width = 1;
        canvas.height = overlay.height = 1;
      },
    };
  } catch (error) {
    resources.close();
    throw error;
  }
}
