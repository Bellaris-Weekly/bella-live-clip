import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  Output,
  BufferTarget,
  Mp4OutputFormat,
  MpegTsOutputFormat,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  BlobSource,
  MP4,
} from 'mediabunny';
import {convertInput} from '../../../src/media/export.js';
import {exportSelection} from '../support/clip-export.mjs';
import {saveRecording} from '../../../src/media/recording.js';
import {avccUnits} from '../../../src/media/avc-packets.js';
import {RequestError} from '../../../src/services/retry-request.js';
import {config, frame} from '../support/synthetic-frame.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};
const videoConfig = {...config, description: new Uint8Array(Buffer.from(config.description, 'base64'))};
const videoFrame = new Uint8Array(Buffer.from(frame, 'base64'));
// One stereo AAC-LC silent packet generated with FFmpeg; no downloaded media.
const audioConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 48000,
  numberOfChannels: 2,
  description: new Uint8Array([0x11, 0x90]),
};
const audioFrame = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);

async function fixture(offset = 0, kind = 'plain') {
  const output = new Output({
    format: kind === 'ts' ? new MpegTsOutputFormat() : new Mp4OutputFormat({fastStart: 'fragmented'}),
    target: new BufferTarget(),
  });
  const video = new EncodedVideoPacketSource('avc'),
    audio = new EncodedAudioPacketSource('aac');
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  await Promise.all([
    (async () => {
      for (let i = 0; i < 60; i++)
        await video.add(new EncodedPacket(videoFrame, 'key', offset + i / 30, 1 / 30), {decoderConfig: videoConfig});
      video.close();
    })(),
    (async () => {
      for (let i = 0; i < 93; i++)
        await audio.add(new EncodedPacket(audioFrame, 'key', offset + (i * 1024) / 48000, 1024 / 48000), {
          decoderConfig: audioConfig,
        });
      audio.close();
    })(),
  ]);
  await output.finalize();
  return new Uint8Array(output.target.buffer);
}
function split(data) {
  let cursor = 0;
  while (cursor < data.length) {
    const size = new DataView(data.buffer, data.byteOffset + cursor).getUint32(0);
    if (new TextDecoder().decode(data.subarray(cursor + 4, cursor + 8)) === 'moof')
      return [data.slice(0, cursor), data.slice(cursor)];
    cursor += size;
  }
  throw new Error('Missing moof');
}
async function sampleApi(kind, absolute = false) {
  const files = new Map(),
    segments = [];
  for (let i = 0; i < 6; i++) {
    const data = await fixture(10 + (absolute ? 2 * i : 0), kind);
    segments.push({url: `part${i}`, duration: 2});
    if (kind === 'map') {
      const [map, media] = split(data);
      files.set('map', map);
      files.set(`part${i}`, media);
    } else files.set(`part${i}`, data);
  }
  const starts = [],
    finishes = [];
  let active = 0,
    peak = 0;
  return {
    starts,
    finishes,
    segments,
    get peak() {
      return peak;
    },
    get active() {
      return active;
    },
    groups: [{start: 100, streamEnd: 112, segments, map: kind === 'map' ? {url: 'map'} : null}],
    async request(url, {signal}) {
      starts.push(url);
      active++;
      peak = Math.max(peak, active);
      try {
        signal?.throwIfAborted();
        await this.beforeRead?.(url, signal);
        signal?.throwIfAborted();
        const data = files.get(url);
        finishes.push(url);
        return {data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)};
      } finally {
        active--;
      }
    },
  };
}
async function inspect(blob) {
  const input = new Input({source: new BlobSource(blob), formats: [MP4]});
  try {
    const tracks = await input.getTracks(),
      counts = {};
    for (const track of tracks) {
      let count = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        assert.ok(packet.data.length);
        count++;
      }
      counts[track.type] = count;
    }
    return {counts, duration: await input.computeDuration()};
  } finally {
    input.dispose();
  }
}

