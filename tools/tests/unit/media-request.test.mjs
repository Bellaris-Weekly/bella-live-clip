import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMediaRequest, isMediaUrl} from '../../../src/services/media-request.js';

const media = 'https://cn-gotcha.bilivideo.com/live-bvc/1/index.m3u8?sign=1';
const ok = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url: media,
  text: async () => data,
  arrayBuffer: async () => data,
});
function fixture(pageFetch, options) {
  const calls = [],
    fallbacks = [];
  const request = createMediaRequest({
    pageFetch:
      pageFetch &&
      (async (url, init) => {
        calls.push({url, init});
        return pageFetch(url, init);
      }),
    fallback: async (url, opts) => {
      fallbacks.push({url, opts});
      return {data: 'fallback', url};
    },
    ...options,
  });
  return {request, calls, fallbacks};
}

test('only anonymous HTTPS requests to platform media hosts qualify for direct reads', () => {
  for (const url of [
    media,
    'https://upos-sz.bilivideo.cn/a.m4s',
    'https://i0.hdslb.com/a.jpg',
    'https://x.acgvideo.com/a',
  ])
    assert.equal(isMediaUrl(url), true);
  for (const url of [
    'http://a.bilivideo.com/a',
    'https://api.live.bilibili.com/x',
    'https://bilivideo.com.evil.example/a',
    'https://evilbilivideo.com/a',
    'not a url',
  ])
    assert.equal(isMediaUrl(url), false);
});

test('media is read without credentials and with the byte range', async () => {
  const f = fixture(async () => ok(new ArrayBuffer(4), 206));
  const {data, url} = await f.request(media, {type: 'arraybuffer', range: {offset: 10, length: 5}});
  assert.equal(data.byteLength, 4);
  assert.equal(url, media);
  assert.equal(f.fallbacks.length, 0);
  const {init} = f.calls[0];
  assert.equal(init.credentials, 'omit');
  assert.equal(init.mode, 'cors');
  assert.deepEqual(init.headers, {Range: 'bytes=10-14'});
});

test('account requests, forms and other hosts stay on the userscript manager', async () => {
  const f = fixture(async () => ok('direct'));
  await f.request('https://share.bellaris.fans/x.js', {});
  await f.request(media, {auth: true});
  await f.request(media, {form: {a: 1}});
  assert.equal(f.calls.length, 0);
  assert.equal(f.fallbacks.length, 3);
});

test('a blocked or failed direct read falls back once and pauses after repeated failures', async () => {
  let clock = 0;
  const f = fixture(
    async () => {
      throw new TypeError('Failed to fetch');
    },
    {now: () => clock},
  );
  for (let i = 0; i < 5; i++) assert.equal((await f.request(media, {})).data, 'fallback');
  assert.equal(f.calls.length, 3);
  assert.equal(f.fallbacks.length, 5);
  clock = 61000;
  await f.request(media, {});
  assert.equal(f.calls.length, 4, 'direct reads resume after the pause');
});

test('callers that must read response headers stay on the userscript manager', async () => {
  const f = fixture(async () => ok('direct'));
  await f.request(media, {needHeaders: true});
  assert.equal(f.calls.length, 0);
  assert.equal(f.fallbacks.length, 1);
});

test('HTTP errors and ignored ranges fall back instead of returning wrong bytes', async () => {
  for (const [response, options] of [
    [ok('', 403), {}],
    [ok(new ArrayBuffer(99), 200), {type: 'arraybuffer', range: {offset: 0, length: 5}}],
  ]) {
    const f = fixture(async () => response);
    assert.equal((await f.request(media, options)).data, 'fallback');
  }
});

test('one success forgives earlier failures', async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new TypeError('offline');
    return ok('direct');
  });
  await f.request(media, {});
  await f.request(media, {});
  fail = false;
  await f.request(media, {});
  fail = true;
  await f.request(media, {});
  await f.request(media, {});
  fail = false;
  assert.equal((await f.request(media, {})).data, 'direct');
});

test('cancellation is not treated as a failure and never reaches the fallback', async () => {
  const controller = new AbortController();
  const f = fixture(
    (_, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  );
  const pending = f.request(media, {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(f.fallbacks.length, 0);
  await assert.rejects(f.request(media, {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(f.calls.length, 1);
});

test('a stalled direct read gives up and uses the fallback', async () => {
  const f = fixture(
    (_, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    {timeout: 5},
  );
  assert.equal((await f.request(media, {})).data, 'fallback');
});

test('a body that stalls after the headers also gives up', async () => {
  const f = fixture(
    (_, {signal}) => ({
      ok: true,
      status: 200,
      url: media,
      text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    }),
    {bodyTimeout: 5},
  );
  assert.equal((await f.request(media, {})).data, 'fallback');
});
