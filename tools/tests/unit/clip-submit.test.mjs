import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadFile, createClipUpload, createUploadTransport, delay} from '../../../src/preview/upload.js';
import {createSubmissionJob} from '../../../src/preview/submission.js';
import {OUTPUTS, createCover, cropRect, drawCover, initialCover, layerOf} from '../../../src/preview/cover.js';
import {createStudioClient} from '../../../src/preview/studio.js';
import {deferred} from '../../../src/shared/deferred.js';

const file = new File(['abcdefghij'], 'clip.mp4', {type: 'video/mp4'});
const ticket = {id: 'u', url: 'https://upos-test.bilivideo.com/clip', auth: 'secret', biz_id: 42, chunk_size: 4};
const okTransport = calls => ({
  request: async request => {
    calls.push(request);
    return {status: 200, text: JSON.stringify(request.url.includes('?uploads') ? {upload_id: 'remote-id'} : {OK: 1})};
  },
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('UPOS init/chunks/merge match studio wire protocol and read only slices', async () => {
  const calls = [];
  const fractions = [];
  file.arrayBuffer = () => {
    throw new Error('whole file must never be read');
  };
  await uploadFile(file, ticket, {transport: okTransport(calls), concurrency: 2, onProgress: x => fractions.push(x)});
  assert.equal(calls[0].url, `${ticket.url}?uploads&output=json`);
  const chunks = calls.filter(call => call.method === 'PUT');
  assert.deepEqual(await Promise.all(chunks.map(call => call.body.text())), ['abcd', 'efgh', 'ij']);
  chunks.forEach((call, i) => {
    assert.deepEqual(Object.fromEntries(new URL(call.url).searchParams), {
      uploadId: 'remote-id',
      chunks: '3',
      total: '10',
      chunk: String(i),
      size: i === 2 ? '2' : '4',
      partNumber: String(i + 1),
      start: String(i * 4),
      end: String(Math.min(i * 4 + 4, 10)),
    });
    assert.deepEqual(call.headers, {'X-Upos-Auth': 'secret'});
  });
  assert.deepEqual(fractions, [1 / 3, 2 / 3, 1]);
  assert.deepEqual(Object.fromEntries(new URL(calls.at(-1).url).searchParams), {
    name: 'clip.mp4',
    uploadId: 'remote-id',
    biz_id: '42',
    output: 'json',
    profile: 'ugcupos/bup',
  });
  assert.deepEqual(JSON.parse(calls.at(-1).body), {parts: [1, 2, 3].map(partNumber => ({partNumber, eTag: 'etag'}))});
});

test('UPOS retries a failed chunk at 2s/4s, stops after three attempts, and never merges failures', async () => {
  for (const recover of [true, false]) {
    const calls = [],
      waits = [];
    let attempts = 0;
    const transport = okTransport(calls),
      request = transport.request;
    transport.request = async call => {
      if (call.method === 'PUT' && (!recover || attempts < 2)) {
        attempts++;
        calls.push(call);
        return {status: 503};
      }
      return request(call);
    };
    const task = uploadFile(file, ticket, {transport, concurrency: 1, sleep: async ms => waits.push(ms)});
    if (recover) await task;
    else await assert.rejects(task, /分片 1 上传失败/);
    assert.deepEqual(waits, [2000, 4000]);
    assert.equal(calls.filter(call => call.url.includes('profile=')).length, recover ? 1 : 0);
  }
});

test('UPOS abort stops in-flight chunks and prevents merging, including cancellation during retry delay', async () => {
  for (const retry of [false, true]) {
    const controller = new AbortController();
    let puts = 0,
      aborted = 0,
      merges = 0;
    const started = deferred();
    const transport = {
      request: async call => {
        if (call.url.includes('?uploads')) return {status: 200, text: '{"upload_id":"id"}'};
        if (call.method === 'POST') {
          merges++;
          return {status: 200, text: '{"OK":1}'};
        }
        puts++;
        started.resolve();
        if (retry) return {status: 503};
        return new Promise((_, reject) =>
          call.signal.addEventListener(
            'abort',
            () => {
              aborted++;
              reject(call.signal.reason);
            },
            {once: true},
          ),
        );
      },
    };
    const task = uploadFile(file, ticket, {transport, signal: controller.signal, concurrency: 2});
    await started.promise;
    if (retry) await tick();
    controller.abort();
    await assert.rejects(task, {name: 'AbortError'});
    assert.equal(merges, 0);
    assert.ok(puts <= 2);
    if (!retry) assert.equal(aborted, puts);
  }
});

test('GM upload transport is anonymous, restricts hosts, and propagates abort to GM', async () => {
  let options,
    aborted = 0;
  const transport = createUploadTransport(value => {
    options = value;
    return {abort: () => aborted++};
  });
  const controller = new AbortController();
  const pending = transport.request({
    method: 'PUT',
    url: ticket.url,
    body: file.slice(0, 4),
    signal: controller.signal,
    headers: {'X-Upos-Auth': 'secret'},
  });
  assert.equal(options.anonymous, true);
  assert.equal(options.headers.Authorization, undefined);
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(aborted, 1);
  assert.throws(() => transport.request({method: 'PUT', url: 'https://other.test/file'}), /上传节点无效/);
});

function uploadFixture({failApi = false, failComplete = false, verification = false} = {}) {
  const calls = [],
    chunks = [];
  let polled = 0;
  const client = {
    request: async (path, options) => {
      calls.push([path, options]);
      if (path === '/uploads') {
        if (failApi) throw Object.assign(new Error('API error'), {code: verification ? 'rate_limited' : 'queued'});
        return ticket;
      }
      if (path === '/uploads/u/complete' && failComplete) throw new Error('completion response lost');
      if (path === '/cos/uploads') return {id: 'cos', state: 'uploading', part_size: 4};
      if (path.includes('/parts/')) return {url: `https://bucket.cos.example/${path.split('/').at(-1)}`};
      if (path === '/cos/uploads/cos/complete') return {id: 'cos', state: 'queued', progress: 0};
      if (path === '/cos/uploads/cos') return {id: 'cos', state: ++polled ? 'uploaded' : 'queued'};
    },
  };
  return {calls, chunks, client};
}
const uploadOptions = signal => ({
  mid: 7,
  line: 'bda2',
  options: {cos_enabled: true, max_file_bytes: 100},
  signal,
  onStage() {},
  onProgress() {},
});

test('direct transfer failure cancels UPOS, signs each COS part, completes and polls the relay', async () => {
  const fixture = uploadFixture();
  const transport = {request: async () => ({status: 503})};
  const uploader = createClipUpload({
    ...fixture,
    transport,
    sleep: async () => {},
    put: async (url, blob) => fixture.chunks.push([url, await blob.text()]),
  });
  assert.equal(await uploader.run(file, uploadOptions(new AbortController().signal)), 'cos');
  assert.deepEqual(
    fixture.chunks.map(chunk => chunk[1]),
    ['abcd', 'efgh', 'ij'],
  );
  assert.ok(fixture.calls.some(([path, options]) => path === '/uploads/u' && options.method === 'DELETE'));
  assert.deepEqual(fixture.calls.find(([path]) => path === '/cos/uploads')[1].body, {
    account_mid: 7,
    file_name: 'clip.mp4',
    size: 10,
    line: 'bda2',
  });
  assert.ok(fixture.calls.some(([path]) => path === '/cos/uploads/cos/complete'));
});

test('API/verification/completion errors and user abort never trigger COS fallback', async () => {
  for (const setup of [{failApi: true}, {failApi: true, verification: true}, {failComplete: true}]) {
    const fixture = uploadFixture(setup);
    const uploader = createClipUpload({...fixture, transport: okTransport([])});
    await assert.rejects(
      uploader.run(file, uploadOptions(new AbortController().signal)),
      setup.verification ? /studio.bk0717.com/ : /API error|completion response lost/,
    );
    assert.ok(!fixture.calls.some(([path]) => path === '/cos/uploads'));
  }
  const fixture = uploadFixture(),
    controller = new AbortController();
  const uploader = createClipUpload({
    ...fixture,
    transport: {
      request: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    },
  });
  await assert.rejects(uploader.run(file, uploadOptions(controller.signal)), {name: 'AbortError'});
  assert.ok(!fixture.calls.some(([path]) => path === '/cos/uploads'));
  await uploader.cancel();
  assert.equal(fixture.calls.at(-1)[1].method, 'DELETE');
});

function jobFixture(overrides = {}) {
  const uploaded = deferred(),
    calls = [];
  let cleaned = 0,
    uuid = 0;
  const client = {
    request: async (path, options) => {
      calls.push([path, options]);
      return {id: 's', status: 'submitted', bvid: 'BV1234567890'};
    },
  };
  const job = createSubmissionJob({
    client,
    defaults: {account_mid: 7, tid: 8, season_id: 9, section_id: 10},
    upload: () => uploaded.promise,
    clean: async () => {
      cleaned++;
    },
    uuid: () => `request-${++uuid}`,
    sleep: async () => {},
    ...overrides,
  });
  return {job, uploaded, calls, cleaned: () => cleaned};
}
const fields = {
  title: 'title',
  tid: 99,
  copyright: 2,
  source: 'source',
  no_reprint: false,
  dtime: null,
  is_only_self: true,
  tags: ['tag'],
  desc: 'desc',
  cover_id: 'cover',
  mark_id: 'mark',
};

test('submits template fields exactly once in either order and ignores legacy collection defaults', async () => {
  for (const confirmFirst of [true, false]) {
    const f = jobFixture();
    const work = f.job.start();
    if (confirmFirst) {
      await f.job.confirm(fields);
      assert.equal(f.calls.length, 0);
    }
    f.uploaded.resolve('upload-id');
    await work;
    if (!confirmFirst) {
      assert.equal(f.calls.length, 0);
      await f.job.confirm(fields);
    }
    await tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], '/submissions');
    assert.deepEqual(f.calls[0][1].body, {
      ...fields,
      request_id: 'request-1',
      account_mid: 7,
      parts: [{upload_id: 'upload-id', title: 'title'}],
    });
    assert.equal(f.cleaned(), 1);
    assert.equal(f.job.state().done, true);
    await f.job.confirm(fields);
    await f.job.retry();
    assert.equal(f.calls.length, 1);
  }
});

