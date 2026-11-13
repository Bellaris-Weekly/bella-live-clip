// Bumps the version everywhere it is written and adds a changelog entry.
// npm run release -- "改动说明" ["另一条说明"]   patch bump
// npm run release -- --minor "改动说明"          minor bump, for major feature releases only
import {readFileSync, writeFileSync} from 'node:fs';

const args = process.argv.slice(2);
const minor = args.includes('--minor');
const notes = args.filter(arg => arg !== '--minor');
if (!notes.length) {
  console.error('用法：npm run release -- [--minor] "改动说明" ...');
  process.exit(1);
}
const edit = (file, change) => writeFileSync(file, change(readFileSync(file, 'utf8')));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, min, patch] = pkg.version.split('.').map(Number);
const version = minor ? `${major}.${min + 1}.0` : `${major}.${min}.${patch + 1}`;
edit('package.json', () => `${JSON.stringify({...pkg, version}, null, 2)}\n`);
edit('package-lock.json', text => {
  const lock = JSON.parse(text);
  lock.version = version;
  lock.packages[''].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
});
edit('src/header.txt', text => text.replace(/^(\/\/ @version\s+)\S+/m, `$1${version}`));
edit('CHANGELOG.md', text =>
  text.replace('# 更新记录\n\n', `# 更新记录\n\n## ${version}\n\n${notes.map(note => `- ${note}`).join('\n')}\n\n`),
);
console.log(version);
