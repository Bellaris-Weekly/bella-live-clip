import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function buildUserscript({ release = false, env = process.env, write = true } = {}) {
  let endpoint = '';
  let header = readFileSync(path.join(root, 'src/header.txt'), 'utf8');
  if (release) {
    let config;
    try { config = JSON.parse(env.LOG_SERVICE_CONFIG); }
    catch { throw new Error('发布构建需要有效的 LOG_SERVICE_CONFIG Secret。'); }
    const domain = config?.worker?.domain;
    if (typeof domain !== 'string' || domain.length > 253 || !domain.includes('.') || !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('LOG_SERVICE_CONFIG.worker.domain 必须是域名，不含协议、端口、路径或凭据。');
    }
    endpoint = `https://${domain}/v1/logs`;
    const connections = [...header.matchAll(/^\/\/ @connect\s+(\S+)\s*$/gm)].map((match) => match[1]);
    if (!connections.includes(domain)) header = header.replace('// ==/UserScript==', `// @connect      ${domain}\n// ==/UserScript==`);
  }
  return build({
    absWorkingDir: root,
    entryPoints: ['src/main.js'],
    outfile: 'bella-live-clip.user.js',
    write,
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    minify: false,
    charset: 'utf8',
    loader: { '.txt': 'text', '.html': 'text', '.css': 'text' },
    define: { __LOG_SERVICE_ENDPOINT__: JSON.stringify(endpoint) },
    banner: { js: header },
    legalComments: 'inline',
    logLevel: 'silent',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUserscript({ release: process.argv.includes('--release') }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
