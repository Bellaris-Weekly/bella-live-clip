import { Input, BlobSource, MP4, EncodedPacketSink } from 'mediabunny';
import { exportSelection, convertMp4 } from '../../../src/media/export.js';
import { createTemporaryMedia } from '../../../src/media/temporary-media.js';
import { createClipFile } from '../../../src/media/file-output.js';
import { createApp } from '../../../src/app/application.js';
import { inspectMedia } from '../support/media-info.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const result = document.getElementById('result');
const persist = (name, body) => fetch(`/artifact/${name}`, { method: 'POST', body });
async function play(file) {
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.muted = true; video.playbackRate = 8; video.src = url; document.body.append(video);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('playback timeout')), 30000);
      video.onended = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message)); };
      video.play().catch(reject);
    });
  } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); }
}
async function packetSummary(file) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4] });
  try {
    const summary = {};
    for (const track of await input.getTracks()) {
      let frames = 0, first = null, last = 0, reordered = false, previous = -Infinity;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        first ??= packet.timestamp; last = Math.max(last, packet.timestamp + packet.duration);
        reordered ||= packet.timestamp < previous; previous = packet.timestamp; frames++;
      }
      summary[track.type] = { frames, first, last, reordered };
    }
    return summary;
  } finally { input.dispose(); }
}

document.getElementById('test').textContent = '验证磁盘导出与时间线';
document.getElementById('test').onclick = async () => {
  const cases = []; let directory, root, name;
  try {
    root = await navigator.storage.getDirectory(); name = `disk-export-check-${crypto.randomUUID()}`;
    directory = await root.getDirectoryHandle(name, { create: true });
    const api = { async request(url, { signal }) {
      const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data: await response.arrayBuffer() };
    } };
    const segments = Array.from({ length: 6 }, (_, i) => ({ url: `/stream-fixture/part${i}.ts`, duration: 1.8 }));
    const groups = [{ start: 100, streamEnd: 110.8, segments }];
    for (const precise of [false, true]) {
      const mode = precise ? 'precise' : 'copy'; result.textContent = `正在验证 ${mode} 分片时长偏差…`;
      let created = 0, cleaned = 0; const events = [];
      const outputs = await exportSelection(api, { start: 100 }, groups, { start: 0, end: 10.8 }, {
        precise,
        createTemporary: async options => { const resource = await createTemporaryMedia(options); created++; return { ...resource, async remove() { await resource.remove(); cleaned++; } }; },
        createFile: () => createClipFile(directory, `${mode}.mp4`),
        onProgress: state => events.push(state),
      });
      const file = await (await directory.getFileHandle(outputs[0].name)).getFile();
      const info = await inspectMedia(file), packets = await packetSummary(file);
      assert(info.hasAudio && info.hasVideo && Math.abs(info.duration - 12) < .1, 'duration or AV incorrect');
      assert(packets.video.frames === 360, 'lost video frames');
      assert(created === 1 && cleaned === 1, 'temporary file leaked');
      assert(events.at(-1).progress === 1 && events.every((event, i) => !i || event.progress >= events[i - 1].progress), 'bad progress');
      await persist(`disk-${mode}.mp4`, file); await play(file);
      cases.push({ mode, bytes: outputs[0].bytes, info, packets, cleaned, played: true });
    }
    const source = await (await fetch('/fixture.mp4')).blob();
    result.textContent = '正在验证非关键帧精确裁剪直接写盘…';
    const file = await createClipFile(directory, 'fractional.mp4'), events = [];
    await convertMp4(source, { start: 1.25, end: 9.75, precise: true, fileHandle: file.handle,
      onProgress: (progress, detail) => events.push({ progress, ...detail }) });
    const saved = await file.handle.getFile(), info = await inspectMedia(saved);
    assert(info.hasAudio && info.hasVideo && Math.abs(info.duration - 8.5) < .05, 'fractional trim incorrect');
    assert(events.at(-1).copiedFrames > 0 && events.at(-1).encodedFrames > 0, 'must splice copied middle and encoded boundaries');
    await persist('disk-fractional.mp4', saved); await play(saved);
    cases.push({ mode: 'fractional', info, stats: events.at(-1), played: true });
    result.textContent = '正在验证取消时清理临时文件…';
    const controller = new AbortController(); let cleaned = 0, canceled = false;
    try {
      await exportSelection(api, { start: 100 }, groups, { start: 0, end: 10.8 }, {
        signal: controller.signal, createFile: () => createClipFile(directory, 'canceled.mp4'),
        createTemporary: async options => { const resource = await createTemporaryMedia(options); return { ...resource, async remove() { await resource.remove(); cleaned++; } }; },
        onProgress: state => { if (state.phase === 'processing') controller.abort(); },
      });
    } catch (error) { assert(error.name === 'AbortError', error.message); canceled = true; }
    assert(canceled && cleaned === 1, 'cancellation did not clean scratch');
    try { await directory.getFileHandle('canceled.mp4'); throw new Error('canceled output retained'); }
    catch (error) { assert(error.name === 'NotFoundError', error.message); }
    cases.push({ mode: 'cancel', canceled, cleaned });
    await persist('disk-results.json', JSON.stringify({ passed: true, cases }, null, 2));
    result.textContent = '通过：磁盘导出、清单偏差、完整音画、精确拼接、原生播放和取消清理。';
  } catch (error) {
    result.textContent = `失败：${error.message}`;
    await persist('disk-results.json', JSON.stringify({ passed: false, cases, error: error.stack }, null, 2));
  } finally { if (directory) await root.removeEntry(name, { recursive: true }); }
};

// A separate native picker check exercises the actual application click handler.
const appButton = document.createElement('button'); appButton.textContent = '打开实际保存流程'; document.getElementById('test').after(appButton);
appButton.onclick = async () => {
  const record = { key: 'disk-ui', title: '长录像导出验证', start: 100, end: 110.8, live: false, uid: 1, member: '贝拉', room: 22632424 };
  const manifest = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', ...Array.from({ length: 6 }, (_, i) => `#EXTINF:1.8,\n/stream-fixture/part${i}.ts`), '#EXT-X-ENDLIST'].join('\n');
  const api = { history: async () => [record], current: async () => null,
    clips: async () => [{ stream: location.origin + '/disk.m3u8', start_time: 100, end_time: 110.8 }],
    async request(url, { type, signal } = {}) {
      signal?.throwIfAborted(); if (url.endsWith('/disk.m3u8')) return { data: manifest, url };
      if (url.startsWith(location.origin)) { const response = await fetch(url, { signal }); return { data: type === 'arraybuffer' ? await response.arrayBuffer() : await response.text(), url }; }
      throw new Error('验证页不读取外部服务');
    },
  };
  const app = createApp({ api, pageUrl: location.origin }); await app.open();
};
