// Full-frame pixel oracle. Defaults preserve the 2.13.1 appearance for benchmarks.
import {VideoSample} from 'mediabunny';
import {loadComments} from '../../../src/danmaku/archive.js';
import {loadEmotes, textTokens, emoteFrame} from '../../../src/danmaku/emotes.js';
import {DanmakuLayout} from './danmaku-layout-reference.js';
// Frozen ordinary-comment reference before SC support.
const PREROLL = 15;

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const EMOJI_RUN =
  /(\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;
const FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export async function createDanmakuCompositor(
  record,
  {origin, start, end, sourceTime, width, height, adjustment, signal, fetcher, appearance = {}},
) {
  if (width * height > 3840 * 2160) throw new Error('弹幕压制画面超过 4K 内存预算，请选择更低画质。');
  const events = await loadComments(record, {
    origin,
    start: sourceTime(start) - PREROLL,
    end: sourceTime(end),
    adjustment,
    signal,
    fetcher,
  });
  const resources = await loadEmotes(events, record.room, ((appearance.fontSize ?? 45) * height) / 1080, {
    signal,
    fetcher,
  });
  return createDanmakuPainter(events, resources, {start, sourceTime, width, height, signal, appearance});
}

export function createDanmakuPainter(events, resources, {start, sourceTime, width, height, signal, appearance = {}}) {
  const style = {
    fontSize: 45,
    lineWidth: 2,
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    ...appearance,
  };
  const fontSize = (style.fontSize * height) / 1080;
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
    ink.lineWidth = (style.lineWidth * height) / 1080;
    ink.strokeStyle = '#000';
    ink.shadowBlur = (style.shadowBlur * height) / 1080;
    ink.shadowOffsetX = (style.shadowOffsetX * height) / 1080;
    ink.shadowOffsetY = (style.shadowOffsetY * height) / 1080;
    const cache = new Map();
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
            parts.push({text: run, font, emoji, x: width});
            width += ink.measureText(run).width;
          }
        }
      }
      const content = {width, height, parts};
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(event.text, content);
      return content;
    }
    const layout = new DanmakuLayout(events, {width, height, measure, start: sourceTime(start) - PREROLL});
    return {
      layout,
      render(sample, timestamp) {
        signal?.throwIfAborted();
        const time = sourceTime(timestamp);
        sample.draw(context, 0, 0, width, height);
        ink.clearRect(0, 0, width, height);
        for (const item of layout.advance(time)) {
          if (item.parts.some(part => part.asset?.failed)) {
            cache.delete(item.text);
            Object.assign(item, measure(item));
          }
          const x = layout.x(item, time);
          ink.fillStyle = `#${(Number(item.color ?? 0xffffff) & 0xffffff).toString(16).padStart(6, '0')}`;
          for (const part of item.parts) {
            const y = item.top + (item.height - (part.asset?.height ?? fontSize * 1.2)) / 2;
            if (part.asset) ink.drawImage(emoteFrame(part.asset, time - item.started), x + part.x, y);
            else {
              ink.font = part.font;
              if (!part.emoji) {
                ink.shadowColor = style.shadowColor;
                ink.strokeText(part.text, x + part.x, y);
                ink.shadowColor = 'transparent';
              }
              ink.fillText(part.text, x + part.x, y);
            }
          }
        }
        context.globalAlpha = 0.75;
        context.drawImage(overlay, 0, 0);
        context.globalAlpha = 1;
        return new VideoSample(canvas, {timestamp: sample.timestamp, duration: sample.duration});
      },
      close() {
        resources.close();
        cache.clear();
        canvas.width = overlay.width = 1;
        canvas.height = overlay.height = 1;
      },
    };
  } catch (error) {
    resources.close();
    throw error;
  }
}
