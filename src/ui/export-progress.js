import { formatBytes } from '../shared/format.js';

export function renderExportProgress(progress, status, state, submission) {
  const preparing = submission && state.phase === 'preparing';
  if (preparing) progress.removeAttribute('value');
  else progress.value = state.progress * 100;
  const parts = [];
  if (state.reconnecting) parts.push(`网络波动，自动重连中（第 ${state.attempt} 次）`);
  if (state.message) parts.push(state.message);
  if (!submission) parts.push(`已下载 ${state.downloaded}/${state.count} 片`);
  parts.push(preparing ? '正在定位选段' : `处理 ${Math.round((state.processing ?? state.progress) * 100)}%`);
  parts.push(`已读取 ${formatBytes(state.bytes)}`);
  status(parts.join(' · '));
}