for (const [kind, absolute] of [
  ['plain', false],
  ['map', true],
  ['ts', true],
]) {
  test(`整场直接复制音视频包，清单偏差不改变实际帧数和时长（${kind}）`, async () => {
    const api = await sampleApi(kind, absolute),
      writes = [];
    let opened = 0,
      closed = 0;
    const file = {
      async createWritable() {
        opened++;
        return {
          async write(chunk) {
            writes.push({...chunk, data: chunk.data.slice()});
          },
          async close() {
            closed++;
          },
          async abort() {
            assert.fail('export should not abort');
          },
        };
      },
    };
    api.groups[0].segments.forEach(segment => (segment.duration = 1.8));
    await saveRecording(api, api.groups, file);
    const bytes = new Uint8Array(Math.max(...writes.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of writes) bytes.set(chunk.data, chunk.position);
    const result = await inspect(new Blob([bytes]));
    assert.deepEqual(result.counts, {video: 360, audio: 558});
    assert.ok(Math.abs(result.duration - 12) < 0.05);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.equal(
      api.starts.length,
      new Set(api.starts).size,
      'completed segments and shared init map must not be fetched again',
    );
    const input = new Input({source: new BlobSource(new Blob([bytes])), formats: [MP4]});
    try {
      for (const track of await input.getTracks())
        for await (const packet of new EncodedPacketSink(track).packets()) {
          if (track.type === 'video') {
            const pictures = data => avccUnits(data, 4).filter(unit => (unit[0] & 31) >= 1 && (unit[0] & 31) <= 5);
            assert.deepEqual(
              pictures(packet.data),
              pictures(videoFrame),
              'encoded picture payload must remain byte-identical',
            );
          } else assert.deepEqual(packet.data, audioFrame, 'encoded audio must remain byte-identical');
        }
    } finally {
      input.dispose();
    }
  });
}

for (const [kind, absolute] of [
  ['plain', false],
  ['map', true],
  ['ts', false],
]) {
  test(`选区在后续分片下载时已开始处理，保留音视频和时间轴（${kind}）`, async () => {
    const api = await sampleApi(kind, absolute),
      slow = deferred(),
      events = [];
    let overlapped = false;
    api.beforeRead = async url => {
      if (url === 'part1') await slow.promise;
    };
    const outputs = await exportSelection(
      api,
      {start: 90},
      api.groups,
      {start: 10, end: 22},
      {
        onProgress(event) {
          events.push(event);
          if (event.processing > 0 && !overlapped) {
            overlapped = true;
            assert.ok(api.starts.includes('part1'), '下一片应已经开始下载');
            assert.ok(!api.finishes.includes('part1'), '处理开始时下一片仍在下载');
            assert.ok(!api.finishes.includes('part4'), '不能在处理前读完整个选区');
            slow.resolve();
          }
        },
      },
    );
    assert.ok(overlapped);
    assert.ok(api.peak <= 2, '前向下载并发必须有界');
    assert.equal(
      api.starts.length,
      new Set(api.starts).size,
      `两轨同时读片和尾部探测不能重复下载：${api.starts.slice(0, 30)}`,
    );
    assert.deepEqual(
      outputs.map(output => [output.start, output.end]),
      [[10, 22]],
    );
    const media = await inspect(outputs[0].blob);
    assert.ok(Math.abs(media.duration - 12) < 0.05);
    assert.deepEqual(media.counts, {video: 360, audio: 558});
    assert.equal(events.at(-1).progress, 1);
    assert.equal(events.at(-1).phase, 'complete');
    assert.equal(events.at(-1).downloaded, kind === 'map' ? 7 : 6);
    assert.ok(
      events.slice(0, -1).every(event => event.progress < 1),
      '只有已完成封装才能到 100%',
    );
    assert.ok(
      events.every((event, index) => !index || event.progress >= events[index - 1].progress),
      '并行进度不能倒退',
    );
  });
}

for (const reason of ['abort', 'network', 'processing']) {
  test(`并行导出${reason}失败终止待下载请求，立即重试可成功`, async () => {
    const api = await sampleApi('plain'),
      controller = new AbortController(),
      began = deferred(),
      failure = new Error(reason);
    let pendingAborted = false,
      interrupted = false;
    api.beforeRead = async (url, signal) => {
      if (url === 'part1') {
        began.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              pendingAborted = true;
              reject(signal.reason);
            },
            {once: true},
          );
        });
      }
      if (reason === 'network' && url === 'part2') {
        await began.promise;
        throw failure;
      }
    };
    const events = [];
    await assert.rejects(
      exportSelection(
        api,
        {start: 90},
        api.groups,
        {start: 10, end: 22},
        {
          signal: controller.signal,
          onProgress(event) {
            events.push(event);
            if (event.processing > 0 && !interrupted && reason !== 'network') {
              interrupted = true;
              if (reason === 'abort') controller.abort(failure);
              else throw failure;
            }
          },
        },
      ),
      error => error === failure,
    );
    assert.ok(pendingAborted);
    assert.equal(api.active, 0);
    assert.ok(events.every(event => event.progress < 1));
    api.beforeRead = undefined;
    const retry = await exportSelection(api, {start: 90}, api.groups, {start: 10, end: 22});
    assert.equal((await inspect(retry[0].blob)).counts.video, 360);
  });
}