test('cancel before submit aborts transfer, cleans after it settles and cannot race a late confirmation', async () => {
  const f = jobFixture();
  const work = f.job.start();
  await f.job.confirm(fields);
  const cancelled = f.job.cancel();
  assert.equal(f.job.signal.aborted, true);
  assert.equal(f.cleaned(), 0);
  f.uploaded.resolve('upload-id');
  await work;
  assert.equal(await cancelled, true);
  await f.job.confirm(fields);
  await f.job.retry();
  assert.equal(f.calls.length, 0);
  assert.equal(f.cleaned(), 1);
});

test('after sending no cancellation is offered; network retry uses the same request and UUID', async () => {
  const response = deferred(),
    calls = [];
  const f = jobFixture({
    client: {
      request: async (path, options) => {
        calls.push([path, options]);
        if (calls.length === 1) return response.promise;
        return {id: 's', bvid: 'BV1234567890', status: 'submitted'};
      },
    },
  });
  f.uploaded.resolve('u');
  await f.job.start();
  const pending = f.job.confirm(fields);
  assert.equal(f.job.state().canCancel, false);
  assert.equal(await f.job.cancel(), false);
  response.reject(new Error('response lost'));
  await pending;
  await f.job.confirm({...fields, title: 'different'});
  await f.job.retry();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls.length, 2);
  assert.equal(f.job.state().done, true);
});

