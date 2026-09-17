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

function versionFixture() {
  const attributes = new Map(), element = { dataset: {}, setAttribute: (key,value) => attributes.set(key,value),
    removeAttribute(key) { attributes.delete(key); if (key === 'href') delete this.href; },
    click() { this.onclick({preventDefault(){}}); } };
  let resolve, options, calls = 0;
  const control = createVersionControl({root:{getElementById:id=>{assert.equal(id,'version');return element;}},metadata,
    check:args=>{options=args;calls++;return new Promise(done=>{resolve=done;});}});
  return {element,attributes,control,get options(){return options;},get calls(){return calls;},settle:async result=>{resolve(result);await Promise.resolve();}};
}

test('version alone checks on click without changing its text, and becomes a trusted install link when available', async () => {
  const f=versionFixture(), label=`v${metadata.version}`;
  assert.equal(f.element.textContent,label); assert.equal(f.element.href,undefined);
  assert.equal(f.attributes.get('role'),'button');
  let prevented=false;
  f.element.onclick({preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.equal(f.options.force,true);
  assert.equal(f.attributes.get('aria-busy'),'true'); assert.equal(f.element.textContent,label);
  assert.equal(f.element.dataset.checking,'true');
  f.element.click(); assert.equal(f.calls,1);
  await f.settle({status:'available',version:'99.0.0',downloadURL:'https://example.com/evil'});
  assert.equal(f.element.dataset.update,'true'); assert.equal(f.element.href,metadata.downloadURL);
  assert.equal(f.element.textContent,label); assert.match(f.element.title,/99\.0\.0/);
  assert.equal(f.attributes.has('role'),false); assert.equal(f.attributes.has('aria-busy'),false);
  assert.equal(f.element.dataset.checking,'false');
  f.element.onclick({preventDefault(){assert.fail('installation link should navigate normally');}});
  assert.equal(f.calls,1);
});

test('silent current and failed checks only update the tooltip, with no link or badge', async () => {
  const f=versionFixture();
  for (const status of ['current','error']) {
    const pending=f.control.refresh(); assert.equal(f.options.force,false);
    assert.equal(f.element.dataset.checking,'false');
    await f.settle({status}); await pending;
    assert.equal(f.element.textContent,`v${metadata.version}`);
    assert.equal(f.element.dataset.update,'false'); assert.equal(f.element.href,undefined);
    assert.match(f.element.title,status==='error'?/重试/:/已是最新/);
  }
  f.element.click(); assert.equal(f.options.force,true); await f.settle({status:'current'});
});

test('a failed recheck preserves a known update; a successful current result clears it', async () => {
  const f=versionFixture();
  let pending=f.control.refresh(); await f.settle({status:'available',version:'10.2.0'}); await pending;
  pending=f.control.refresh(); await f.settle({status:'error'}); await pending;
  assert.equal(f.element.dataset.update,'true'); assert.equal(f.element.href,metadata.downloadURL);
  assert.match(f.element.title,/10\.2\.0/);
  pending=f.control.refresh(); await f.settle({status:'current'}); await pending;
  assert.equal(f.element.dataset.update,'false'); assert.equal(f.element.href,undefined);
});

test('version supports keyboard checks and preserves native Enter navigation for updates', async () => {
  const f=versionFixture();
  for (const key of ['Enter',' ']) {
    let prevented=false;
    f.element.onkeydown({key,preventDefault(){prevented=true;}});
    assert.equal(prevented,true); assert.equal(f.options.force,true);
    await f.settle({status:'current'});
  }
  const pending=f.control.refresh(); await f.settle({status:'available',version:'3.0.0'}); await pending;
  f.element.onkeydown({key:'Enter',preventDefault(){assert.fail('Enter should follow the installation link');}});
});
