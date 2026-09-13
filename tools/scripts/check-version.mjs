import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(path, 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const versions = {
  'package.json': pkg.version,
  'package-lock.json': lock.version,
  'package-lock.json root': lock.packages[''].version,
  'src/header.txt': read('src/header.txt').match(/^\/\/ @version\s+(\S+)/m)?.[1],
  'bella-live-clip.user.js': read('bella-live-clip.user.js').match(/^\/\/ @version\s+(\S+)/m)?.[1],
  'README.md': read('README.md').match(/当前版本为\s*`([^`]+)`/)?.[1],
};
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本须为 x.y.z');
for (const [file, version] of Object.entries(versions)) {
  assert.equal(version, pkg.version, `${file} 的版本与 package.json 不一致`);
}
console.log(`版本号一致：${pkg.version}`);
