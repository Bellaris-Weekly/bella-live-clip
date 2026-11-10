import {createClipUpload, createUploadTransport, pickLine} from './upload.js';
import {createSubmissionJob} from './submission.js';
import {submissionSchedule} from './templates.js';
import {createTemplateForm} from './template-form.js';
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
    <form><fieldset><div data-template-form></div>
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
    .studio-compose select {max-width:100%}.studio-compose pre {white-space:pre-wrap;overflow-wrap:anywhere}
    .studio-compose [data-error] {color:#d64c4c}.studio-compose button {margin:4px}`;
  root.append(style);
  const field = name => area.querySelector(`[data-${name}]`);
  const templateForm = createTemplateForm(field('template-form'));
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
          ? '正在确认投稿结果'
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
      field('cover').replaceChildren();
      field('selection').textContent =
        `${own.record.title} · ${Math.round(own.selection.end - own.selection.start)} 秒（${own.mode === 'copy' ? '原画' : own.mode === 'danmaku' ? '弹幕' : '精确'}）`;
      render(own);
      area.scrollIntoView({block: 'start'});
      try {
        const [defaults, me, options, templates, schedule] = await Promise.all([
          client.request('/clip-defaults', {signal}),
          client.request('/me', {signal}),
          client.request('/upload-options', {signal}),
          client.request('/templates', {signal}),
          submissionSchedule(own.record, schedules, signal),
        ]);
        signal.throwIfAborted();
        if (!defaults.account_mid) throw new Error('创作台尚未配置投稿账号，请联系管理员');
        templateForm.configure(templates, schedule, me.name, preserve && prior?.ready);
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
      const fields = {
        ...templateForm.fields(),
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
