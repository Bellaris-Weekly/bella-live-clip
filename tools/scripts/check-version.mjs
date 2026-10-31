import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
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
// Installed copies only update when the version changes, so a release that
// changes the script without changing it would never reach them.
const since = process.argv[process.argv.indexOf('--since') + 1];
if (process.argv.includes('--since') && since && !/^0+$/.test(since)) {
  const git = (...args) => execFileSync('git', args, {encoding: 'utf8'});
  const changed = git('diff', '--name-only', since, 'HEAD', '--', 'src').trim();
  const previous = JSON.parse(git('show', `${since}:package.json`)).version;
  assert.ok(!changed || previous !== pkg.version, `src 有改动，但版本仍是 ${pkg.version}，已安装的用户不会收到更新。`);
}
console.log(`版本号一致：${pkg.version}`);
