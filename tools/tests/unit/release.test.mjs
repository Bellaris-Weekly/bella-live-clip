import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

test('升版本只更新项目自身，不改写恰好同版本的依赖', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'bella-release-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const dependency = {version: '2.16.2', resolved: 'https://example.com/dependency-2.16.2.tgz', integrity: 'unchanged'};
  await mkdir(join(cwd, 'src'));
  await Promise.all([
    writeFile(join(cwd, 'package.json'), JSON.stringify({version: '2.16.2'})),
    writeFile(
      join(cwd, 'package-lock.json'),
      JSON.stringify({
        version: '2.16.2',
        packages: {'': {version: '2.16.2'}, 'node_modules/dependency': dependency},
      }),
    ),
    writeFile(join(cwd, 'src/header.txt'), '// @version 2.16.2\n'),
    writeFile(join(cwd, 'CHANGELOG.md'), '# 更新记录\n\n## 2.16.2\n'),
  ]);
  execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url)), '修复预览'], {
    cwd,
  });
  const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '2.16.3');
  assert.equal(lock.packages[''].version, '2.16.3');
  assert.deepEqual(lock.packages['node_modules/dependency'], dependency);
  assert.equal(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).version, '2.16.3');
  assert.match(await readFile(join(cwd, 'src/header.txt'), 'utf8'), /@version 2\.16\.3/);
  assert.match(await readFile(join(cwd, 'CHANGELOG.md'), 'utf8'), /## 2\.16\.3\n\n- 修复预览/);
});
