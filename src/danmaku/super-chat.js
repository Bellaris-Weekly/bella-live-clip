// One shared geometry contract for layout, seeking and the cached Canvas sprite.
export const isSuperChat = event => event.kind === 'sc';
export const SC_OPACITY = 0.85;
export const SC_WAIT = 5;
export const scSpeed = width => (200 * width) / 1920;
export const scMaxWidth = fontSize => 48 * fontSize;
export const commentPreroll = (width, height) =>
  Math.max(
    15,
    Math.ceil((width + scMaxWidth((40 * height) / 1080) + (50 * height) / 1080) / scSpeed(width) + SC_WAIT + 1),
  );

const graphemes = new Intl.Segmenter('zh', {granularity: 'grapheme'});
export function scText(text) {
  const parts = [];
  for (const {segment} of graphemes.segment(String(text).replace(/\s+/gu, ' ').trim())) {
    if (parts.length === 40) return parts.join('') + '…';
    parts.push(segment);
  }
  return parts.join('');
}

function color(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function measureSuperChat(event, ink, fontSize, font, avatars) {
  const scale = fontSize / 40;
  const height = Math.ceil(fontSize * 1.2),
    pad = 6 * scale,
    avatarSize = height - pad;
  const amount = `¥${Number(event.price).toLocaleString('en-US', {maximumFractionDigits: 2, useGrouping: false})}`;
  // Keep currency/digits in a text font even when the host only has a color
  // emoji font among the named CJK fallbacks.
  const amountFont = `700 ${fontSize * 0.8}px Arial, sans-serif`;
  ink.font = amountFont;
  const head = Math.min(7 * fontSize, pad * 3 + avatarSize + ink.measureText(amount).width);
  const text = scText(event.text),
    textFont = `600 ${fontSize}px ${font}`;
  ink.font = textFont;
  const body = Math.min(scMaxWidth(fontSize) - head, ink.measureText(text).width + pad * 2);
  const width = Math.ceil(head + body);
  return {
    width,
    height,
    parts: [
      {
        sc: true,
        x: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        head,
        pad,
        avatarSize,
        amount,
        amountFont,
        text,
        textFont,
        avatar: avatars?.get(event.face) ?? null,
        background: color(event.bg_color, '#EDF5FF'),
        header: color(event.header_color, '#2A60B2'),
        // B's light body uses a dark foreground. The platform's font_color is for
        // its original dark card and is often nearly white, so cannot be copied here.
        foreground: '#17212b',
        border: Math.max(1, 2 * scale),
      },
    ],
  };
}

export function drawSuperChat(target, part) {
  const {width, height, head, pad, avatarSize} = part;
  target.save();
  target.beginPath();
  target.roundRect(0, 0, width, height, height / 2);
  target.clip();
  target.fillStyle = part.background;
  target.fillRect(0, 0, width, height);
  target.fillStyle = part.header;
  target.fillRect(0, 0, head, height);
  if (part.avatar) {
    target.save();
    target.beginPath();
    target.arc(pad + avatarSize / 2, height / 2, avatarSize / 2, 0, Math.PI * 2);
    target.clip();
    target.drawImage(part.avatar, pad, (height - avatarSize) / 2, avatarSize, avatarSize);
    target.restore();
  }
  target.textBaseline = 'middle';
  target.font = part.amountFont;
  target.fillStyle = '#fff';
  target.fillText(part.amount, avatarSize + pad * 2, height / 2, head - avatarSize - pad * 3);
  target.font = part.textFont;
  target.fillStyle = part.foreground;
  target.fillText(part.text, head + pad, height / 2, width - head - pad * 2);
  target.restore();
  target.strokeStyle = part.header;
  target.lineWidth = part.border;
  const inset = part.border / 2;
  target.beginPath();
  target.roundRect(inset, inset, width - part.border, height - part.border, (height - part.border) / 2);
  target.stroke();
}
