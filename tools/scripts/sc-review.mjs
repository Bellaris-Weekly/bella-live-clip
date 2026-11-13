// Build a local visual review from the production painter. No media is encoded.
import {build} from 'esbuild';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {buildUserscript} from './build.mjs';

const directory = '.local/sc-review';
await mkdir(directory, {recursive: true});
const {outputFiles} = await build({
  entryPoints: ['tools/tests/e2e/super-chat-page.js'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: true,
});
await writeFile(
  `${directory}/index.html`,
  `<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SC 效果预览</title><body><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}\nwindow.startSuperChatDemo();</script></body></html>`,
);
await buildUserscript({preview: true});
// An explicit review build is isolated from the installed release and its update
// URL. Enable only one userscript at a time when testing on the same Bili page.
const preview = (await readFile('bella-live-clip.preview.user.js', 'utf8'))
  .replace(/^(\/\/ @name\s+).+$/m, '$1贝报切片助手 SC 测试版')
  .replace(/^(\/\/ @namespace\s+).+$/m, '$1https://github.com/Bellaris-Weekly/bella-live-clip/sc-review')
  .replace(/^\/\/ @(downloadURL|updateURL)\s+.+\n/gm, '');
await writeFile(`${directory}/bella-live-clip.sc-review.user.js`, preview);
console.log(`SC review: ${directory}/index.html and bella-live-clip.sc-review.user.js`);
