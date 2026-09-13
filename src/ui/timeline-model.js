import {formatTime} from '../shared/format.js';
import {clamp} from '../shared/math.js';

export function validateRange(start, end, duration) {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end <= start) {
    throw new Error('结束时间必须晚于开始时间。');
  }
  if (end > duration + 0.001) throw new Error(`结束时间超出范围，最晚为 ${formatTime(duration, true)}。`);
  return { start, end };
}

// Keep the time under the pointer stationary while zooming; pan never exceeds the media.
export function zoomWindow(view, total, factor, anchor = .5) {
  const span = view.end-view.start, width = clamp(span*factor,Math.min(.25,total),total);
  const pivot = view.start+span*clamp(anchor,0,1);
  const start = clamp(pivot-width*anchor,0,total-width);
  return {start,end:start+width};
}

export function panWindow(view,total,delta) {
  const width=view.end-view.start, start=clamp(view.start+delta,0,total-width);
  return {start,end:start+width};
}
