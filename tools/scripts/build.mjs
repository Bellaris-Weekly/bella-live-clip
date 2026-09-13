import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

await build({
  entryPoints: ['src/main.js'],
  outfile: 'bella-live-clip.user.js',
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  minify: false,
  charset: 'utf8',
  loader: { '.txt': 'text', '.html': 'text', '.css': 'text' },
  banner: { js: readFileSync('src/header.txt', 'utf8') },
  legalComments: 'inline',
});
