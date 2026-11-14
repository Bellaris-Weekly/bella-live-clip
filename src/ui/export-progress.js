import {formatBytes} from '../shared/format.js';
import {createProgressGate} from '../shared/progress-gate.js';

export function renderExportProgress(setProgress, status, state, submission) {
  const preparing = submission && state.phase === 'preparing';
  setProgress(preparing ? NaN : state.progress * 100);
  const parts = [];
  if (state.reconnecting) parts.push(`网络波动，正在重连（第 ${state.attempt} 次）`);
  if (state.message) parts.push(state.message);
  parts.push(preparing ? '正在定位选段' : `${Math.round((state.processing ?? state.progress) * 100)}%`);
  parts.push(`已读取 ${formatBytes(state.bytes)}`);
  status(parts.join(' · '));
}

// Keep all phase/error transitions immediate, but avoid DOM work per audio/video
// packet. No delayed callback can overwrite the final success/error message.
export function limitProgress(render, now = () => performance.now()) {
  const shouldReport = createProgressGate(now);
  return state => {
    if (shouldReport(state.phase, state.message, state.reconnecting, state.attempt, state.progress === 1))
      render(state);
  };
}
