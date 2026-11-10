// The version chip: shows the running version, checks on open, and becomes an install link
// when a newer build exists. Only the bundled installation destination may become a link.
export function createVersionControl({state, metadata, check}) {
  let available = null,
    checking = false,
    manual = false,
    note = '点击检查更新';
  function render() {
    const update = Boolean(available);
    const title = update ? `发现新版本 v${available}，点击更新` : note;
    state.value = {
      label: `v${metadata.version}`,
      update,
      href: update ? metadata.downloadURL : null,
      title,
      description: `当前版本 ${metadata.version}，${title}`,
      busy: checking,
      checking: checking && manual,
    };
  }
  render();
  async function refresh(byUser = false) {
    if (checking) return;
    checking = true;
    manual = byUser;
    if (!available) note = '正在检查更新';
    render();
    try {
      const result = await check();
      if (result.status !== 'error') available = result.status === 'available' ? result.version : null;
      note = result.status === 'error' ? '检查失败，点击重试' : '已是最新版本，点击重新检查';
    } finally {
      checking = false;
      render();
    }
  }
  return {
    refresh,
    click(event) {
      if (available) return;
      event.preventDefault();
      void refresh(true);
    },
    key(event) {
      if (event.key === ' ' || (event.key === 'Enter' && !available)) {
        event.preventDefault();
        event.currentTarget.click();
      }
    },
  };
}
