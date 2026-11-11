import {signal} from '@preact/signals';
import {MEMBERS} from '../domain/records.js';

// Bilibili takes two covers: 16:9 for the video page and search, 4:3 for feeds that crop.
export const OUTPUTS = {
  wide: {width: 1920, height: 1080, ratio: 16 / 9, label: '16:9'},
  tall: {width: 1440, height: 1080, ratio: 4 / 3, label: '4:3'},
};
const MAX_ZOOM = 4,
  MAX_BYTES = 5 * 1024 ** 2,
  SNAP = 0.015;
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif';
export const TEXT_STYLES = [
  {id: 'outline', label: '描边'},
  {id: 'band', label: '底条'},
  {id: 'shadow', label: '阴影'},
];
export const TEXT_COLORS = ['#ffffff', '#ffd23f', '#ff5c5c', '#111111', ...MEMBERS.map(member => member.color)];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// The largest rectangle of `ratio` inside the source, centered.
function centerCrop(width, height, ratio) {
  const w = Math.min(width, height * ratio),
    h = w / ratio;
  return {x: (width - w) / 2, y: (height - h) / 2, w, h};
}
// A crop is a center and a zoom over the source; the rectangle always stays inside it.
export function cropRect(source, ratio, crop) {
  const base = centerCrop(source.width, source.height, ratio);
  const w = base.w / clamp(crop?.zoom ?? 1, 1, MAX_ZOOM),
    h = w / ratio;
  const cx = crop?.cx ?? source.width / 2,
    cy = crop?.cy ?? source.height / 2;
  return {
    x: clamp(cx - w / 2, 0, source.width - w),
    y: clamp(cy - h / 2, 0, source.height - h),
    w,
    h,
  };
}
function cropOf(rect, zoom) {
  return {cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, zoom};
}
function fitsExactly(source, ratio) {
  return Math.abs(source.width / source.height - ratio) < 0.01;
}

const freshLayer = () => ({source: 'frame', image: null, crop: null, pos: {x: 0.5, y: 0.8}, showText: true});
export function initialCover(frame = null) {
  return {
    frame,
    wide: freshLayer(),
    tall: freshLayer(),
    follow: true,
    text: {value: '', style: 'outline', color: '#ffffff', size: 0.1},
  };
}
export function sourceOf(state, layer) {
  return layer.source === 'image' ? layer.image : state.frame?.image || null;
}
// While following, 4:3 is 16:9 seen through a narrower window: same picture, same center,
// same height, same text placement.
export function layerOf(state, key) {
  if (key === 'wide' || !state.follow) return state[key];
  const wide = state.wide,
    source = sourceOf(state, wide);
  if (!source) return {...wide};
  const wideRect = cropRect(source, OUTPUTS.wide.ratio, wide.crop);
  const base = centerCrop(source.width, source.height, OUTPUTS.tall.ratio);
  return {...wide, crop: {...cropOf(wideRect, 1), zoom: clamp(base.h / wideRect.h, 1, MAX_ZOOM)}};
}

function layoutText(context, text, width, height) {
  const px = text.size * height;
  context.font = `900 ${px}px ${FONT}`;
  const maxWidth = width * 0.9,
    lines = [];
  for (const paragraph of text.value.split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (line && context.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    lines.push(line);
  }
  const lineHeight = px * 1.22;
  return {
    px,
    lines,
    lineHeight,
    width: Math.max(...lines.map(line => context.measureText(line).width)),
    height: lines.length * lineHeight,
  };
}
const darkColor = color => {
  const value = parseInt(color.slice(1), 16);
  return 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255) < 128;
};
// Draws one cover in output coordinates and returns the text box, also in output coordinates.
export function drawCover(context, state, key, {width, height} = OUTPUTS[key]) {
  const layer = layerOf(state, key),
    source = sourceOf(state, layer);
  context.fillStyle = '#0b0b10';
  context.fillRect(0, 0, width, height);
  if (source) {
    const rect = cropRect(source, width / height, layer.crop);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
  }
  const text = state.text;
  if (!layer.showText || !text.value.trim()) return null;
  const block = layoutText(context, text, width, height);
  const cx = layer.pos.x * width,
    top = layer.pos.y * height - block.height / 2;
  const box = {x: cx - block.width / 2, y: top, w: block.width, h: block.height};
  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  if (text.style === 'band') {
    const pad = block.px * 0.3;
    context.fillStyle = 'rgba(0, 0, 0, 0.58)';
    context.beginPath();
    context.roundRect(box.x - pad, box.y - pad / 2, box.w + pad * 2, box.h + pad, pad * 0.6);
    context.fill();
  }
  if (text.style === 'shadow') {
    context.shadowColor = 'rgba(0, 0, 0, 0.7)';
    context.shadowBlur = block.px * 0.18;
    context.shadowOffsetY = block.px * 0.05;
  }
  block.lines.forEach((line, index) => {
    const y = top + block.lineHeight * (index + 0.5);
    if (text.style === 'outline') {
      context.strokeStyle = darkColor(text.color) ? '#ffffff' : '#000000';
      context.lineWidth = block.px * 0.16;
      context.strokeText(line, cx, y);
    }
    context.fillStyle = text.color;
    context.fillText(line, cx, y);
  });
  context.restore();
  return box;
}

