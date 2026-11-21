import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measureRecordingStream, recordingStreams} from '../../../src/media/recording-streams.js';
import {RecordingPlan} from '../../../src/media/recording-plan.js';
import {sharePlaylists} from '../../../src/services/shared-playlists.js';

const start = 1795265623;
const record = {start, end: start + 9720};
const part = (from, to) => ({start_time: start + from, end_time: start + to, stream: `https://media.example/${from}`});
const manifest = (url, duration) => ({url, data: `#EXTM3U\n#EXTINF:${duration},\nclip.mp4\n#EXT-X-ENDLIST`});
const noRead = () => assert.fail('时间范围正常时不应额外请求播放清单');

test('乃琳 20:53 的回放打开主体，历史场次时间和整场导出索引一致', async () => {
  const body = part(13, 9718);
  const streams = await recordingStreams(record, [part(6, 6), body], noRead);
  assert.deepEqual(streams, [body]);
  const reads = [];
  const plan = new RecordingPlan({request: async url => (reads.push(url), manifest(url, 4))}, streams);
  const [group] = await plan.loadPart(0);
  assert.deepEqual(reads, [body.stream]);
  assert.equal(group.start - start, 13);
  assert.equal(group.streamEnd - group.start, 9705);
  assert.equal(group.part, body);
});

test('保留正常短段和中间分段，只按需读取中间零时长的清单', async () => {
  const short = part(10, 10.5),
    middle = part(20, 20),
    last = part(21, 40);
  const streams = await recordingStreams(record, [part(5, 5), short, middle, last, part(42, 42)], noRead);
  assert.deepEqual(streams, [short, middle, last]);
  const plan = new RecordingPlan(
    {
      request: async url => {
        assert.notEqual(url, middle.stream);
        return manifest(url, 1);
      },
    },
    streams,
  );
  assert.deepEqual(
    (await plan.load()).map(group => group.streamIndex),
    [0, 2],
  );
  const measured = await measureRecordingStream(streams, 1, record, async url => manifest(url, 3));
  assert.equal(measured.end_time, last.start_time);
  assert.equal(measured.start_time, middle.start_time);
});

test('直播尾段变长后加入分段列表，原来的选段保持同一索引', async () => {
  const live = {...record, live: true},
    first = part(10, 100),
    tail = part(110, 110);
  const streams = await recordingStreams(live, [first, tail], noRead);
  assert.deepEqual(streams, [first]);
  const grown = {...tail, end_time: start + 114};
  assert.deepEqual(await recordingStreams(live, [first, grown], noRead, undefined, streams), [first, grown]);
});

test('全部为零时从可读清单恢复时长，复用播放清单且不跨场次末尾', async () => {
  const only = part(9719, 9719),
    reads = [];
  const shared = sharePlaylists(async url => {
    reads.push(url);
    if (url !== only.stream) throw new Error('HTTP 404');
    return manifest(url, 1.33);
  });
  const streams = await recordingStreams(record, [part(0, 0), only], shared.request);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].end_time, record.end);
  await new RecordingPlan(shared, streams).loadPart(0);
  assert.deepEqual(reads, [part(0, 0).stream, only.stream]);
  assert.deepEqual(await recordingStreams(record, [part(0, 1), only], noRead, undefined, streams), [
    part(0, 1),
    ...streams,
  ]);
});

test('全部无法使用时保留错误原因，取消后不会探测下一段', async () => {
  await assert.rejects(recordingStreams(record, [part(-10, 0), part(9720, 9721)], noRead), /没有可下载的录像分段/);
  await assert.rejects(
    recordingStreams(record, [part(6, 6)], async url => ({url, data: '#EXTM3U'})),
    /尚无可下载/,
  );
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    recordingStreams(
      record,
      [part(1, 1), part(10, 10)],
      async url => {
        reads++;
        controller.abort();
        return manifest(url, 2);
      },
      controller.signal,
    ),
    {name: 'AbortError'},
  );
  assert.equal(reads, 1);
});
