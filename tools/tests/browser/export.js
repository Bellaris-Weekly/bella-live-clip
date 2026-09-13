import { Input, BlobSource, MP4, Output, BufferTarget, Mp4OutputFormat, Conversion, QUALITY_HIGH, EncodedPacketSink } from 'mediabunny';
import { convertMp4 } from '../../../src/media/export.js';
import { inspectMedia } from '../support/media-info.mjs';

async function videoFrames(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const frames = [];
    const sink = new EncodedPacketSink(await input.getPrimaryVideoTrack());
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      frames.push({ timestamp: packet.timestamp, duration: packet.duration });
    }
    return frames.sort((a, b) => a.timestamp - b.timestamp);
  } finally { input.dispose(); }
}

// Keep the old settings here as a benchmark, never as a product fallback.
async function baseline(blob, start, end) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  try {
    const conversion = await Conversion.init({ input, output, copy: false, trim: { start, end },
      video: { codec: 'avc', bitrate: QUALITY_HIGH }, audio: { codec: 'aac', bitrate: 192000 } });
    await conversion.execute();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    input.dispose();
  }
}

export async function runExportChecks() {
  const status = document.getElementById('result');
  const cases = [];
  const save = (name, body) => fetch(`/artifact/${name}`, { method: 'POST', body });
  try {
    status.textContent = '正在准备精确导出对比…';
    const blob = await convertMp4(await (await fetch('/fixture.mp4')).blob());
    await save('precise-reference.mp4', blob);
    const reference = await inspectMedia(blob);
    const frames = await videoFrames(blob);
    for (const [start, end] of [[1.25, 11.25], [5.123, 8.754]]) {
      const expected = frames.filter(frame => frame.timestamp < end && frame.timestamp + frame.duration > start);
      for (const mode of ['baseline', 'precise']) {
        status.textContent = `正在验证 ${mode}：${start}–${end} 秒`;
        const before = performance.now();
        const output = mode === 'baseline' ? await baseline(blob, start, end)
          : await convertMp4(blob, { start, end, precise: true });
        const ms = performance.now() - before;
        const info = await inspectMedia(output);
        if (!info.hasAudio || !info.hasVideo || info.width !== reference.width || info.height !== reference.height
          || Math.abs(info.duration - (end - start)) > 0.1) throw new Error(`导出内容错误：${JSON.stringify(info)}`);
        const actual = await videoFrames(output);
        if (actual.length !== expected.length || actual.some((frame, i) =>
          Math.abs(frame.timestamp - Math.max(0, expected[i].timestamp - start)) > 0.001)) {
          throw new Error('导出丢帧或改变了原始帧时间');
        }
        cases.push({ mode, start, end, ms, bytes: output.size, frames: actual.length, ...info });
        await save(`${mode}-${start}-benchmark.mp4`, output);
      }
    }
    const controller = new AbortController();
    let canceled = false;
    try {
      await convertMp4(blob, { start: 1, end: 20, precise: true, signal: controller.signal,
        onProgress: progress => { if (progress > 0) controller.abort(); } });
    } catch (error) { if (!controller.signal.aborted) throw error; canceled = true; }
    if (!canceled) throw new Error('取消后仍然交付了文件');
    // A canceled encoder must release resources so the next export can complete.
    const retry = await convertMp4(blob, { start: 2.1, end: 2.6, precise: true });
    if (!(await inspectMedia(retry)).hasVideo) throw new Error('取消后无法重新导出');
    await save('precise-benchmark.json', JSON.stringify({ passed: true, canceled, cases }, null, 2));
    status.textContent = '精确导出对比通过：两组切点、完整音画、取消与重试。\n' + JSON.stringify(cases, null, 2);
  } catch (error) {
    status.textContent = `精确导出对比失败：${error.message}`;
    await save('precise-benchmark.json', JSON.stringify({ passed: false, cases, error: error.stack }, null, 2));
  }
}
