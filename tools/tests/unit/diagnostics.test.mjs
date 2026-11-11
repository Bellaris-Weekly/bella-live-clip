import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticReporter} from '../../../src/services/diagnostics.js';
import {mediaStorageError} from '../../../src/media/temporary-media.js';
import worker from '../../../src/server/logs-worker.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const endpoint = 'https://logs.example.com/v1/logs';
function setup(overrides = {}) {
  const requests = [];
  let serial = 0;
  const reporter = createDiagnosticReporter({
    endpoint,
    version: '1.2.3',
    userAgent: 'Test/1',
    id: () => `operation-${serial++}`,
    online: () => true,
    wait: async () => {},
    request: options => {
      requests.push(options);
      options.onload({status: 201});
    },
    ...overrides,
  });
  return {reporter, requests};
}

test('快照保留失败操作身份，白名单不带媒体/会话，敏感文字在发送前清理', async () => {
  const {reporter, requests} = setup();
  const record = {
    kind: 'submission',
    key: 'old-part',
    bvid: 'BV1234567890',
    cid: 12,
    media: {url: 'https://secret.example/video?token=never'},
    Cookie: 'never',
  };
  const selection = {start: 12, end: 20};
  const operation = reporter.begin('export', {
    pageUrl: 'https://www.bilibili.com/video/BV1234567890?p=2&tracking=never',
    record,
    selection,
    mode: 'precise',
  });
  record.key = 'new-part';
  selection.start = 900;
  operation.stage('preparing');
  operation.progress({phase: 'processing', bytes: 100, progress: 0.25, cookie: 'never'});
  const error = new Error('failed Authorization: Bearer secret-text');
  error.stack =
    'Error at https://cdn.example.com/segment?token=stack-secret&newSignatureScheme=unknown-signature&cid=12#opaque-fragment';
  assert.equal(operation.fail(error), undefined);
  await settle();
  assert.equal(requests.length, 2);
  const options = requests.at(-1),
    payload = JSON.parse(options.data);
  assert.equal(options.anonymous, true);
  assert.equal(options.timeout, 8000);
  assert.deepEqual(options.headers, {'Content-Type': 'application/json'});
  assert.equal(payload.context.record.key, 'old-part');
  assert.equal(payload.context.selection.start, 12);
  assert.equal(payload.context.page, 'https://www.bilibili.com/video/BV1234567890?p=2');
  assert.equal(payload.context.stage, 'processing');
  assert.equal(payload.context.progress.bytes, 100);
  assert.ok(
    !options.data.includes('secret-text') && !options.data.includes('stack-secret') && !options.data.includes('never'),
  );
  assert.ok(!options.data.includes('unknown-signature') && !options.data.includes('opaque-fragment'));
  assert.equal(payload.context.stack, 'Error at https://cdn.example.com/segment');
  const response = await worker.fetch(
    new Request(endpoint, {method: 'POST', headers: options.headers, body: options.data}),
    {
      LOGS_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                async first() {
                  return sql.includes('COUNT(*)') ? {count: 0} : undefined;
                },
                async run() {
                  return {success: true, meta: {changes: 1}};
                },
              };
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 201, 'real backend validates the emitted contract');
});

test('失败重试使用相同事件与内容，永久拒绝不重试，重复fail不重复发送', async () => {
  for (const status of [503, 429, 400, 413]) {
    const requests = [];
    const {reporter} = setup({
      request: options => {
        requests.push(options);
        options.onload({status});
      },
    });
    const operation = reporter.begin('export');
    operation.fail(new Error('failed'));
    operation.fail(new Error('again'));
    await settle();
    const failures = requests.filter(item => JSON.parse(item.data).event === 'export_failed');
    assert.equal(failures.length, status >= 500 || status === 429 ? 2 : 1);
    if (failures.length === 2) assert.equal(failures[0].data, failures[1].data);
  }
});

test('取消记录正常事件，离线和无配置不上传；传输异常不会逃逸', async () => {
  const {reporter, requests} = setup();
  reporter.begin('export').fail(new DOMException('cancel', 'AbortError'));
  const controller = new AbortController();
  controller.abort();
  reporter.begin('export').fail(new Error('generic cancellation'), controller.signal);
  setup({online: () => false, request: () => assert.fail('offline request')})
    .reporter.begin('export')
    .fail(new Error('offline'));
  createDiagnosticReporter().begin('export').fail(new Error('unconfigured'));
  await settle();
  const cancellations = requests.map(item => JSON.parse(item.data)).filter(item => item.event === 'export_canceled');
  assert.equal(cancellations.length, 2);
  assert.ok(cancellations.every(item => item.level === 'info'));
  for (const request of [
    () => {
      throw new Error('transport');
    },
    options => options.onerror(),
    options => options.ontimeout(),
  ]) {
    assert.doesNotThrow(() => setup({request}).reporter.begin('load').fail(new Error('actual failure')));
  }
  await settle();
});