test('选区预读网络失败会等待重连，保持处理进度并完成同一次导出', async () => {
  const api = await sampleApi('plain'),
    events = [];
  let attempts = 0;
  api.beforeRead = async url => {
    if (url === 'part1' && attempts++ === 0) throw new RequestError('connection lost', {retryable: true});
  };
  const outputs = await exportSelection(
    api,
    {start: 90},
    api.groups,
    {start: 10, end: 22},
    {onProgress: event => events.push(event)},
  );
  assert.ok(events.some(event => event.reconnecting > 0));
  assert.equal(events.at(-1).reconnecting, 0);
  assert.equal(events.at(-1).progress, 1);
  assert.equal((await inspect(outputs[0].blob)).counts.video, 360);
  assert.equal(api.starts.filter(url => url === 'part1').length, 2);
  assert.equal(api.finishes.length, new Set(api.finishes).size);
});

test('convertInput 完成后由调用者继续使用和释放输入', async () => {
  const input = new Input({source: new BlobSource(new Blob([await fixture()])), formats: [MP4]});
  try {
    const blob = await convertInput(input, {start: 0.5, end: 1.5});
    assert.ok(blob.size);
    assert.ok(await input.getPrimaryVideoTrack());
    assert.equal(await input.computeDuration(), 2);
  } finally {
    input.dispose();
  }
});

test('尾部清单时长高估时按真实数据夹紧，进度跨多个输出累计', async () => {
  const api = await sampleApi('plain');
  const first = {
    ...api.groups[0],
    segments: api.segments.map((segment, index) => ({...segment, duration: index === 5 ? 2.8 : 2})),
    streamEnd: 113,
  };
  const second = {...api.groups[0], start: 115, streamEnd: 127};
  const events = [];
  const outputs = await exportSelection(
    api,
    {start: 90},
    [first, second],
    {start: 10, end: 37},
    {onProgress: event => events.push(event)},
  );
  assert.deepEqual(
    outputs.map(output => [output.start, output.end]),
    [
      [10, 22.8],
      [25, 37],
    ],
  );
  assert.ok(events.every((event, index) => !index || event.progress >= events[index - 1].progress));
  assert.equal(events.filter(event => event.progress === 1).length, 1);
  assert.equal(events.at(-1).downloaded, 6, '跨输出复用的资源只累计一次完成数');
  for (const output of outputs) assert.equal((await inspect(output.blob)).counts.video, 360);
});