test('polling failure retains the submission id; explicit retry uses studio retry endpoint', async () => {
  const calls = [];
  const f = jobFixture({
    defaults: {account_mid: 7, tid: 8},
    client: {
      request: async path => {
        calls.push(path);
        return path.endsWith('/retry')
          ? {id: 's', bvid: 'BV1234567890'}
          : {id: 's', status: path === '/submissions' ? 'submitting' : 'failed', error_message: 'rejected'};
      },
    },
  });
  f.uploaded.resolve('u');
  await f.job.start();
  await f.job.confirm(fields);
  assert.match(f.job.state().error.message, /rejected/);
  await f.job.retry();
  assert.deepEqual(calls, ['/submissions', '/submissions/s', '/submissions/s/retry']);
  assert.equal(f.job.state().done, true);
});

test('unresolved placeholders cannot be confirmed or sent', async () => {
  const f = jobFixture();
  f.uploaded.resolve('u');
  await f.job.start();
  for (const value of [
    {...fields, title: '{live}'},
    {...fields, desc: '{clipper}'},
    {...fields, desc: '前缀 {live} 后缀'},
  ]) {
    assert.throws(() => f.job.confirm(value), /占位符/);
    assert.equal(f.job.state().confirmed, false);
  }
  assert.deepEqual(f.calls, []);
});

