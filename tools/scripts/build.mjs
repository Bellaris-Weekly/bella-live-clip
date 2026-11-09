import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function userscriptBuildOptions({preview = false, release = false, env = process.env, write = true} = {}) {
  let endpoint = '';
  let header = readFileSync(path.join(root, 'src/header.txt'), 'utf8');
  if (preview) {
    header = header
      .replace(/^(\/\/ @name\s+)(.+)$/m, '$1$2 Preview（内部版）')
      .replace(/^(\/\/ @namespace\s+)(\S+)$/m, '$1$2/preview')
      .replaceAll('/bella-live-clip.user.js', '/bella-live-clip.preview.user.js')
      .replace(
        '// ==/UserScript==',
        '// @connect      studio.bk0717.com\n// @grant        GM_addValueChangeListener\n// @grant        GM_listValues\n// ==/UserScript==',
      );
  }
  if (release) {
    let config;
    try {
      config = JSON.parse(env.LOG_SERVICE_CONFIG);
    } catch {
      throw new Error('发布构建需要有效的 LOG_SERVICE_CONFIG Secret。');
    }
    const domain = config?.worker?.domain;
    if (
      typeof domain !== 'string' ||
      domain.length > 253 ||
      !domain.includes('.') ||
      !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw new Error('LOG_SERVICE_CONFIG.worker.domain 必须是域名，不含协议、端口、路径或凭据。');
    }
    endpoint = `https://${domain}/v1/logs`;
    const connections = [...header.matchAll(/^\/\/ @connect\s+(\S+)\s*$/gm)].map(match => match[1]);
    if (!connections.includes(domain))
      header = header.replace('// ==/UserScript==', `// @connect      ${domain}\n// ==/UserScript==`);
  }
  return {
    absWorkingDir: root,
    entryPoints: ['src/main.js'],
    outfile: preview ? 'bella-live-clip.preview.user.js' : 'bella-live-clip.user.js',
    write,
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    minify: true,
    charset: 'utf8',
    loader: {'.txt': 'text', '.html': 'text', '.css': 'text'},
    define: {__LOG_SERVICE_ENDPOINT__: JSON.stringify(endpoint), __PREVIEW__: JSON.stringify(preview)},
    // The application imports this header for its own update checker as well.
    plugins: preview
      ? [
          {
            name: 'preview-metadata',
            setup(build) {
              build.onLoad({filter: /[/\\]src[/\\]header\.txt$/}, () => ({contents: header, loader: 'text'}));
            },
          },
        ]
      : [],
    banner: {js: header},
    legalComments: 'eof',
    logLevel: 'silent',
  };
}

export async function buildUserscript(options) {
  return build(userscriptBuildOptions(options));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUserscript({preview: process.argv.includes('--preview'), release: process.argv.includes('--release')}).catch(
    error => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
