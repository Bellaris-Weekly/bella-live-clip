import {createClipUpload, createUploadTransport, pickLine} from './upload.js';
import {createSubmissionJob, descriptionFor, submissionTags} from './submission.js';
import {createCoverEditor} from './cover.js';
import {createTemporaryMedia, ensureTemporarySpace} from '../media/temporary-media.js';
import {createExportMetrics} from '../media/export-metrics.js';
import {RecordingPlan} from '../media/recording-plan.js';
import {estimateSelectionBytes} from '../media/recording-estimate.js';
import {readThumbnail} from '../media/thumbnails.js';
import {fileName} from '../media/file-name.js';
import {limitProgress} from '../ui/export-progress.js';
import {markTime} from './marks.js';

export function createComposer({root, client, gmRequest, mediaApi, mediaRequest, storage, schedules, session}) {
  const $ = id => root.getElementById(id);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '投稿';
  button.id = 'studioSubmit';
  button.className = 'button export-button';
  const actions = document.createElement('div');
  actions.className = 'studio-export-actions';
  $('download').before(actions);
  actions.append($('download'), button);
  const area = document.createElement('section');
  area.className = 'studio-compose';
  area.hidden = true;
  area.innerHTML = `<h3>投稿</h3><p data-selection></p><p data-mark></p>
    <form><fieldset><label>标题（最多 80 字）<input data-title required maxlength="80"></label>
    <div data-fixed></div><label>添加标签（逗号分隔，合计最多 12 个）<input data-tags></label>
    <label>简介<textarea data-desc maxlength="2000" rows="4"></textarea></label>
    <details open><summary>封面</summary><div data-cover></div></details></fieldset>
    <button data-confirm>确认投稿</button><button type="button" data-cancel>取消</button>
    <button type="button" data-retry hidden>重试</button></form>
    <p>导出 <progress data-export max="1" value="0"></progress> <span data-export-percent>0%</span>
    上传 <progress data-upload max="1" value="0"></progress> <span data-upload-percent>0%</span></p>
    <p data-state role="status"></p><p data-error role="alert"></p><p data-result></p>`;
  $('body').append(area);
  const style = document.createElement('style');
  style.textContent = `.studio-export-actions {display:flex;gap:8px}.studio-export-actions .export-button {flex:1;width:auto}
    .studio-compose {padding:12px;border-top:1px solid #8885}.studio-compose label {display:block;margin:8px 0}
    .studio-compose fieldset {border:0;padding:0;min-width:0}.studio-compose input:not([type]),.studio-compose textarea {width:100%;box-sizing:border-box}
    .studio-compose input[type=number] {width:70px}.studio-compose progress {width:80px}.studio-compose canvas {display:block}
    .studio-compose [data-fixed] span {display:inline-block;padding:3px 6px;margin:3px;background:#8883;border-radius:4px}
    .studio-compose [data-error] {color:#d64c4c}.studio-compose button {margin:4px}`;
  root.append(style);
  const field = name => area.querySelector(`[data-${name}]`);
  const transport = createUploadTransport(gmRequest);
  let current,
    selectedMark,
    switching = false,
    pendingMark = false;
  const active = () => current && !current.cancelled && !current.job?.state().done && !current.job?.state().cancelled;
  function markLabel() {
    const mark = current?.mark;
    field('mark').replaceChildren();
    if (!mark) return;
    field('mark').append(document.createTextNode(`关联轴：${markTime(mark.at)} ${mark.note || ''} `));
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.textContent = '解除关联';
    unlink.disabled = Boolean(current.job?.state().confirmed || current.job?.state().sent);
    unlink.onclick = () => {
      current.mark = null;
      markLabel();
    };
    field('mark').append(unlink);
  }
  function render(own) {
    if (current !== own) return;
    const state = own.job?.state();
    if (state?.done) own.cover?.dispose();
    area.querySelector('fieldset').disabled =
      !own.ready || Boolean(state?.confirmed || state?.sent || state?.cancelled || own.confirming);
    field('confirm').disabled =
      !own.ready || Boolean(state?.confirmed || state?.sent || state?.cancelled || own.confirming);
    field('confirm').textContent = state?.confirmed && !state.sent ? '已确认，等待上传完成' : '确认投稿';
    field('cancel').hidden = Boolean(state?.sent || state?.done || state?.cancelled);
    field('retry').hidden = !state?.error && !own.setupError;
    field('retry').disabled = Boolean(state?.busy || own.confirming);
    field('error').textContent = state?.error?.message || own.setupError?.message || own.formError?.message || '';
    field('state').textContent = state?.cancelled
      ? '已取消'
      : state?.done
        ? '投稿完成'
        : state?.sent
          ? state.result?.bvid
            ? '已投稿，正在加入合集'
            : '正在确认投稿结果'
          : state?.uploaded
            ? '上传完成，等待确认投稿'
            : own.stage;
    for (const kind of ['export', 'upload']) {
      field(kind).value = own[kind] || 0;
      field(`${kind}-percent`).textContent = `${Math.round((own[kind] || 0) * 100)}%`;
    }
    field('result').replaceChildren();
    if (state?.result?.bvid) {
      const bvid = state.result.bvid,
        link = document.createElement('a'),
        copy = document.createElement('button');
      link.href = `https://www.bilibili.com/video/${bvid}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = bvid;
      copy.type = 'button';
      copy.textContent = '复制 BV';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(bvid);
          copy.textContent = '已复制';
        } catch {
          own.formError = new Error('复制失败，请手动复制 BV 号');
          render(own);
        }
      };
      field('result').append(link, copy);
    }
    markLabel();
    refresh();
  }
  async function stop(own) {
    own.setup.abort();
    own.cover?.dispose();
    await own.job?.cancel();
    await own.uploader?.cancel();
    if (!own.job) own.cancelled = true;
    render(own);
  }
  async function start({preserve = false} = {}) {
    if (switching) return;
    if (!session.ready()) return;
    const prior = current;
    if (active() && !preserve) {
      area.hidden = false;
      area.scrollIntoView({block: 'nearest'});
      return;
    }
    switching = true;
    try {
      if (prior && preserve) {
        if (prior.job?.state().sent) return;
        await stop(prior);
      }
      prior?.cover?.dispose();
      const snapshot = session.snapshot();
      const own = (current = {
        ...snapshot,
        mark: selectedMark,
        setup: new AbortController(),
        stage: '正在读取投稿配置',
      });
      const {signal} = own.setup;
      area.hidden = false;
      if (!preserve) {
        field('title').value = '';
        field('tags').value = '';
        field('desc').value = '';
      }
      field('fixed').replaceChildren();
      field('cover').replaceChildren();
      field('selection').textContent =
        `${own.record.title} · ${Math.round(own.selection.end - own.selection.start)} 秒（${own.mode === 'copy' ? '原画' : own.mode === 'danmaku' ? '弹幕' : '精确'}）`;
      render(own);
      area.scrollIntoView({block: 'start'});
      try {
        const [defaults, me, options] = await Promise.all([
          client.request('/clip-defaults', {signal}),
          client.request('/me', {signal}),
          client.request('/upload-options', {signal}),
        ]);
        signal.throwIfAborted();
        if (!defaults.account_mid || !defaults.tid) throw new Error('创作台尚未配置投稿账号/分区，请联系管理员');
        own.defaults = defaults;
        for (const tag of defaults.fixed_tags) {
          const badge = document.createElement('span');
          badge.textContent = `${tag}（固定）`;
          field('fixed').append(badge);
        }
        own.uploader = createClipUpload({client, transport});
        let temporary;
        const clean = async () => {
          if (!temporary) return;
          await temporary.remove();
          temporary = null;
          own.file = null;
        };
        own.job = createSubmissionJob({
          client,
          defaults,
          clean,
          changed: () => render(own),
          upload: async signal => {
            if (!own.file) {
              // Snapshot gets its own plan/lifetime so changing or closing the editor cannot abort this job.
              await clean();
              own.stage = '正在导出';
              render(own);
              const metrics = createExportMetrics({observeLongTasks: true});
              try {
                await ensureTemporarySpace(
                  storage,
                  own.estimate ? estimateSelectionBytes(own.estimate, own.record.start, own.selection) * 2 : 0,
                );
                const plan = new RecordingPlan(mediaApi, own.streams, signal);
                const groups = (await plan.load(signal)).filter(group => group.streamIndex === own.segmentIndex);
                temporary = await createTemporaryMedia({storage, signal});
                const {exportSelection} = await import('../media/export.js');
                await exportSelection(mediaApi, own.record, groups, own.selection, {
                  signal,
                  precise: own.mode !== 'copy',
                  danmaku: own.mode === 'danmaku' ? {adjustment: 0} : null,
                  metrics,
                  createTemporary: options => createTemporaryMedia({...options, storage}),
                  maxFiles: 1,
                  createFile: async () => ({
                    handle: temporary.handle,
                    name: fileName(own.record, own.selection.start, own.selection.end),
                    remove: async () => {},
                  }),
                  onProgress: limitProgress(progress => {
                    own.export = progress.progress;
                    own.stage = progress.message || '正在导出';
                    render(own);
                  }),
                });
                signal.throwIfAborted();
                own.file = await temporary.handle.getFile();
                own.export = 1;
              } catch (error) {
                await clean();
                throw error;
              } finally {
                metrics.close();
              }
            }
            signal.throwIfAborted();
            own.stage = '正在选择上传线路';
            render(own);
            const line = await pickLine(me.lines || {}, transport, signal);
            return own.uploader.run(own.file, {
              mid: defaults.account_mid,
              line,
              options,
              signal,
              onStage(stage) {
                own.stage = stage;
                render(own);
              },
              onProgress(value) {
                own.upload = value;
                render(own);
              },
            });
          },
        });
        own.cover = createCoverEditor({
          host: field('cover'),
          selection: own.selection,
          signal: own.job.signal,
          readFrame(time, signal) {
            const stream = own.streams.find(
              part => time >= part.start_time - own.record.start && time < part.end_time - own.record.start,
            );
            if (!stream) throw new Error('该位置没有可用画面');
            return readThumbnail(mediaRequest, {stream, local: time - (stream.start_time - own.record.start)}, signal, {
              nativeSize: true,
            });
          },
        });
        void own.job.start();
        if (!preserve)
          field('desc').value = await descriptionFor(defaults.desc_template, own.record, me.name, schedules, signal);
        signal.throwIfAborted();
        own.ready = true;
      } catch (error) {
        if (!signal.aborted) own.setupError = error;
      }
      render(own);
    } finally {
      switching = false;
      refresh();
      if (pendingMark) {
        pendingMark = false;
        if (active() && !current.job?.state().sent) void start({preserve: true});
      }
    }
  }
  button.onclick = () => void start();
  area.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const own = current;
    if (!own?.ready || own.confirming || own.job.state().confirmed) return;
    own.formError = null;
    try {
      const title = field('title').value.trim();
      if (!title || [...title].length > 80) throw new Error('标题必填，最多 80 字');
      const fields = {
        title,
        tags: submissionTags(own.defaults.fixed_tags, field('tags').value),
        desc: field('desc').value,
        ...(own.mark ? {mark_id: own.mark.id} : {}),
      };
      own.confirming = true;
      render(own);
      const body = new FormData();
      body.append('file', await own.cover.file());
      const {id} = await client.request('/covers', {method: 'POST', body, signal: own.job.signal});
      own.job.signal.throwIfAborted();
      void own.job.confirm({...fields, cover_id: id});
    } catch (error) {
      if (!own.job.signal.aborted) own.formError = error;
    } finally {
      own.confirming = false;
      render(own);
    }
  };
  field('cancel').onclick = async () => {
    const own = current;
    if (own.job?.state().sent) return;
    field('cancel').disabled = true;
    try {
      await stop(own);
      area.hidden = true;
    } catch (error) {
      own.formError = error;
      render(own);
    } finally {
      field('cancel').disabled = false;
      refresh();
    }
  };
  field('retry').onclick = () => {
    if (current.setupError) void start({preserve: true});
    else void current.job.retry();
  };
  function refresh() {
    button.hidden = session.isSubmission() || session.whole();
    button.disabled = switching || !session.ready();
  }
  const beforeUnload = event => {
    if (active() && !current.cancelled) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return {
    refresh,
    markSelected(mark) {
      selectedMark = mark;
      if (switching) {
        pendingMark = true;
        return;
      }
      if (active() && !current.job?.state().sent) void start({preserve: true});
    },
    clearMark() {
      selectedMark = null;
    },
    logout() {
      if (current && !current.job?.state().sent) void stop(current).catch(() => {});
    },
    dispose() {
      window.removeEventListener('beforeunload', beforeUnload);
      this.logout();
      current?.cover?.dispose();
    },
  };
}