test('cover crops stay inside the source; 4:3 follows 16:9 until edited; finished covers get no text', () => {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [800, 600],
  ])
    for (const {ratio} of Object.values(OUTPUTS))
      for (const crop of [null, {cx: 99999, cy: -100, zoom: 3}, {cx: 0, cy: 0, zoom: 99}]) {
        const rect = cropRect({width, height}, ratio, crop);
        assert.ok(Math.abs(rect.w / rect.h - ratio) < 1e-9);
        assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width + 1e-9 && rect.y + rect.h <= height + 1e-9);
      }
  const image = {width: 1920, height: 1080};
  const cover = createCover();
  cover.setFrame({image, time: 5, key: 'k'});
  cover.zoom('wide', 2, {x: 0.25, y: 0.25});
  const state = cover.state.value;
  const wide = cropRect(image, OUTPUTS.wide.ratio, layerOf(state, 'wide').crop),
    tall = cropRect(image, OUTPUTS.tall.ratio, layerOf(state, 'tall').crop);
  assert.ok(Math.abs(wide.h - tall.h) < 1e-6, 'same height');
  assert.ok(Math.abs(wide.y - tall.y) < 1e-6);
  assert.ok(Math.abs(wide.x + wide.w / 2 - (tall.x + tall.w / 2)) < 1e-6, 'same center');
  cover.moveText('tall', 0.505, 0.3);
  assert.equal(cover.state.value.follow, false, 'editing 4:3 gives it its own layout');
  assert.deepEqual(cover.state.value.tall.pos, {x: 0.5, y: 0.3}, 'snaps to the middle');
  cover.follow();
  assert.equal(cover.state.value.follow, true);
  cover.setImage('wide', {width: 1600, height: 900});
  assert.equal(cover.state.value.wide.showText, false);
  assert.equal(layerOf(cover.state.value, 'tall').source, 'image', '4:3 follows the picked image');
  cover.setImage('tall', {width: 1000, height: 1000});
  assert.equal(cover.state.value.follow, false);
  assert.equal(cover.state.value.tall.showText, true);

  const calls = [];
  const context = {
    fillRect() {},
    save() {},
    restore() {},
    measureText: text => ({width: text.length * 10}),
    drawImage: (...args) => calls.push(['image', ...args]),
    strokeText: (...args) => calls.push(['stroke', ...args]),
    fillText: (...args) => calls.push(['fill', ...args]),
  };
  const drawn = initialCover({image, time: 0, key: 'k'});
  drawn.text.value = 'hello';
  const box = drawCover(context, drawn, 'tall');
  assert.deepEqual(calls[0], ['image', image, 240, 0, 1440, 1080, 0, 0, 1440, 1080]);
  assert.deepEqual(
    calls.slice(1).map(call => call[0]),
    ['stroke', 'fill'],
  );
  assert.equal(calls[2][2], 720);
  assert.equal(box.w, 50);
});