test('上传并发有界，有限队列完成后继续发送', async () => {
  const requests = [];
  const {reporter} = setup({request: options => requests.push(options)});
  for (let i = 0; i < 100; i++) reporter.begin('export').fail(new Error('failed'));
  assert.equal(requests.length, 2);
  requests[0].onload({status: 201});
  await settle();
  reporter.begin('export').fail(new Error('next'));
  assert.equal(requests.length, 3);
  requests[1].onload({status: 201});
  requests[2].onload({status: 201});
  await settle();
});

test('超长多字节和 JSON 转义错误仍满足实际 UTF8 限制', async () => {
  for (const unit of ['汉', '\u0000']) {
    const {reporter, requests} = setup();
    const error = new Error(unit.repeat(60000));
    error.stack = unit.repeat(60000);
    reporter.begin('export').fail(error);
    await settle();
    assert.equal(requests.length, 2);
    assert.ok(new TextEncoder().encode(requests.at(-1).data).byteLength <= 65536);
    assert.ok(JSON.parse(requests.at(-1).data).message.length <= 16384);
  }
});

test('正常导出持续上报实时等待，成功后终止心跳并保留同一任务身份', async () => {
  const {createExportMetrics} = await import('../../../src/media/export-metrics.js');
  let time = 0;
  const timers = new Map();
  const {reporter, requests} = setup({
    now: () => time,
    clock: () => new Date(time).toISOString(),
    every: fn => {
      timers.set(1, fn);
      return 1;
    },
    cancelTimer: id => timers.delete(id),
    visibility: () => 'visible',
  });
  const job = reporter.begin('export', {mode: 'danmaku', selection: {start: 0, end: 20}});
  const metrics = createExportMetrics({now: () => time});
  job.observe(metrics);
  job.stage('processing');
  job.progress({phase: 'processing', progress: 0.1, videoFrames: 30, processedSeconds: 1});
  const read = metrics.start('sampleWait');
  time = 10000;
  timers.get(1)();
  await settle();
  let event = JSON.parse(requests.at(-1).data);
  assert.equal(event.event, 'export_progress');
  assert.equal(event.context.metrics.active.sampleWait.oldestMs, 10000);
  time = 40000;
  timers.get(1)();
  await settle();
  event = JSON.parse(requests.at(-1).data);
  assert.equal(event.event, 'export_stalled');
  assert.equal(event.level, 'warn');
  assert.equal(event.context.runtime.noAdvanceMs, 40000);
  read();
  metrics.add('videoFrames', 600);
  job.progress({phase: 'complete', progress: 1, videoFrames: 600, processedSeconds: 20});
  job.finish({files: 1, writtenBytes: 4096, mediaSeconds: 20});
  job.finish();
  job.fail(new Error('late'));
  await settle();
  const logs = requests.map(item => JSON.parse(item.data));
  assert.equal(logs.at(-1).event, 'export_completed');
  assert.equal(logs.at(-1).context.throughput.realtime, 0.5);
  assert.equal(logs.at(-1).context.throughput.fps, 15);
  assert.equal(logs.at(-1).context.result.writtenBytes, 4096);
  assert.equal(new Set(logs.map(item => item.context.operation.id)).size, 1);
  assert.equal(new Set(logs.map(item => item.id)).size, logs.length);
  assert.equal(timers.size, 0);
});