function markAudioDependent(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function boxes(start, end) {
    const result = [];
    for (let at = start; at < end;) {
      const size = view.getUint32(at);
      assert.ok(size >= 8);
      result.push({at, size, type: new TextDecoder().decode(bytes.subarray(at + 4, at + 8))});
      at += size;
    }
    return result;
  }
  let changed = 0;
  for (const moof of boxes(0, bytes.length).filter(b => b.type === 'moof'))
    for (const traf of boxes(moof.at + 8, moof.at + moof.size).filter(b => b.type === 'traf')) {
      const children = boxes(traf.at + 8, traf.at + traf.size),
        header = children.find(b => b.type === 'tfhd');
      if (view.getUint32(header.at + 12) !== 2) continue;
      const flags = view.getUint32(header.at + 8) & 0xffffff;
      let cursor = header.at + 16;
      for (const [flag, size] of [
        [1, 8],
        [2, 4],
        [8, 4],
        [16, 4],
      ])
        if (flags & flag) cursor += size;
      if (flags & 32) {
        view.setUint32(cursor, view.getUint32(cursor) | 0x10000);
        changed++;
      }
      for (const run of children.filter(b => b.type === 'trun')) {
        const flags = view.getUint32(run.at + 8) & 0xffffff,
          count = view.getUint32(run.at + 12);
        let cursor = run.at + 16;
        if (flags & 1) cursor += 4;
        if (flags & 4) {
          view.setUint32(cursor, view.getUint32(cursor) | 0x10000);
          cursor += 4;
          changed++;
        }
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) cursor += 4;
          if (flags & 0x200) cursor += 4;
          if (flags & 0x400) {
            view.setUint32(cursor, view.getUint32(cursor) | 0x10000);
            cursor += 4;
            changed++;
          }
          if (flags & 0x800) cursor += 4;
        }
      }
    }
  assert.ok(changed);
  return bytes;
}

test('AAC 容器误标依赖包时仍保留全部声音，不把音频首包当作损坏 GOP 丢弃', async () => {
  const data = markAudioDependent(await fixture()),
    writes = [];
  const input = new Input({source: new BlobSource(new Blob([data])), formats: [MP4]});
  try {
    assert.equal(
      (await new EncodedPacketSink(await input.getPrimaryAudioTrack()).getFirstPacket({verifyKeyPackets: true})).type,
      'delta',
      '真实复现容器误标且 verifyKeyPackets 不纠正的音频首包',
    );
  } finally {
    input.dispose();
  }
  await saveRecording({request: async () => ({data: data.buffer})}, [{segments: [{url: 'sample', duration: 2}]}], {
    async createWritable() {
      return {
        async write(chunk) {
          writes.push({...chunk, data: chunk.data.slice()});
        },
        async close() {},
        async abort() {
          assert.fail('cannot abort');
        },
      };
    },
  });
  const bytes = new Uint8Array(Math.max(...writes.map(c => c.position + c.data.length)));
  for (const c of writes) bytes.set(c.data, c.position);
  const output = new Input({source: new BlobSource(new Blob([bytes])), formats: [MP4]});
  try {
    let count = 0;
    for await (const p of new EncodedPacketSink(await output.getPrimaryAudioTrack()).packets()) {
      assert.equal(p.type, 'key');
      assert.deepEqual(p.data, audioFrame);
      assert.ok(Math.abs(p.timestamp - (count * 1024) / 48000) < 0.00001);
      count++;
    }
    assert.equal(count, 93);
    assert.ok(await output.getPrimaryVideoTrack());
  } finally {
    output.dispose();
  }
});

for (const [kind, absolute] of [
  ['plain', true],
  ['plain', false],
  ['map', true],
  ['ts', true],
]) {
  for (const duration of [1.8, 1.95])
    test(`选区统一真实时间线：${kind} ${absolute ? '连续' : '重置'}时间戳，清单 ${duration} 秒`, async () => {
      const api = await sampleApi(kind, absolute);
      api.segments.forEach(segment => (segment.duration = duration));
      api.groups[0].streamEnd = 100 + duration * 6;
      const outputs = await exportSelection(api, {start: 100}, api.groups, {start: 0, end: duration * 6});
      const media = await inspect(outputs[0].blob);
      assert.deepEqual(media.counts, {video: 360, audio: 558});
      assert.ok(Math.abs(media.duration - 12) < 0.05, '累计清单误差不能改写实际媒体时长');
      const input = new Input({source: new BlobSource(outputs[0].blob), formats: [MP4]});
      try {
        for await (const packet of new EncodedPacketSink(await input.getPrimaryAudioTrack()).packets())
          assert.deepEqual(packet.data, audioFrame);
        for await (const packet of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets()) {
          const pictures = data => avccUnits(data, 4).filter(unit => (unit[0] & 31) >= 1 && (unit[0] & 31) <= 5);
          assert.deepEqual(pictures(packet.data), pictures(videoFrame));
        }
      } finally {
        input.dispose();
      }
    });
}