// Mostly black frames come from a frame grabbed before it was decoded; say so instead of uploading one.
export function isDark(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(image, 0, 0, 32, 18);
  const data = context.getImageData(0, 0, 32, 18).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / (data.length / 4) < 12;
}

async function toFile(state, key) {
  const {width, height} = OUTPUTS[key];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  drawCover(canvas.getContext('2d'), state, key);
  for (const quality of [0.92, 0.82, 0.7]) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('封面生成失败');
    if (blob.size <= MAX_BYTES) return new File([blob], `cover-${key}.jpg`, {type: 'image/jpeg'});
  }
  throw new Error('封面超过 5 MB，请换一张图片');
}

// The cover being made for one submission: a frame or picked images, two crops, one text.
export function createCover() {
  const state = signal(initialCover()),
    active = signal('wide'),
    notice = signal('');
  const update = next => (state.value = next);
  // Editing 4:3 while it follows first gives it its own copy of what it showed.
  function editable(key) {
    const current = state.value;
    if (key === 'tall' && current.follow) return {...current, follow: false, tall: layerOf(current, 'tall')};
    return current;
  }
  function changeLayer(key, change) {
    const current = editable(key);
    update({...current, [key]: {...current[key], ...change(current[key], current)}});
  }
  function sourceSize(key) {
    const current = state.value;
    return sourceOf(current, layerOf(current, key));
  }
  return {
    state,
    active,
    notice,
    // A new submission starts clean, keeping a frame already picked for this clip.
    reset(frame = null) {
      update(initialCover(frame));
      active.value = 'wide';
      notice.value = frame?.dark ? DARK_NOTICE : '';
    },
    setFrame(frame) {
      update({...state.value, frame});
      notice.value = frame.dark ? DARK_NOTICE : '';
    },
    // A picked image replaces this ratio's picture (and 4:3's too while it follows). One that
    // already has the right shape is used as it is: a finished cover gets no extra text.
    setImage(key, image) {
      const exact = fitsExactly(image, OUTPUTS[key].ratio);
      changeLayer(key, () => ({source: 'image', image, crop: null, showText: !exact}));
      notice.value = '';
    },
    useFrame(key) {
      changeLayer(key, () => ({source: 'frame', image: null, crop: null, showText: true}));
    },
    pan(key, start, dx, dy) {
      const source = sourceSize(key);
      if (!source) return;
      const {width, ratio} = OUTPUTS[key];
      const scale = start.rect.w / width;
      changeLayer(key, () => ({
        crop: cropOf(
          cropRect(source, ratio, {
            cx: start.rect.x + start.rect.w / 2 - dx * scale,
            cy: start.rect.y + start.rect.h / 2 - dy * scale,
            zoom: start.zoom,
          }),
          start.zoom,
        ),
      }));
    },
    // Zooms around a point of the output, keeping the picture under it in place.
    zoom(key, factor, at = {x: 0.5, y: 0.5}) {
      const source = sourceSize(key);
      if (!source) return;
      const {ratio} = OUTPUTS[key];
      const layer = layerOf(state.value, key);
      const rect = cropRect(source, ratio, layer.crop),
        zoom = clamp((layer.crop?.zoom ?? 1) * factor, 1, MAX_ZOOM);
      const base = centerCrop(source.width, source.height, ratio);
      const w = base.w / zoom,
        h = w / ratio;
      const px = rect.x + at.x * rect.w,
        py = rect.y + at.y * rect.h;
      changeLayer(key, () => ({
        crop: cropOf(cropRect(source, ratio, {cx: px - at.x * w + w / 2, cy: py - at.y * h + h / 2, zoom}), zoom),
      }));
    },
    // Text positions are fractions of the cover; near the middle they snap to it.
    moveText(key, x, y) {
      const snapped = {
        x: Math.abs(x - 0.5) < SNAP ? 0.5 : clamp(x, 0, 1),
        y: Math.abs(y - 0.5) < SNAP ? 0.5 : clamp(y, 0, 1),
      };
      changeLayer(key, () => ({pos: snapped}));
      return snapped;
    },
    setText(change) {
      update({...state.value, text: {...state.value.text, ...change}});
    },
    showText(key, shown) {
      changeLayer(key, () => ({showText: shown}));
    },
    resetLayer(key) {
      changeLayer(key, () => ({crop: null, pos: {x: 0.5, y: 0.8}}));
    },
    follow() {
      update({...state.value, follow: true, tall: freshLayer()});
    },
    zoomOf: key => layerOf(state.value, key).crop?.zoom ?? 1,
    // Too few source pixels behind the crop: the cover will look soft.
    lowResolution(key) {
      const source = sourceSize(key);
      if (!source) return false;
      return cropRect(source, OUTPUTS[key].ratio, layerOf(state.value, key).crop).w < OUTPUTS[key].width / 2;
    },
    async files() {
      if (!sourceSize('wide') || !sourceSize('tall')) throw new Error('封面还没有画面，请先设定封面');
      const current = state.value;
      return {wide: await toFile(current, 'wide'), tall: await toFile(current, 'tall')};
    },
  };
}
const DARK_NOTICE = '这一帧几乎是黑的。可以回到剪辑换一帧，或稍等画面加载后重新设为封面。';

export async function readImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('只能使用图片文件');
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error('这张图片无法读取');
  }
}