test('studio client supports multipart Bearer cover upload, cancellation and verification details', async () => {
  let options,
    aborted = false;
  const client = createStudioClient({
    get: () => ({token: 'secret'}),
    set() {},
    request: value => {
      options = value;
      return {
        abort: () => {
          aborted = true;
        },
      };
    },
  });
  const body = new FormData();
  body.append('file', new File(['cover'], 'cover.jpg', {type: 'image/jpeg'}));
  const controller = new AbortController();
  const pending = client.request('/covers', {method: 'POST', body, signal: controller.signal});
  assert.equal(options.data, body);
  assert.deepEqual(options.headers, {Authorization: 'Bearer secret'});
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(aborted, true);
  const verification = client.request('/uploads', {method: 'POST', body: {size: 1}});
  options.onload({status: 429, response: {detail: {message: 'verification', code: 'rate_limited', retry_after: 60}}});
  await assert.rejects(verification, error => error.code === 'rate_limited' && error.retryAfter === 60);
  const wait = new AbortController();
  wait.abort();
  assert.throws(() => delay(100, wait.signal), {name: 'AbortError'});
});

test('queued upload tickets wait for the server cooldown; retry after lost completion reuses direct ticket even without a probed line', async () => {
  const calls = [],
    waits = [];
  let attempts = 0,
    completes = 0;
  const client = {
    request: async (path, options) => {
      calls.push([path, options]);
      if (path === '/uploads') {
        if (++attempts === 1) throw Object.assign(new Error('queued'), {status: 429, code: 'queued', retryAfter: 3});
        return ticket;
      }
      if (path === '/uploads/u/complete' && ++completes === 1) throw new Error('response lost');
    },
  };
  const transfers = [];
  const uploader = createClipUpload({client, transport: okTransport(transfers), sleep: async ms => waits.push(ms)});
  const options = uploadOptions(new AbortController().signal);
  await assert.rejects(uploader.run(file, options), /response lost/);
  assert.equal(await uploader.run(file, {...options, line: null}), 'u');
  assert.deepEqual(waits, [3000]);
  assert.equal(calls.filter(([path]) => path === '/uploads').length, 2);
  assert.equal(transfers.filter(call => call.url.includes('?uploads')).length, 1);
  assert.ok(!calls.some(([path]) => path === '/cos/uploads'));
});

test('COS verification pauses with studio guidance and retry polls the same relay record', async () => {
  let verified = false;
  const calls = [];
  const client = {
    request: async path => {
      calls.push(path);
      return {id: 'cos', state: verified ? 'uploaded' : 'queued', progress: 0, verification_required: !verified};
    },
  };
  const uploader = createClipUpload({client, transport: okTransport([])});
  const options = {...uploadOptions(new AbortController().signal), line: null};
  await assert.rejects(uploader.run(file, options), /studio.bk0717.com.*验证后重试/);
  verified = true;
  assert.equal(await uploader.run(file, options), 'cos');
  assert.deepEqual(calls, ['/cos/uploads', '/cos/uploads/cos']);
});

test('uploaded but unconfirmed job can still be cancelled and will not submit afterward', async () => {
  const f = jobFixture();
  f.uploaded.resolve('u');
  await f.job.start();
  assert.equal(f.job.state().uploaded, true);
  assert.equal(await f.job.cancel(), true);
  await f.job.confirm(fields);
  assert.equal(f.cleaned(), 1);
  assert.equal(f.calls.length, 0);
});