for (const duration of [1.8, 2.2])
  test(`后续选区按所在分片映射实际起止，清单 ${duration} 秒`, async () => {
    const api = await sampleApi('plain', true);
    api.segments.forEach(segment => (segment.duration = duration));
    api.groups[0].streamEnd = 100 + duration * 6;
    // Inside segments 2 and 4: real media positions 4.2 and 8.2 regardless
    // of the declared playlist durations. Prefix files need not be downloaded.
    const outputs = await exportSelection(api, {start: 100}, api.groups, {
      start: 2 * duration + 0.2,
      end: 4 * duration + 0.2,
    });
    const media = await inspect(outputs[0].blob);
    assert.equal(media.counts.video, 120);
    assert.ok(Math.abs(media.duration - 4) < 0.05);
    assert.ok(!api.starts.includes('part0'));
    assert.ok(!api.starts.includes('part1'));
  });

for (const failure of ['temporary-quota', 'destination-write', 'destination-close', 'cancel'])
  test(`选区 ${failure} 会清理临时文件和未完成的成品`, async () => {
    const {exportSelection: saveSelection} = await import('../../../src/media/export.js');
    const {memoryFile} = await import('../support/memory-file.mjs');
    const api = await sampleApi('plain', true),
      controller = new AbortController();
    const error = failure === 'temporary-quota' ? new DOMException('quota', 'QuotaExceededError') : new Error(failure);
    const temporary = memoryFile(),
      target = memoryFile();
    let tempRemoved = 0,
      destRemoved = 0,
      saved = 0;
    if (failure === 'temporary-quota')
      temporary.createWritable = async () => {
        throw error;
      };
    const createWritable = target.createWritable;
    target.createWritable = async () => {
      const writer = await createWritable();
      if (failure === 'destination-write')
        writer.write = async () => {
          throw error;
        };
      if (failure === 'destination-close')
        writer.close = async () => {
          throw error;
        };
      return writer;
    };
    await assert.rejects(
      saveSelection(
        api,
        {start: 100},
        api.groups,
        {start: 0, end: 12},
        {
          signal: controller.signal,
          createTemporary: async () => ({
            handle: temporary,
            async remove() {
              tempRemoved++;
            },
          }),
          createFile: async () => ({
            handle: target,
            name: 'target.mp4',
            async remove() {
              destRemoved++;
            },
          }),
          onSaved() {
            saved++;
          },
          onProgress(event) {
            if (failure === 'cancel' && event.phase === 'processing') controller.abort(error);
          },
        },
      ),
      thrown =>
        failure === 'temporary-quota'
          ? /存储空间不足/.test(thrown.message) && thrown.cause === error
          : thrown === error,
    );
    assert.equal(tempRemoved, 1);
    assert.equal(saved, 0);
    assert.equal(target.stats.closed, 0);
    assert.equal(destRemoved, failure === 'temporary-quota' ? 0 : 1);
    if (failure !== 'temporary-quota') assert.equal(target.stats.aborted, 1);
  });

