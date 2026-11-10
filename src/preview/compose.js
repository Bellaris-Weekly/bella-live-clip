import {signal} from '@preact/signals';
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

export function createComposer({root, client, gmRequest, mediaApi, mediaRequest, storage, schedules, session}) {
  const view = signal({open: false, canStart: false});
  const host = id => root.getElementById(id);
  const templateForm = createTemplateForm(host('composeForm'));
  const transport = createUploadTransport(gmRequest);
  let current,
    selectedMark,
    switching = false,
    pendingMark = false;
  const active = () => current && !current.cancelled && !current.job?.state().done && !current.job?.state().cancelled;
  const MODES = {copy: '原画', precise: '精确', danmaku: '弹幕'};
  // Everything the sheet shows, derived from the current submission and its job.
  function render(own) {
    if (current !== own) return;
    const state = own.job?.state();
    if (state?.done) own.cover?.dispose();
    view.value = {
      open: !own.closed,
      canStart: canStart(),
      selection: `${own.record.title} · ${Math.round(own.selection.end - own.selection.start)} 秒 · ${MODES[own.mode]}`,
      mark: own.mark,
      markLocked: Boolean(state?.confirmed || state?.sent),
      locked: !own.ready || Boolean(state?.confirmed || state?.sent || state?.cancelled || own.confirming),
      confirmText: state?.confirmed && !state.sent ? '已确认，等待上传完成' : '确认投稿',
      cancellable: !(state?.sent || state?.done || state?.cancelled),
      retry: Boolean(state?.error || own.setupError),
      retryBusy: Boolean(state?.busy || own.confirming),
      error: state?.error?.message || own.setupError?.message || own.formError?.message || '',
      stage: state?.cancelled
        ? '已取消'
        : state?.done
          ? '投稿完成'
          : state?.sent
            ? '正在确认投稿结果'
            : state?.uploaded
              ? '上传完成，等待确认投稿'
              : own.stage,
      export: own.export || 0,
      upload: own.upload || 0,
      bvid: state?.result?.bvid || null,
      copied: Boolean(own.copied),
    };
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
      current.closed = false;
      render(current);
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
      host('composeCover').replaceChildren();
      render(own);
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
          host: host('composeCover'),
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
  async function confirm() {
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
  }
  async function cancel() {
    const own = current;
    if (!own || own.job?.state().sent || own.stopping) return;
    own.stopping = true;
    try {
      await stop(own);
      own.closed = true;
    } catch (error) {
      own.formError = error;
    } finally {
      own.stopping = false;
      render(own);
      refresh();
    }
  }
  const canStart = () => !switching && session.ready() && !session.isSubmission() && !session.whole();
  // The sheet stays mounted; only the start button depends on the editor.
  function refresh() {
    if (current) render(current);
    else view.value = {...view.value, canStart: canStart()};
  }
  const beforeUnload = event => {
    if (active() && !current.cancelled) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return {
    view,
    actions: {
      start: () => void start(),
      confirm: () => void confirm(),
      cancel: () => void cancel(),
      // Hiding keeps a running export or upload going; the dock button reopens it.
      close() {
        if (!current) return;
        current.closed = true;
        render(current);
      },
      retry: () => (current.setupError ? void start({preserve: true}) : void current.job.retry()),
      unlinkMark() {
        if (!current || view.value.markLocked) return;
        current.mark = null;
        render(current);
      },
      async copyBv() {
        const own = current;
        try {
          await navigator.clipboard.writeText(view.value.bvid);
          own.copied = true;
        } catch {
          own.formError = new Error('复制失败，请手动复制 BV 号');
        }
        render(own);
      },
    },
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
