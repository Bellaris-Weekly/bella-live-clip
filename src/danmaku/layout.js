import {anchorOf, isCapsule, isSuperChat, scSpeed, SC_WAIT, MEMBER_WAIT, SC_PRIORITY_PRICE} from './super-chat.js';
const BLOCKED = new Set(['喜欢主播加关注，点点红包抽礼物', '点点红包，关注主播抽礼物～', '老板大气！点点红包抽礼物']);
const TICKS = 60;
const priority = event =>
  anchorOf(event) ? 0 : isSuperChat(event) && Number(event.price) >= SC_PRIORITY_PRICE ? 1 : 2;

// Member comments are never filtered as promotions; invisible-only text is.
export const visibleComment = item =>
  [1, 4, 5].includes(item.mode) &&
  (isSuperChat(item) ||
    (anchorOf(item)
      ? /[^\s\u200b-\u200d\u2060\ufeff]/u.test(String(item.text))
      : !BLOCKED.has(String(item.text).trim())));

export class DanmakuLayout {
  constructor(events, {width, height, measure, start}) {
    this.width = width;
    this.height = height;
    this.scale = height / 1080;
    this.measure = measure;
    this.events = events.filter(visibleComment).sort((a, b) => a.time - b.time || a.order - b.order);
    this.cursor = 0;
    this.tick = Math.floor(start * TICKS);
    this.active = [];
    this.waiting = [];
    this.dropped = 0;
    this.droppedSuperChats = 0;
  }

  append(events) {
    this.events = this.events
      .slice(this.cursor)
      .concat(events.filter(visibleComment))
      .sort((a, b) => a.time - b.time || a.order - b.order);
    this.cursor = 0;
  }

  x(item, time) {
    return item.mode === 1 ? this.width - (time - item.started) * item.speed : (this.width - item.width) / 2;
  }

  place(content, mode, now, superChat = false) {
    const peers = this.active.filter(item => item.mode === mode);
    const gap = 50 * this.scale;
    const speed = superChat ? scSpeed(this.width) : (this.width + content.width + 100 * this.scale) / 12;
    const conflicts = old => {
      if (mode !== 1) return true;
      const distance = this.width - (this.x(old, now) + old.width);
      const remaining = Math.max(0, (this.x(old, now) + old.width + gap) / old.speed);
      return distance < gap || (speed > old.speed && distance - (speed - old.speed) * remaining < gap);
    };
    if (mode === 4 && peers.length >= 2) return null;
    const margin = 12 * this.scale;
    const candidates =
      mode === 4
        ? [this.height - margin - content.height, ...peers.map(item => item.top - content.height - this.scale)]
        : [margin, ...peers.flatMap(item => [item.top, item.top + item.height + this.scale])];
    candidates.sort((a, b) => (mode === 4 ? b - a : a - b));
    for (const top of candidates) {
      if (top < margin || top + content.height > (mode === 4 ? this.height - margin : this.height * 0.23)) continue;
      if (
        !peers.some(
          item =>
            top < item.top + item.height + this.scale &&
            item.top < top + content.height + this.scale &&
            conflicts(item),
        )
      )
        return {top, speed};
    }
    return null;
  }

  step(now) {
    this.active = this.active.filter(item => item.expires > now);
    while (this.cursor < this.events.length && this.events[this.cursor].time <= now)
      this.waiting.push(this.events[this.cursor++]);
    const pending = [],
      blocked = new Set();
    // Members first, then SCs of at least SC_PRIORITY_PRICE by amount; cheaper
    // SCs and ordinary comments keep arrival order. Placements are never
    // preempted, and a blocked queue never holds back another queue.
    const waiting = this.waiting.some(event => priority(event) < 2)
      ? [...this.waiting].sort((a, b) => priority(a) - priority(b) || (priority(a) === 1 ? b.price - a.price : 0))
      : this.waiting;
    for (const event of waiting) {
      // Capsules always scroll in the top area, whatever the source mode.
      const capsule = isCapsule(event),
        mode = capsule ? 1 : event.mode;
      // Separate queues: a blocked wide member band never holds back an SC.
      const queue = anchorOf(event) ? 'member' : capsule ? 'sc' : mode;
      const wait = [MEMBER_WAIT, SC_WAIT, 1.5][priority(event)];
      if (now - event.time > wait + 1e-6) {
        this.dropped++;
        if (capsule) this.droppedSuperChats++;
        continue;
      }
      if (blocked.has(queue)) {
        pending.push(event);
        continue;
      }
      const content = this.measure(event);
      const position = this.place(content, mode, now, capsule);
      if (!position) {
        pending.push(event);
        blocked.add(queue);
        continue;
      }
      const item = {...event, mode, ...content, ...position, started: now};
      item.expires = now + (mode === 1 ? (this.width + content.width + 50 * this.scale) / item.speed : 5);
      this.active.push(item);
    }
    this.waiting = pending;
  }

  advance(time) {
    const target = Math.floor(time * TICKS + 1e-6);
    if (target < this.tick - 1) throw new Error('弹幕媒体时间倒退，无法继续压制。');
    // Fixed media-time ticks make layout independent of encoder speed and of
    // how often callers ask for a frame. The same ticks also pre-roll the cut.
    while (this.tick <= target) {
      if (!this.waiting.length) {
        // No placement decisions occur before the next arrival. Search using
        // the original tick/60 comparison, including fractional boundaries.
        const next = this.events[this.cursor]?.time ?? Infinity;
        let low = this.tick,
          high = target;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (middle / TICKS < next) low = middle + 1;
          else high = middle;
        }
        this.tick = low;
      }
      this.step(this.tick++ / TICKS);
    }
    return this.active;
  }
}