test('跨断流后段失败时，已成功保存的前段仍保留并已通知界面', async () => {
  const {exportSelection: saveSelection} = await import('../../../src/media/export.js');
  const {memoryFile} = await import('../support/memory-file.mjs');
  const api = await sampleApi('plain', true),
    group = api.groups[0];
  const files = [],
    removed = [],
    saved = [];
  let cleanups = 0;
  const error = new Error('second file denied');
  await assert.rejects(
    saveSelection(
      api,
      {start: 100},
      [group, {...group, start: 115, streamEnd: 127}],
      {start: 0, end: 27},
      {
        createTemporary: async () => ({
          handle: memoryFile(),
          async remove() {
            cleanups++;
          },
        }),
        createFile: async ({index}) => {
          if (index) throw error;
          const handle = memoryFile();
          files.push(handle);
          return {
            handle,
            name: 'first.mp4',
            async remove() {
              removed.push(index);
            },
          };
        },
        onSaved(output) {
          saved.push(output);
        },
      },
    ),
    value => value === error,
  );
  assert.equal(cleanups, 2);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].bytes > 0);
  assert.equal(files[0].stats.closed, 1);
  assert.deepEqual(removed, []);
});

for (const start of [0.27, 0.67])
  test(`跨多个文件的 B 帧 GOP 向前后寻找真实关键帧：${start}`, async () => {
    const {config: bConfig, packets: bPackets} = await import('../support/b-frames.mjs');
    const decoderConfig = {...bConfig, description: new Uint8Array(Buffer.from(bConfig.description, 'base64'))};
    const files = new Map(),
      segments = [],
      reads = [];
    for (let gop = 0; gop < 4; gop++)
      for (let part = 0; part < 3; part++) {
        const output = new Output({format: new Mp4OutputFormat({fastStart: false}), target: new BufferTarget()});
        const video = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(video);
        await output.start();
        for (const [i, p] of bPackets.slice(part * 4, (part + 1) * 4).entries()) {
          // The container lies about its first packet; byte-level verification must
          // reject this false key and look across multiple preceding files.
          await video.add(
            new EncodedPacket(
              new Uint8Array(Buffer.from(p.data, 'base64')),
              i === 0 ? 'key' : p.type,
              p.timestamp + gop * 0.4,
              p.duration,
            ),
            {decoderConfig},
          );
        }
        video.close();
        await output.finalize();
        const url = `part${gop * 3 + part}`;
        files.set(url, output.target.buffer);
        segments.push({url, duration: 0.4 / 3});
      }
    const api = {
      async request(url) {
        reads.push(url);
        return {data: files.get(url)};
      },
    };
    const outputs = await exportSelection(api, {start: 0}, [{start: 0, streamEnd: 1.6, segments}], {
      start,
      end: start + 0.2,
    });
    const initial = Math.floor(start / 0.4) * 3;
    assert.ok(reads.includes(`part${initial}`), 'must search more than one preceding segment');
    assert.ok(reads.includes(`part${initial + 6}`), 'must read through the next independent GOP');
    const input = new Input({source: new BlobSource(outputs[0].blob), formats: [MP4]});
    try {
      const packets = [];
      for await (const p of new EncodedPacketSink(await input.getPrimaryVideoTrack()).packets()) packets.push(p);
      assert.equal(packets[0].type, 'key');
      assert.ok(
        packets.some((p, i) => i && p.timestamp < packets[i - 1].timestamp),
        'B-frame decode order must remain',
      );
      for (const packet of packets)
        assert.ok(
          bPackets.some(p => Buffer.from(p.data, 'base64').equals(Buffer.from(packet.data))),
          'video bytes must remain original',
        );
    } finally {
      input.dispose();
    }
  });

const missing = () => new RequestError('请求失败（HTTP 404），请重新加载后重试。', {status: 404});

test('整场保存遇到读不到的分片时保留已完成部分，并报告中断原因', async () => {
  const {memoryFile} = await import('../support/memory-file.mjs');
  const api = await sampleApi('plain', true);
  api.beforeRead = url => {
    if (url === 'part4') throw missing();
  };
  const file = memoryFile();
  const result = await saveRecording(api, api.groups, file, {keepPartial: true, concurrency: 1});
  assert.equal(result.saved, true);
  assert.equal(result.stopped, true);
  assert.equal(result.interrupted.status, 404);
  assert.equal(file.stats.closed, 1);
  const saved = await inspect(await file.getFile());
  assert.ok(Math.abs(saved.duration - 8) < 0.1, `kept the four readable parts, got ${saved.duration}`);

  const strict = memoryFile();
  await assert.rejects(saveRecording(api, api.groups, strict, {concurrency: 1}), error => error.status === 404);
  assert.equal(strict.stats.closed, 0);
  assert.equal(strict.stats.aborted, 1);
});