test('metrics use a numeric allowlist and cannot transmit URLs, emote text or credentials', async () => {
  const {reporter, requests} = setup();
  const job = reporter.begin('export', {mode: 'danmaku'});
  job.progress({
    phase: 'processing',
    metrics: {
      elapsedMs: 123,
      cookie: 'private-value',
      url: 'https://private.test/token',
      encoder: {
        codec: 'avc1.42e01e',
        width: 1920,
        height: 1080,
        hardwarePreference: 'prefer-hardware',
        token: 'private-value',
      },
      stages: {render: {count: 1, totalMs: 4, maxMs: 4, headers: 'private-value'}, 'private-value': {count: 2}},
      counters: {videoFrames: 1, emoteFailures: 2, commentText: 'private-value'},
    },
  });
  job.finish();
  await settle();
  const body = requests.at(-1).data,
    context = JSON.parse(body).context;
  assert.doesNotMatch(body, /private/);
  assert.equal(context.metrics.stages.render.totalMs, 4);
  assert.equal(context.metrics.counters.emoteFailures, 2);
  assert.equal(context.metrics.encoder.hardwarePreference, 'prefer-hardware');
});

test('backlogged heartbeat snapshots coalesce and the queue remains bounded', async () => {
  const requests = [],
    callbacks = new Map();
  let time = 0;
  const {reporter} = setup({
    request: options => requests.push(options),
    now: () => time,
    every: fn => {
      callbacks.set(1, fn);
      return 1;
    },
    cancelTimer: id => callbacks.delete(id),
  });
  const job = reporter.begin('export');
  for (let i = 1; i <= 100; i++) {
    time = i * 10000;
    callbacks.get(1)();
  }
  job.finish();
  assert.equal(requests.length, 2);
  for (let i = 0; i < requests.length; i++) {
    requests[i].onload({status: 201});
    await settle();
  }
  const events = requests.map(item => JSON.parse(item.data).event);
  assert.equal(events.at(-1), 'export_completed');
  assert.ok(events.length <= 4);
});

test('失败日志保留被包装的浏览器错误、失败的存储操作和清理时的二次错误', async () => {
  const {reporter, requests} = setup();
  const browser = new DOMException('A requested file or directory could not be found', 'NotFoundError');
  browser.diagnostic = {operation: 'write', target: 'temporary', url: 'https://cdn.example/a.m4s?token=never'};
  const error = mediaStorageError(browser);
  error.suppressed = [new TypeError('Cannot close a ERRORED writable stream')];
  reporter.begin('export').fail(error);
  await settle();
  const failed = requests.map(item => JSON.parse(item.data)).find(item => item.event === 'export_failed');
  assert.equal(failed.context.error.message, error.message);
  assert.match(error.message, /浏览器临时文件读写失败，/);
  assert.ok(!error.message.includes(browser.name));
  assert.deepEqual(failed.context.error.causes, [
    {
      name: 'NotFoundError',
      message: 'A requested file or directory could not be found',
      code: 8,
      operation: 'write',
      target: 'temporary',
      url: 'https://cdn.example/a.m4s',
    },
  ]);
  assert.deepEqual(failed.context.error.suppressed, [
    {name: 'TypeError', message: 'Cannot close a ERRORED writable stream'},
  ]);
});

test('中断但保存了部分内容的整场下载记为 partial 警告并带中断原因', async () => {
  const {reporter, requests} = setup();
  const error = new Error('请求失败（HTTP 404），请重新加载后重试。');
  error.status = 404;
  reporter.begin('recording_download').finish({status: 'partial', error, files: 1, writtenBytes: 10, mediaSeconds: 5});
  await settle();
  const partial = requests.map(item => JSON.parse(item.data)).find(item => item.event === 'recording_download_partial');
  assert.equal(partial.level, 'warn');
  assert.equal(partial.message, error.message);
  assert.equal(partial.context.error.status, 404);
  assert.equal(partial.context.result.files, 1);
});

test('timeline retains stage changes and heartbeat metrics, downsamples to 60 and fits the wire cap', async () => {
  let time = 0,
    heartbeat;
  const {reporter, requests} = setup({
    now: () => time,
    every: fn => {
      heartbeat = fn;
    },
    cancelTimer() {},
  });
  const operation = reporter.begin('export');
  operation.observe({snapshot: () => ({elapsedMs: time, counters: {videoFrames: time / 10}})});
  for (let i = 1; i <= 150; i++) {
    time = i * 10000;
    operation.progress({
      phase: i % 2 ? 'preparing' : 'processing',
      progress: i / 150,
      bytes: i * 1024,
      videoFrames: i * 1000,
      processedSeconds: i * 10,
    });
    heartbeat();
    await settle();
  }
  operation.finish({files: 1, mediaSeconds: 1500});
  await settle();
  const logs = requests.map(request => JSON.parse(request.data));
  assert.equal(logs.at(-1).event, 'export_completed');
  assert.ok(logs.every(log => log.context.timeline.length <= 60));
  assert.ok(requests.every(request => Buffer.byteLength(request.data) <= 65536));
  const timeline = logs.at(-1).context.timeline;
  assert.equal(timeline[0].elapsedMs, 0);
  assert.equal(timeline.at(-1).elapsedMs, time);
  assert.equal(timeline.at(-1).fps, 100);
  assert.equal(timeline.at(-1).bytes, 150 * 1024);
  assert.equal(timeline.at(-1).fraction, 1);
  assert.ok(timeline.some(point => point.stage === 'preparing'));
  assert.ok(timeline.every((point, i) => i === 0 || point.elapsedMs >= timeline[i - 1].elapsedMs));
  assert.ok(
    logs.filter(log => log.event === 'export_progress').every(log => log.context.metrics.counters.videoFrames > 0),
  );
  assert.equal(logs[0].context.timeline.length, 1, 'published snapshots do not mutate');
});

