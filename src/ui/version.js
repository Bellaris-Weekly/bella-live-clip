export function createVersionControl({ root, metadata, check }) {
  const version = root.getElementById('version');
  let available = null, checking = false;
  version.textContent = `v${metadata.version}`;
  function describe(text) {
    version.title = text;
    version.setAttribute('aria-label', `当前版本 ${metadata.version}，${text}`);
  }
  function render() {
    version.dataset.update = String(Boolean(available));
    if (available) {
      // Only the bundled installation destination may become a link.
      version.href = metadata.downloadURL;
      version.removeAttribute('role');
      describe(`发现新版本 v${available}，点击更新`);
    } else {
      version.removeAttribute('href');
      version.setAttribute('role', 'button');
      describe('点击检查更新');
    }
  }
  render();
  async function refresh(force = false) {
    if (checking) return;
    checking = true;
    version.setAttribute('aria-busy', 'true');
    if (!available) describe('正在检查更新');
    try {
      const result = await check({ force });
      if (result.status !== 'error') available = result.status === 'available' ? result.version : null;
      render();
      if (!available) describe(result.status === 'error' ? '检查失败，点击重试' : '已是最新版本，点击重新检查');
    } finally {
      checking = false;
      version.removeAttribute('aria-busy');
    }
  }
  version.onclick = event => {
    if (available) return;
    event.preventDefault();
    void refresh(true);
  };
  version.onkeydown = event => {
    if (event.key === ' ' || (event.key === 'Enter' && !available)) {
      event.preventDefault();
      version.click();
    }
  };
  return { refresh };
}