test('直播中的录像对尚未生成的分片短暂重试，之后照常保存', async () => {
  const {memoryFile} = await import('../support/memory-file.mjs');
  const api = await sampleApi('plain', true);
  let failures = 0;
  api.beforeRead = url => {
    if (url === 'part5' && !failures++) throw missing();
  };
  const file = memoryFile();
  const result = await saveRecording(api, api.groups, file, {missingRetries: 2, concurrency: 1});
  assert.equal(result.interrupted, undefined);
  assert.equal(result.stopped, false);
  assert.equal(failures, 2);
  assert.ok(Math.abs((await inspect(await file.getFile())).duration - 12) < 0.1);
});

test('只有一个保存位置时，跨断流的选区在下载前就被拒绝；越过断流一点点不算', async () => {
  const api = await sampleApi('plain', true),
    group = api.groups[0];
  const groups = [group, {...group, start: 115, streamEnd: 127}];
  let created = 0;
  await assert.rejects(
    exportSelection(
      api,
      {start: 100},
      groups,
      {start: 0, end: 27},
      {
        maxFiles: 1,
        createTemporary: async () => {
          created++;
        },
      },
    ),
    /断流位置/,
  );
  assert.equal(created, 0);
  assert.equal(api.starts.length, 0);
  const outputs = await exportSelection(api, {start: 100}, groups, {start: 9, end: 15.05}, {maxFiles: 1});
  assert.equal(outputs.length, 1);
});

test('临时文件写入失败时报告浏览器原始错误和失败的操作，而不是清理时的二次错误', async () => {
  const api = await sampleApi('plain', true);
  const lost = new DOMException('A requested file or directory could not be found', 'NotFoundError');
  let aborted = 0;
  const handle = {
    async createWritable() {
      return {
        async write() {
          throw lost;
        },
        async close() {},
        async abort() {
          aborted++;
        },
      };
    },
  };
  const error = await exportSelection(
    api,
    {start: 100},
    api.groups,
    {start: 1, end: 9},
    {
      createTemporary: async () => ({handle, async remove() {}}),
    },
  ).catch(error => error);
  assert.match(error.message, /浏览器临时文件读写失败（NotFoundError）/);
  assert.equal(error.cause, lost);
  assert.equal(lost.diagnostic.target, 'temporary');
  assert.equal(aborted, 1);
});

test('写入流已出错时，取消输出不会用二次错误替换原因', async () => {
  const {createMediaOutput} = await import('../../../src/media/file-output.js');
  const lost = new DOMException('A requested file or directory could not be found', 'NotFoundError');
  let aborted = 0;
  const fileHandle = {
    async createWritable() {
      return {
        async write() {
          throw lost;
        },
        async close() {},
        async abort() {
          aborted++;
        },
      };
    },
  };
  const session = await createMediaOutput({fileHandle, storageTarget: 'temporary'});
  const source = new EncodedAudioPacketSource('aac');
  session.output.addAudioTrack(source);
  await session.output.start();
  // Large packets fill the 1 MiB write chunks while the output is still muxing.
  let failure;
  try {
    for (let i = 0; i < 20; i++) {
      await source.add(new EncodedPacket(new Uint8Array(400_000), 'key', i, 1), {decoderConfig: audioConfig});
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    await session.finish();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure, lost);
  assert.deepEqual(lost.diagnostic, {operation: 'write', target: 'temporary'});
  await session.cancel(failure);
  assert.equal(aborted, 1);
  assert.ok(failure.suppressed?.every(error => error instanceof TypeError));
});
