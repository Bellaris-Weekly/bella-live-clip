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

// Darken a #rrggbb color toward black by the given fraction.
function darken(value, amount) {
  return `rgb(${[1, 3, 5].map(i => Math.round(parseInt(value.slice(i, i + 2), 16) * (1 - amount))).join(',')})`;
}

export function measureSuperChat(event, ink, fontSize, font, avatars) {
  const scale = fontSize / 40;
  const height = Math.ceil(fontSize * 1.2),
    pad = 6 * scale,
    inset = 3 * scale,
    avatarSize = height - inset * 2;
  const amount = `¥${Number(event.price).toLocaleString('en-US', {maximumFractionDigits: 2, useGrouping: false})}`;
  // Keep currency/digits in a text font even when the host only has a color
  // emoji font among the named CJK fallbacks.
  const amountFont = `700 ${fontSize * 0.7}px Arial, sans-serif`;
  ink.font = amountFont;
  const head = Math.min(7 * fontSize, inset + avatarSize + pad * 3 + ink.measureText(amount).width);
  const text = scText(event.text),
    textFont = `600 ${fontSize * 0.8}px ${font}`;
  ink.font = textFont;
  const body = Math.min(scMaxWidth(fontSize) - head, ink.measureText(text).width + pad * 2 + height * 0.35);
  const width = Math.ceil(head + body);
  const header = color(event.header_color, '#2A60B2');
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
        inset,
        avatarSize,
        amount,
        amountFont,
        text,
        textFont,
        face: event.face,
        avatar: avatars?.get(event.face) ?? null,
        background: color(event.bg_color, '#EDF5FF'),
        header,
        // Body text takes the tier color, darkened to read on the light body.
        // The platform's font_color is for its dark card and is often near white.
        foreground: darken(header, 0.25),
        border: Math.max(1, 2 * (fontSize / 40)),
      },
    ],
  };
}

export function drawSuperChat(target, part) {
  const {width, height, head, pad, inset, avatarSize} = part;
  const center = height / 2,
    avatarCenter = inset + avatarSize / 2,
    ring = part.border;
  target.save();
  target.beginPath();
  target.roundRect(0, 0, width, height, center);
  target.clip();
  target.fillStyle = part.background;
  target.fillRect(0, 0, width, height);
  target.fillStyle = part.header;
  target.fillRect(0, 0, head, height);
  // Avatar, or a portrait placeholder until the image arrives.
  target.save();
  target.beginPath();
  target.arc(avatarCenter, center, avatarSize / 2, 0, Math.PI * 2);
  target.fillStyle = part.background;
  target.fill();
  target.clip();
  if (part.avatar) target.drawImage(part.avatar, inset, center - avatarSize / 2, avatarSize, avatarSize);
  else {
    target.fillStyle = part.header;
    target.globalAlpha = 0.5;
    target.beginPath();
    target.arc(avatarCenter, center - avatarSize * 0.1, avatarSize * 0.2, 0, Math.PI * 2);
    target.fill();
    target.beginPath();
    target.ellipse(avatarCenter, center + avatarSize * 0.45, avatarSize * 0.34, avatarSize * 0.28, 0, 0, Math.PI * 2);
    target.fill();
  }
  target.restore();
  target.strokeStyle = 'rgba(255,255,255,0.85)';
  target.lineWidth = ring;
  target.beginPath();
  target.arc(avatarCenter, center, avatarSize / 2 - ring / 2, 0, Math.PI * 2);
  target.stroke();
  // CJK and Arial glyphs sit visually high on a middle baseline.
  const optical = height / 48;
  target.textBaseline = 'middle';
  target.font = part.amountFont;
  target.fillStyle = '#fff';
  const amountLeft = inset + avatarSize + pad;
  target.shadowColor = 'rgba(0,0,0,0.3)';
  target.shadowBlur = 2 * optical;
  target.fillText(part.amount, amountLeft, center + optical, head - amountLeft - pad);
  target.shadowColor = 'transparent';
  target.font = part.textFont;
  target.fillStyle = part.foreground;
  target.fillText(part.text, head + pad * 1.5, center + optical, width - head - pad * 2 - height * 0.35);
  target.restore();
  target.strokeStyle = part.header;
  target.lineWidth = part.border;
  const edge = part.border / 2;
  target.beginPath();
  target.roundRect(edge, edge, width - part.border, height - part.border, (height - part.border) / 2);
  target.stroke();
}
