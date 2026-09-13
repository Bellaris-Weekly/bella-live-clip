import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUpdateChecker, isNewerVersion, readScriptMetadata } from '../../../src/services/updates.js';
import { createVersionControl } from '../../../src/ui/version.js';

const header = readFileSync(new URL('../../../src/header.txt', import.meta.url), 'utf8');
const metadata = readScriptMetadata(header);
const script = version => header.replace(/@version\s+\S+/, `@version ${version}`);
function fixture(request) {
  let time = 1000, cached = null, calls = 0;
  const check = createUpdateChecker({ metadata, request: async (...args) => { calls++; return request(...args); },
    get: () => cached, set: (_, value) => { cached = value; }, now: () => time });
  return { check, advance: value => { time += value; }, get calls() { return calls; }, get cached() { return cached; } };
}

test('stable versions compare numeric components, including multi-digit minor/patch and major transitions', () => {
  for (const [next, current, expected] of [['2.10.0','2.9.9',true],['2.5.10','2.5.9',true],['3.0.0','2.99.99',true],['2.5.0','2.5.0',false],['2.4.99','2.5.0',false]]) {
    assert.equal(isNewerVersion(next,current),expected);
  }
  for (const version of ['2.5','2.5.0-beta','garbage','02.5.0']) assert.throws(() => isNewerVersion(version,'2.5.0'));
});

test('metadata is restricted to the userscript block and accepts CRLF', () => {
  assert.equal(readScriptMetadata(header.replaceAll('\n','\r\n')).version,metadata.version);
  assert.throws(() => readScriptMetadata('<html>Unavailable</html>'));
  assert.throws(() => readScriptMetadata('// @version 99.0.0'));
  assert.equal(readScriptMetadata(header+'\n// @version 99.0.0').version,metadata.version);
});

test('automatic checks cache for 24 hours; manual checks bypass and stay anonymous', async () => {
  const f = fixture(async (url, options) => {
    assert.equal(new URL(url).origin,new URL(metadata.updateURL).origin);
    assert.ok(new URL(url).searchParams.has('_check'));
    assert.equal(options.auth,false);
    return {data:script('99.0.0')};
  });
  assert.deepEqual(await f.check(),{status:'available',version:'99.0.0'});
  await f.check(); assert.equal(f.calls,1);
  await f.check({force:true}); assert.equal(f.calls,2);
  f.advance(24*60*60*1000); await f.check(); assert.equal(f.calls,3);
  assert.deepEqual(Object.keys(f.cached).sort(),['checkedAt','installed','result']);
});

test('concurrent checks share a request, failures throttle automatic checks and allow manual retry', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve=done; }));
  const first=f.check(); const second=f.check({force:true});
  assert.equal(first,second); assert.equal(f.calls,1);
  resolve({data:'Bad gateway'}); assert.deepEqual(await first,{status:'error'});
  await f.check(); assert.equal(f.calls,1);
  const retry=f.check({force:true}); resolve({data:script(metadata.version)});
  assert.equal((await retry).status,'current');
});

test('network failures and wrong script identity do not report a current version', async () => {
  for (const request of [async()=>{throw new Error('offline');},async()=>({data:header.replace(metadata.namespace,'https://example.com/other')})]) {
    assert.deepEqual(await fixture(request).check(),{status:'error'});
  }
  assert.equal((await fixture(async()=>({data:script('1.0.0')})).check()).status,'current');
});

test('installed version changes invalidate old cached update results', async () => {
  let calls=0;
  const check=createUpdateChecker({metadata,request:async()=>{calls++;return {data:header};},get:()=>({installed:'1.0.0',checkedAt:Date.now(),result:{status:'available',version:'2.0.0'}}),set:()=>{}});
  assert.equal((await check()).status,'current'); assert.equal(calls,1);
});

test('version control renders progress, update link, latest status and retry without remote link injection', async () => {
  const elements=Object.fromEntries(['version','checkUpdate','installUpdate'].map(id=>[id,{}]));
  let resolve, options;
  const control=createVersionControl({root:{getElementById:id=>elements[id]},metadata,check:args=>{options=args;return new Promise(done=>{resolve=done;});}});
  assert.equal(elements.version.textContent,`v${metadata.version}`);
  let pending=control.refresh(); assert.equal(elements.checkUpdate.disabled,true);
  resolve({status:'available',version:'99.0.0',downloadURL:'https://example.com/evil'}); await pending;
  assert.equal(elements.installUpdate.href,metadata.downloadURL); assert.equal(elements.installUpdate.hidden,false);
  assert.match(elements.installUpdate.textContent,/99\.0\.0/);
  pending=control.refresh(true); assert.equal(options.force,true); resolve({status:'current'}); await pending;
  assert.equal(elements.installUpdate.hidden,true); assert.match(elements.checkUpdate.textContent,/已是最新/);
  pending=control.refresh(true); resolve({status:'error'}); await pending;
  assert.equal(elements.checkUpdate.disabled,false); assert.match(elements.checkUpdate.textContent,/重试/);
});
