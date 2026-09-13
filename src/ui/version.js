export function createVersionControl({ root, metadata, check }) {
  const version = root.getElementById('version');
  const button = root.getElementById('checkUpdate');
  const link = root.getElementById('installUpdate');
  version.textContent = `v${metadata.version}`;
  // The installation destination comes from bundled metadata, never the response.
  link.href = metadata.downloadURL;
  async function refresh(force = false) {
    button.disabled = true;
    button.textContent = '检查中…';
    const result = await check({ force });
    button.disabled = false;
    button.textContent = result.status === 'error' ? '检查失败，重试' : result.status === 'current' ? '已是最新 · 检查' : '检查更新';
    link.hidden = result.status !== 'available';
    if (!link.hidden) link.textContent = `更新至 v${result.version} ↗`;
  }
  button.onclick = () => void refresh(true);
  return { refresh };
}
