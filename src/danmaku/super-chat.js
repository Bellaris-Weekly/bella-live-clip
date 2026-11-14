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

// Mix a #rrggbb color toward black (amount < 0) or white (amount > 0).
function shade(value, amount) {
  const target = amount < 0 ? 0 : 255,
    t = Math.abs(amount);
  return `rgb(${[1, 3, 5].map(i => Math.round(parseInt(value.slice(i, i + 2), 16) * (1 - t) + target * t)).join(',')})`;
}

// Body runs are text and (member comments only) emotes. Emotes are separate
// parts drawn per frame over the static capsule sprite; tall ones grow it.
export function measureCapsule(event, ink, fontSize, font, {avatars, assets, tokens} = {}) {
  const scale = fontSize / 40;
  const member = anchorOf(event);
  const pad = 6 * scale,
    inset = 3 * scale,
    base = Math.ceil(fontSize * 1.2);
  const textFont = `600 ${fontSize * 0.8}px ${font}`;
  const runs = [];
  if (member)
    for (const token of tokens(event.text)) {
      const asset = assets?.get(token.normalize('NFC'));
      runs.push(asset && !asset.failed ? {asset} : {text: token});
    }
  else runs.push({text: scText(event.text)});
  const tallest = Math.max(0, ...runs.map(run => run.asset?.height ?? 0));
  const height = Math.max(base, Math.ceil(tallest + inset * 2)),
    avatarSize = base - inset * 2;
  let head = inset + avatarSize + pad * 1.5,
    amount,
    amountFont;
  if (!member) {
    amount = `¥${Number(event.price).toLocaleString('en-US', {maximumFractionDigits: 2, useGrouping: false})}`;
    // Keep currency/digits in a text font even when the host only has a color
    // emoji font among the named CJK fallbacks.
    amountFont = `700 ${fontSize * 0.7}px Arial, sans-serif`;
    ink.font = amountFont;
    head = Math.min(7 * fontSize, inset + avatarSize + pad * 3 + ink.measureText(amount).width);
  }
  ink.font = textFont;
  const limit = scMaxWidth(fontSize) - head - pad * 2 - base * 0.35;
  let x = head + pad * 1.5;
  const text = [],
    emotes = [];
  for (const run of runs) {
    if (x - head - pad * 1.5 >= limit) break;
    if (run.asset) {
      if (x + run.asset.width > head + pad * 1.5 + limit) break;
      emotes.push({asset: run.asset, x, capsule: true});
      x += run.asset.width;
    } else {
      text.push({text: run.text, x});
      x += ink.measureText(run.text).width;
    }
  }
  const width = Math.ceil(Math.min(x, head + pad * 1.5 + limit) + pad * 0.5 + base * 0.35);
  const header = member ? member.color : color(event.header_color, '#2A60B2');
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
        face: capsuleFace(event),
        avatar: avatars?.get(capsuleFace(event)) ?? null,
        background: member ? shade(header, 0.85) : color(event.bg_color, '#EDF5FF'),
        header,
        // Body text takes the capsule color, darkened to read on the light body.
        // The platform's font_color is for its dark card and is often near white.
        foreground: shade(header, member ? -0.3 : -0.25),
        border: Math.max(1, 2 * scale),
      },
      ...emotes,
    ],
  };
}

export function drawCapsule(target, part) {
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
