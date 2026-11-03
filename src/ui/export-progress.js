import {formatBytes} from '../shared/format.js';

export function renderExportProgress(progress, status, state, submission) {
  const preparing = submission && state.phase === 'preparing';
  if (preparing) progress.removeAttribute('value');
  else progress.value = state.progress * 100;
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
  let lastTime = -Infinity,
    phase,
    message,
    reconnecting,
    attempt;
  return state => {
    const time = now();
    const changed =
      state.phase !== phase ||
      state.message !== message ||
      state.reconnecting !== reconnecting ||
      state.attempt !== attempt;
    if (!changed && state.progress !== 1 && time - lastTime < 100) return;
    lastTime = time;
    ({phase, message, reconnecting, attempt} = state);
    render(state);
  };
}
