import {MEMBERS} from '../domain/records.js';

// One shared geometry contract for layout, seeking and the cached Canvas sprite.
// Capsules are SCs and the members' own comments; both share speed and queue.
export const isSuperChat = event => event.kind === 'sc';
const MEMBER_BY_UID = new Map(MEMBERS.map(member => [String(member.uid), member]));
export const anchorOf = event => (isSuperChat(event) ? undefined : MEMBER_BY_UID.get(String(event.uid)));
export const isCapsule = event => isSuperChat(event) || !!anchorOf(event);
export const capsuleFace = event => (isSuperChat(event) ? event.face : anchorOf(event)?.face);
export const SC_OPACITY = 0.85;
export const SC_WAIT = 5;
// Largest avatar drawn: the member band's oversized face.
export const avatarSize = fontSize => fontSize * 2.2;
// Cheaper SCs (mostly ¥2) keep the capsule but queue like ordinary comments.
export const SC_PRIORITY_PRICE = 30;
// Members can only fit two bands at once; wait longer rather than drop.
export const MEMBER_WAIT = 10;
export const scSpeed = width => (200 * width) / 1920;
export const scMaxWidth = fontSize => 48 * fontSize;
export const commentPreroll = (width, height) =>
  Math.max(
    15,
    Math.ceil((width + scMaxWidth((40 * height) / 1080) + (50 * height) / 1080) / scSpeed(width) + MEMBER_WAIT + 1),
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

// Mix a #rrggbb color toward black (amount < 0) or white (amount > 0).
function shade(value, amount) {
  const target = amount < 0 ? 0 : 255,
    t = Math.abs(amount);
  return `rgb(${[1, 3, 5].map(i => Math.round(parseInt(value.slice(i, i + 2), 16) * (1 - t) + target * t)).join(',')})`;
}

export function measureCapsule(event, ink, fontSize, font, options = {}) {
  if (anchorOf(event)) return measureMember(event, ink, fontSize, font, options);
  const {avatars} = options;
  const scale = fontSize / 40;
  const pad = 6 * scale,
    inset = 3 * scale,
    height = Math.ceil(fontSize * 1.2),
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
        text: [{text, x: head + pad * 1.5}],
        textFont,
        face: event.face,
        avatar: avatars?.get(event.face) ?? null,
        background: color(event.bg_color, '#EDF5FF'),
        header,
        // Body text takes the tier color, darkened to read on the light body.
        // The platform's font_color is for its dark card and is often near white.
        foreground: shade(header, -0.25),
        border: Math.max(1, 2 * scale),
      },
    ],
  };
}

// Member comments: a two-line band in the member color with an oversized avatar,
// a soft glow and danmaku-style text. Emotes are separate parts drawn per frame
// over the static sprite; a two-line emote fits the band exactly.
function measureMember(event, ink, fontSize, font, {avatars, assets, tokens}) {
  const member = anchorOf(event);
  const scale = fontSize / 40;
  const glow = 8 * scale,
    inset = 3 * scale,
    band = Math.ceil(fontSize * 1.8 + inset * 2),
    avatarSize = band + 10 * scale,
    pad = 10 * scale;
  const textFont = `700 ${fontSize * 1.3}px ${font}`;
  const runs = [];
  for (const token of tokens(event.text)) {
    const asset = assets?.get(token.normalize('NFC'));
    runs.push(asset && !asset.failed ? {asset} : {text: token});
  }
  const height = Math.ceil(Math.max(band, avatarSize) + glow * 2);
  const head = glow + inset + avatarSize + pad;
  const limit = scMaxWidth(fontSize) - head - band;
  ink.font = textFont;
  let x = head;
  const text = [],
    emotes = [];
  for (const run of runs) {
    if (x - head >= limit) break;
    if (run.asset) {
      if (x + run.asset.width > head + limit) break;
      emotes.push({asset: run.asset, x, capsule: true});
      x += run.asset.width;
    } else {
      text.push({text: run.text, x});
      x += ink.measureText(run.text).width;
    }
  }
  const width = Math.ceil(Math.min(x, head + limit) + band * 0.5 + glow);
  const face = capsuleFace(event);
  return {
    width,
    height,
    parts: [
      {
        sc: true,
        member: true,
        x: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        band,
        glow,
        inset,
        pad,
        avatarSize,
        text,
        textFont,
        face,
        avatar: avatars?.get(face) ?? null,
        color: member.color,
        border: Math.max(1, 2 * scale),
      },
      ...emotes,
    ],
  };
}

