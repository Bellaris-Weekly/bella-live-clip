// Frozen 2.13.1 clock and placement rules for equivalence testing.
const BLOCKED = new Set(['喜欢主播加关注，点点红包抽礼物', '点点红包，关注主播抽礼物～', '老板大气！点点红包抽礼物']);
const TICKS = 60;

export class DanmakuLayout {
  constructor(events, {width, height, measure, start}) {
    this.width = width;
    this.height = height;
    this.scale = height / 1080;
    this.measure = measure;
    this.events = events
      .filter(item => [1, 4, 5].includes(item.mode) && !BLOCKED.has(String(item.text).trim()))
      .sort((a, b) => a.time - b.time || a.order - b.order);
    this.cursor = 0;
    this.tick = Math.floor(start * TICKS);
    this.active = [];
    this.waiting = [];
    this.dropped = 0;
  }

  x(item, time) {
    return item.mode === 1 ? this.width - (time - item.started) * item.speed : (this.width - item.width) / 2;
  }

  place(content, mode, now) {
    const peers = this.active.filter(item => item.mode === mode);
    const gap = 50 * this.scale;
    const speed = (this.width + content.width + 100 * this.scale) / 12;
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
      if (top < margin || top + content.height > (mode === 4 ? this.height - margin : this.height * 0.25)) continue;
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
    for (const event of this.waiting) {
      if (now - event.time > 1.5 + 1e-6) {
        this.dropped++;
        continue;
      }
      const content = this.measure(event);
      const position = blocked.has(event.mode) ? null : this.place(content, event.mode, now);
      if (!position) {
        pending.push(event);
        blocked.add(event.mode);
        continue;
      }
      const item = {...event, ...content, ...position, started: now};
      item.expires = now + (event.mode === 1 ? (this.width + content.width + 50 * this.scale) / item.speed : 5);
      this.active.push(item);
    }
    this.waiting = pending;
  }

  advance(time) {
    const target = Math.floor(time * TICKS + 1e-6);
    if (target < this.tick - 1) throw new Error('弹幕媒体时间倒退，无法继续压制。');
    // Fixed media-time ticks make layout independent of encoder speed and of
    // how often callers ask for a frame. The same ticks also pre-roll the cut.
    while (this.tick <= target) this.step(this.tick++ / TICKS);
    return this.active;
  }
}
