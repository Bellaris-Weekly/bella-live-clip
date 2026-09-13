import { Input, BlobSource, MP4, EncodedPacketSink } from 'mediabunny';
import { convertMp4, exportSelection } from '../../../src/media/export.js';
import { createAvcNormalizer } from '../../../src/media/avc-packets.js';
import { inspectMedia } from '../support/media-info.mjs';

async function packets(blob, type = 'video') {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const track = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack(), result = [];
    let normalizer;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      if (type === 'video') normalizer ??= createAvcNormalizer(await track.getDecoderConfig(), packet);
      result.push(normalizer ? normalizer.normalize(packet) : packet);
    }
    return result;
  } finally { input.dispose(); }
}

async function playback(blob) {
  const video = document.createElement('video'), url = URL.createObjectURL(blob);
  video.muted = true; video.playsInline = true; video.src = url;
  video.style.cssText = 'width:320px;display:block';
  document.getElementById('result').after(video);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('浏览器播放超时')), 30000);
      video.onended = () => { clearTimeout(timeout); resolve(); };
      video.onerror = () => { clearTimeout(timeout); reject(new Error(video.error?.message || '浏览器播放失败')); };
      video.playbackRate = 4;
      video.play().catch(error => { clearTimeout(timeout); reject(error); });
    });
  } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); }
}

export async function runSmartExportChecks() {
  const status = document.getElementById('result'), cases = [];
  const save = (name, body) => fetch(`/artifact/${name}`, { method: 'POST', body });
  try {
    const source = await (await fetch('/fixture.mp4')).blob(), reference = await inspectMedia(source);
    const originals = (await packets(source)).sort((a, b) => a.timestamp - b.timestamp);
    const keys = originals.filter(packet => packet.type === 'key');
    async function check(name, blob, start, end, expectedStrategy) {
      status.textContent = `正在验证 ${name}：${start}–${end} 秒`;
      const inputPackets = blob === source ? originals : (await packets(blob)).sort((a, b) => a.timestamp - b.timestamp);
      const expected = inputPackets.filter(packet => packet.timestamp < end && packet.timestamp + packet.duration > start);
      const events = [], before = performance.now();
      const output = await convertMp4(blob, { start, end, precise: true, onProgress: (progress, detail) => events.push({ progress, ...detail }) });
      const ms = performance.now() - before, info = await inspectMedia(output);
      await save(`smart-${name}.mp4`, output);
      const actual = (await packets(output)).sort((a, b) => a.timestamp - b.timestamp);
      const strategy = events.at(-1).strategy;
      const item = { name, start, end, ms, bytes: output.size, frames: actual.length, expectedFrames: expected.length, strategy,
        encodedFrames: events.at(-1).encodedFrames, copiedFrames: events.at(-1).copiedFrames, notices: events.filter(event => event.message), ...info };
      cases.push(item);
      if (expectedStrategy && strategy !== expectedStrategy) throw new Error(`${name} 未走预期路径：${strategy}`);
      if (!info.hasAudio || !info.hasVideo || info.width !== reference.width || info.height !== reference.height
        || Math.abs(info.duration - (end - start)) > .05) throw new Error(`音画或时长错误：${JSON.stringify(item)}`);
      if (actual.length !== expected.length || actual.some((packet, i) => Math.abs(packet.timestamp - Math.max(0, expected[i].timestamp - start)) > .001)) {
        throw new Error(`${name} 帧数或帧时间错误：${actual.length}/${expected.length}`);
      }
      const sourceAudio = await packets(blob, 'audio'), outputAudio = await packets(output, 'audio');
      const audioUnchanged = outputAudio.every(packet => {
        const original = sourceAudio.find(value => Math.abs(value.timestamp - start - packet.timestamp) < .00005);
        return original && original.data.length === packet.data.length && original.data.every((value, i) => value === packet.data[i]);
      });
      if (!audioUnchanged) throw new Error(`${name} 改变了 AAC 数据或音频时间位置`);
      item.audioUnchanged = true;
      if (strategy === 'smart') {
        const identical = actual.filter(packet => {
          const original = inputPackets.find(value => Math.abs(value.timestamp - start - packet.timestamp) < .00005);
          return original && original.data.length === packet.data.length && original.data.every((value, i) => value === packet.data[i]);
        }).length;
        if (identical < item.copiedFrames) throw new Error('拼接中间段未保持原始视频数据');
        item.identicalVideoPackets = identical;
      }
      await playback(output);
      item.played = true;
      return output;
    }
    await check('long', source, 1.25, Math.min(11.25, reference.duration), 'smart');
    if (!(cases.at(-1).copiedFrames > 0 && cases.at(-1).encodedFrames > 0)) throw new Error('原始素材未实际验证头尾编码与中段直拷');
    await check('fractional', source, 5.123, 8.754);
    await check('short', source, 1.123, 1.454, 'smart');
    if (keys.length >= 3) await check('keyframes', source, keys[1].timestamp, keys[2].timestamp, 'smart');
    const encodedSource = await check('spliced-source', source, 0, Math.min(12, reference.duration) - .123);
    await check('repeated', encodedSource, 1.25, Math.min(10.75, reference.duration), 'smart');
    if (!(cases.at(-1).copiedFrames > 0 && cases.at(-1).encodedFrames > 0)) throw new Error('二次剪辑素材未实际验证头尾编码与中段直拷');
    const controller = new AbortController();
    let canceled = false;
    try {
      await convertMp4(source, { start: 1.25, end: 11.25, precise: true, signal: controller.signal,
        onProgress: progress => { if (progress > 0) controller.abort(); } });
    } catch (error) { if (!controller.signal.aborted) throw error; canceled = true; }
    if (!canceled) throw new Error('取消后仍交付了文件');
    await check('retry', source, 2.123, 2.654);
    await save('smart-results.json', JSON.stringify({ passed: true, canceled, cases }, null, 2));
    status.textContent = '智能导出验证通过：完整音画、精确边界、独立参数集拼接、原生播放、取消与重试。\n' + JSON.stringify(cases, null, 2);
  } catch (error) {
    status.textContent = `智能导出验证失败：${error.message}`;
    await save('smart-results.json', JSON.stringify({ passed: false, cases, error: error.stack }, null, 2));
  }
}

