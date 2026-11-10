import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createUpdateChecker, isNewerVersion, readScriptMetadata} from '../../../src/services/updates.js';
import {signal} from '@preact/signals';
import {createVersionControl} from '../../../src/ui/version.js';

const header = readFileSync(new URL('../../../src/header.txt', import.meta.url), 'utf8');
const metadata = readScriptMetadata(header);
const script = version => header.replace(/@version\s+\S+/, `@version ${version}`);
function fixture(request) {
  let calls = 0;
  const check = createUpdateChecker({
    metadata,
    request: async (...args) => {
      calls++;
      return request(...args);
    },
    now: () => 1000,
  });
  return {
    check,
    get calls() {
      return calls;
    },
  };
}

test('stable versions compare numeric components, including multi-digit minor/patch and major transitions', () => {
  for (const [next, current, expected] of [
    ['2.10.0', '2.9.9', true],
    ['2.5.10', '2.5.9', true],
    ['3.0.0', '2.99.99', true],
    ['2.5.0', '2.5.0', false],
    ['2.4.99', '2.5.0', false],
  ]) {
    assert.equal(isNewerVersion(next, current), expected);
  }
  for (const version of ['2.5', '2.5.0-beta', 'garbage', '02.5.0'])
    assert.throws(() => isNewerVersion(version, '2.5.0'));
});

test('metadata is restricted to the userscript block and accepts CRLF', () => {
  assert.equal(readScriptMetadata(header.replaceAll('\n', '\r\n')).version, metadata.version);
  assert.throws(() => readScriptMetadata('<html>Unavailable</html>'));
  assert.throws(() => readScriptMetadata('// @version 99.0.0'));
  assert.equal(readScriptMetadata(header + '\n// @version 99.0.0').version, metadata.version);
});

test('each completed check requests fresh metadata, even within the same millisecond', async () => {
  let latest = metadata.version;
  const f = fixture(async (url, options) => {
    assert.equal(new URL(url).origin, new URL(metadata.updateURL).origin);
    assert.equal(new URL(url).pathname, '/bella-live-clip.user.js');
    assert.ok(new URL(url).searchParams.has('_check'));
    assert.equal(options.auth, false);
    return {data: script(latest)};
  });
  assert.equal((await f.check()).status, 'current');
  latest = '99.0.0';
  assert.deepEqual(await f.check(), {status: 'available', version: '99.0.0'});
  await f.check();
  assert.equal(f.calls, 3);
});

test('checks read only the metadata block and survive servers without range support', async () => {
  const ranges = [];
  const f = fixture(async (url, options) => {
    ranges.push(options.range);
    if (options.range && ranges.length === 1) throw new Error('range unsupported');
    return {data: script('99.0.0')};
  });
  assert.equal((await f.check()).version, '99.0.0');
  assert.deepEqual(ranges, [{offset: 0, length: 8192}, undefined]);
  assert.equal((await f.check()).version, '99.0.0');
  assert.deepEqual(ranges[2], {offset: 0, length: 8192});
});

test('concurrent checks share a request; a failed check can retry immediately', async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const first = f.check();
  const second = f.check();
  assert.equal(first, second);
  assert.equal(f.calls, 1);
  resolve({data: 'Bad gateway'});
  assert.deepEqual(await first, {status: 'error'});
  const retry = f.check();
  assert.equal(f.calls, 2);
  resolve({data: script(metadata.version)});
  assert.equal((await retry).status, 'current');
});

test('network failures and wrong script identity do not report a current version', async () => {
  for (const request of [
    async () => {
      throw new Error('offline');
    },
    async () => ({data: header.replace(metadata.namespace, 'https://example.com/other')}),
  ]) {
    assert.deepEqual(await fixture(request).check(), {status: 'error'});
  }
  assert.equal((await fixture(async () => ({data: script('1.0.0')})).check()).status, 'current');
});

function versionFixture() {
  const state = signal(null);
  let resolve,
    calls = 0;
  const control = createVersionControl({
    state,
    metadata,
    check: () => {
      calls++;
      return new Promise(done => {
        resolve = done;
      });
    },
  });
  // The header renders `<a id="version">` from this state: a link only with href, a button otherwise.
  const event = (extra = {}) => ({
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  });
  return {
    state,
    control,
    event,
    get calls() {
      return calls;
    },
    settle: async result => {
      resolve(result);
      await Promise.resolve();
    },
  };
}

test('version alone checks on click without changing its text, and becomes a trusted install link when available', async () => {
  const f = versionFixture(),
    label = `v${metadata.version}`;
  assert.equal(f.state.value.label, label);
  assert.equal(f.state.value.href, null);
  assert.equal(f.state.value.busy, false);
  const first = f.event();
  f.control.click(first);
  assert.equal(first.prevented, true);
  assert.equal(f.state.value.busy, true);
  assert.equal(f.state.value.checking, true);
  assert.equal(f.state.value.label, label);
  f.control.click(f.event());
  assert.equal(f.calls, 1);
  await f.settle({status: 'available', version: '99.0.0', downloadURL: 'https://example.com/evil'});
  assert.equal(f.state.value.update, true);
  assert.equal(f.state.value.href, metadata.downloadURL);
  assert.equal(f.state.value.label, label);
  assert.match(f.state.value.title, /99\.0\.0/);
  assert.match(f.state.value.description, /99\.0\.0/);
  assert.equal(f.state.value.busy, false);
  assert.equal(f.state.value.checking, false);
  const navigate = f.event();
  f.control.click(navigate);
  assert.equal(navigate.prevented, false, 'installation link should navigate normally');
  assert.equal(f.calls, 1);
});

test('silent current and failed checks only update the tooltip, with no link or badge', async () => {
  const f = versionFixture();
  for (const status of ['current', 'error']) {
    const pending = f.control.refresh();
    assert.equal(f.state.value.checking, false);
    assert.equal(f.state.value.busy, true);
    await f.settle({status});
    await pending;
    assert.equal(f.state.value.label, `v${metadata.version}`);
    assert.equal(f.state.value.update, false);
    assert.equal(f.state.value.href, null);
    assert.match(f.state.value.title, status === 'error' ? /重试/ : /已是最新/);
  }
  f.control.click(f.event());
  await f.settle({status: 'current'});
});

test('a failed recheck preserves a known update; a successful current result clears it', async () => {
  const f = versionFixture();
  let pending = f.control.refresh();
  await f.settle({status: 'available', version: '10.2.0'});
  await pending;
  pending = f.control.refresh();
  await f.settle({status: 'error'});
  await pending;
  assert.equal(f.state.value.update, true);
  assert.equal(f.state.value.href, metadata.downloadURL);
  assert.match(f.state.value.title, /10\.2\.0/);
  pending = f.control.refresh();
  await f.settle({status: 'current'});
  await pending;
  assert.equal(f.state.value.update, false);
  assert.equal(f.state.value.href, null);
});

test('version supports keyboard checks and preserves native Enter navigation for updates', async () => {
  const f = versionFixture();
  for (const key of ['Enter', ' ']) {
    let clicked = false;
    const event = f.event({
      key,
      currentTarget: {
        click() {
          clicked = true;
          f.control.click(f.event());
        },
      },
    });
    f.control.key(event);
    assert.equal(event.prevented, true);
    assert.equal(clicked, true);
    await f.settle({status: 'current'});
  }
  const pending = f.control.refresh();
  await f.settle({status: 'available', version: '3.0.0'});
  await pending;
  const enter = f.event({key: 'Enter', currentTarget: {click: () => assert.fail('Enter should follow the link')}});
  f.control.key(enter);
  assert.equal(enter.prevented, false);
});
