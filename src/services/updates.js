// Releases use stable SemVer (x.y.z), as enforced by check-version.mjs.
export function parseVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('版本信息无效');
  return version.split('.').map(BigInt);
}

export function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate), installed = parseVersion(current);
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

export function readScriptMetadata(text) {
  const block = text.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m)?.[1];
  if (!block) throw new Error('未收到有效的脚本元数据');
  const value = key => block.match(new RegExp(`^// @${key}\\s+(\\S+)`, 'm'))?.[1];
  const version = value('version');
  parseVersion(version);
  return { version, namespace: value('namespace'), updateURL: value('updateURL'), downloadURL: value('downloadURL') };
}

export function createUpdateChecker({ request, metadata, now = Date.now }) {
  let pending;
  return function check() {
    if (pending) return pending;
    pending = (async () => {
      let result;
      try {
        const url = new URL(metadata.updateURL);
        url.searchParams.set('_check', String(now()));
        const { data } = await request(url.href, { auth: false });
        const latest = readScriptMetadata(data);
        if (latest.namespace !== metadata.namespace) throw new Error('更新源返回了其他脚本');
        result = { status: isNewerVersion(latest.version, metadata.version) ? 'available' : 'current', version: latest.version };
      } catch {
        result = { status: 'error' };
      }
      return result;
    })().finally(() => { pending = null; });
    return pending;
  };
}