function rgba(value, alpha) {
  return `rgba(${[1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).join(',')},${alpha})`;
}

function drawMember(target, part) {
  const {width, height, glow, inset, avatarSize, color: main, band} = part;
  const s = part.border / 2,
    center = height / 2,
    top = center - band / 2,
    radius = Math.min(band / 2, Math.ceil((avatarSize + inset * 2) / 2)),
    avatarLeft = glow + inset,
    avatarCenter = avatarLeft + avatarSize / 2;
  // Band: member color, lighter at the top; optional soft glow outside it.
  const fill = target.createLinearGradient(0, top, 0, top + band);
  fill.addColorStop(0, shade(main, 0.18));
  fill.addColorStop(1, shade(main, -0.08));
  target.save();
  if (glow) {
    target.shadowColor = rgba(main, 0.9);
    target.shadowBlur = glow * 1.5;
  }
  target.fillStyle = fill;
  target.beginPath();
  target.roundRect(glow, top, width - glow * 2, band, radius);
  target.fill();
  target.restore();
  target.strokeStyle = 'rgba(255,255,255,0.75)';
  target.lineWidth = part.border;
  target.beginPath();
  target.roundRect(glow + s, top + s, width - glow * 2 - 2 * s, band - 2 * s, radius - s);
  target.stroke();
  // Avatar with a white ring; a placeholder disc until the image arrives.
  target.save();
  target.beginPath();
  target.arc(avatarCenter, center, avatarSize / 2, 0, Math.PI * 2);
  target.fillStyle = shade(main, 0.6);
  target.fill();
  target.clip();
  if (part.avatar) target.drawImage(part.avatar, avatarLeft, center - avatarSize / 2, avatarSize, avatarSize);
  target.restore();
  target.strokeStyle = '#fff';
  target.lineWidth = 3 * s;
  target.beginPath();
  target.arc(avatarCenter, center, avatarSize / 2 - 1.5 * s, 0, Math.PI * 2);
  target.stroke();
  // Ordinary danmaku text style: white fill, black stroke and soft shadow.
  target.font = part.textFont;
  target.textBaseline = 'middle';
  target.lineJoin = 'round';
  const right = width - glow - band * 0.3;
  for (const run of part.text) {
    const max = Math.max(1, right - run.x);
    target.shadowColor = 'rgba(0,0,0,0.5)';
    target.shadowBlur = 2 * s;
    target.shadowOffsetY = s;
    target.strokeStyle = '#000';
    target.lineWidth = 2.5 * s;
    target.strokeText(run.text, run.x, center + s, max);
    target.shadowColor = 'transparent';
    target.fillStyle = '#fff';
    target.fillText(run.text, run.x, center + s, max);
  }
}

export function drawCapsule(target, part) {
  if (part.member) return drawMember(target, part);
  const {width, height, head, pad, inset, avatarSize} = part;
  const center = height / 2,
    avatarCenter = inset + avatarSize / 2,
    ring = part.border;
  target.save();
  target.beginPath();
  target.roundRect(0, 0, width, height, Math.min(center, (avatarSize + inset * 2) / 2));
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
  const optical = (avatarSize + inset * 2) / 48;
  target.textBaseline = 'middle';
  if (part.amount) {
    target.font = part.amountFont;
    target.fillStyle = '#fff';
    const amountLeft = inset + avatarSize + pad;
    target.shadowColor = 'rgba(0,0,0,0.3)';
    target.shadowBlur = 2 * optical;
    target.fillText(part.amount, amountLeft, center + optical, head - amountLeft - pad);
    target.shadowColor = 'transparent';
  }
  target.font = part.textFont;
  target.fillStyle = part.foreground;
  const right = width - pad * 0.5 - (avatarSize + inset * 2) * 0.35;
  for (const run of part.text) target.fillText(run.text, run.x, center + optical, Math.max(1, right - run.x));
  target.restore();
  target.strokeStyle = part.header;
  target.lineWidth = part.border;
  const edge = part.border / 2;
  target.beginPath();
  target.roundRect(
    edge,
    edge,
    width - part.border,
    height - part.border,
    Math.min((height - part.border) / 2, (avatarSize + inset * 2 - part.border) / 2),
  );
  target.stroke();
}