test('问题反馈与功能建议立即发送，带页面上下文，可被日志服务接受，并如实返回结果', async () => {
  const {reporter, requests} = setup();
  assert.equal(reporter.canFeedback, true);
  const record = {kind: 'submission', key: 'BV1234567890:2', bvid: 'BV1234567890', cid: 12, part: 2};
  assert.equal(
    await reporter.feedback('issue', '  导出卡住了\n第二行 token=never https://x.example/a?sign=never  ', {
      pageUrl: 'https://www.bilibili.com/video/BV1234567890?p=2&spm=never',
      mode: 'precise',
      record,
      selection: {start: 3, end: 9},
      user: '成员',
    }),
    'sent',
  );
  assert.equal(await reporter.feedback('suggestion', '想要批量导出', {pageUrl: 'https://live.bilibili.com/1'}), 'sent');
  const [issue, suggestion] = requests.map(item => JSON.parse(item.data));
  assert.equal(issue.event, 'feedback_issue');
  assert.equal(issue.level, 'info');
  assert.equal(issue.version, '1.2.3');
  assert.ok(issue.message.startsWith('导出卡住了\n第二行'));
  assert.ok(!requests[0].data.includes('never'));
  assert.equal(issue.context.page, 'https://www.bilibili.com/video/BV1234567890?p=2');
  assert.equal(issue.context.record.bvid, 'BV1234567890');
  assert.deepEqual(issue.context.selection, {start: 3, end: 9});
  assert.equal(issue.context.user, '成员');
  assert.equal(issue.context.browser, 'Test/1');
  assert.equal(suggestion.event, 'feedback_suggestion');
  assert.equal(suggestion.context.record, undefined, 'no open record means no made-up record kind');
  for (const options of requests) {
    let inserted;
    const response = await worker.fetch(
      new Request(endpoint, {method: 'POST', headers: options.headers, body: options.data}),
      {
        LOGS_DB: {
          prepare(sql) {
            return {
              bind(...values) {
                return {
                  async first() {
                    return sql.includes('COUNT(*)') ? {count: 0} : undefined;
                  },
                  async run() {
                    if (sql.includes('INSERT')) inserted = values;
                    return {success: true, meta: {changes: 1}};
                  },
                };
              },
            };
          },
        },
      },
    );
    assert.equal(response.status, 201);
    assert.equal(inserted[4], JSON.parse(options.data).event);
  }
});

test('反馈结果：限流、拒绝、断网分别返回；未配置或未知类型不发请求', async () => {
  for (const [respond, expected] of [
    [options => options.onload({status: 429}), 'rate_limited'],
    [options => options.onload({status: 400}), 'failed'],
    [options => options.onload({status: 503}), 'failed'],
    [options => options.onerror(), 'failed'],
    [options => options.ontimeout(), 'failed'],
    [
      () => {
        throw new Error('transport');
      },
      'failed',
    ],
  ]) {
    const requests = [];
    const {reporter} = setup({
      request: options => {
        requests.push(options);
        respond(options);
      },
    });
    assert.equal(await reporter.feedback('issue', '问题'), expected);
    assert.ok(requests.length <= 1, 'feedback is not silently retried');
  }
  const unconfigured = createDiagnosticReporter();
  assert.equal(unconfigured.canFeedback, false);
  assert.equal(await unconfigured.feedback('issue', '问题'), 'failed');
  const {reporter, requests} = setup();
  assert.equal(await reporter.feedback('other', '问题'), 'failed');
  assert.equal(requests.length, 0);
});