export async function runStreamingExportChecks() {
  const status = document.getElementById('result'), events = [], started = [], finished = [];
  let active = 0, peak = 0, overlapped = false;
  try {
    status.textContent = '正在验证真实多分片下载与编码并行…';
    const { segments, duration } = await (await fetch('/stream-fixture/manifest.json')).json();
    const groups = [{ start: 100, streamEnd: 100 + duration, segments }];
    const api = { async request(url, { signal }) {
      active++; peak = Math.max(peak, active); started.push(url);
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        const response = await fetch(url, { signal }), data = await response.arrayBuffer();
        finished.push(url); return { data };
      } finally { active--; }
    } };
    const outputs = await exportSelection(api, { start: 100 }, groups, { start: 1.25, end: duration - .75 }, {
      precise: true, onProgress(event) {
        events.push({ ...event });
        if (event.processing > 0 && new Set(finished).size < segments.length) overlapped = true;
      },
    });
    const output = outputs[0].blob, info = await inspectMedia(output);
    await fetch('/artifact/stream-export.mp4', { method: 'POST', body: output });
    if (!info.hasAudio || !info.hasVideo || Math.abs(info.duration - (duration - 2)) > .05) throw new Error('分片导出音画或时间轴错误');
    if (!overlapped || peak > 2) throw new Error('下载与处理没有有界并行');
    if (!events.every((event, i) => !i || event.progress >= events[i - 1].progress)) throw new Error('并行进度倒退');
    if (events.slice(0, -1).some(event => event.progress === 1)) throw new Error('尚未封装完成就报告 100%');
    await playback(output);
    const result = { passed: true, overlapped, peak, started, finished, info, events };
    await fetch('/artifact/stream-results.json', { method: 'POST', body: JSON.stringify(result, null, 2) });
    status.textContent = '通过：真实 TS 分片的下载与精确编码并行、时间轴及声音完整、浏览器播放成功。';
  } catch (error) {
    status.textContent = '分片并行验证失败：' + error.message;
    await fetch('/artifact/stream-results.json', { method: 'POST', body: JSON.stringify({ passed: false, error: error.stack, peak, started, finished, events }, null, 2) });
  }
}
