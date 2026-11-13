import {signal} from '@preact/signals';
import {createClipUpload, createUploadTransport, pickLine} from './upload.js';
import {createSubmissionJob} from './submission.js';
import {submissionSchedule} from './templates.js';
import {createTemplateForm} from './template-form.js';
import {createCover, isDark, readImage} from './cover.js';
import {createTemporaryMedia, ensureTemporarySpace} from '../media/temporary-media.js';
import {createExportMetrics} from '../media/export-metrics.js';
import {RecordingPlan} from '../media/recording-plan.js';
import {estimateSelectionBytes} from '../media/recording-estimate.js';
import {fileName} from '../media/file-name.js';
import {limitProgress} from '../ui/export-progress.js';
import {formatTimeRange} from '../shared/format.js';
import {isEditing} from '../ui/shortcuts.js';

export function createComposer({root, client, gmRequest, mediaApi, storage, schedules, session}) {
  const view = signal({open: false, canStart: false});
  const host = id => root.getElementById(id);
  const templateForm = createTemplateForm(host('composeForm'));
  const transport = createUploadTransport(gmRequest);
  const cover = createCover();
  let current,
    selectedMark,
    pickedFrame = null,
    switching = false;
  const active = () => current && !current.cancelled && !current.job?.state().done && !current.job?.state().cancelled;
  const MODES = {copy: '原画', precise: '精确', danmaku: '弹幕'};
  const seconds = selection => Math.round(selection.end - selection.start);
  const describe = snapshot =>
    `${formatTimeRange(snapshot.selection.start, snapshot.selection.end, '–')} · ${seconds(snapshot.selection)} 秒 · ${MODES[snapshot.mode]}`;
  // What the export depends on: a different one means the running export is of another clip.
  const clipKey = snapshot =>
    [
      snapshot.record.key,
      snapshot.segmentIndex,
      snapshot.selection.start.toFixed(3),
      snapshot.selection.end.toFixed(3),
      snapshot.mode,
      snapshot.mark?.id,
    ].join('|');
  // Everything the page shows, derived from the current submission and its job.
  function render(own) {
    if (current !== own) return;
    const state = own.job?.state();
    view.value = {
      open: !own.closed,
      canStart: canStart(),
      title: own.record.title,
      selection: describe(own),
      stale: own.stale && !state?.sent ? describe(own.stale) : '',
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
      progress: state?.uploaded
        ? '待确认'
        : own.upload
          ? `上传 ${Math.round(own.upload * 100)}%`
          : own.export
            ? `导出 ${Math.round(own.export * 100)}%`
            : '准备中',
      preview: own.preview || null,
      bvid: state?.result?.bvid || null,
      copied: Boolean(own.copied),
    };
  }
  async function stop(own) {
    own.setup.abort();
    await own.job?.cancel();
    await own.uploader?.cancel();
    if (!own.job) own.cancelled = true;
    render(own);
  }
  // The frame picked in the editor, or else the one under the playhead (inside the clip).
  async function captureDefault(own) {
    try {
      const frame = await session.captureFrame(own.selection);
      if (current === own && !cover.state.value.frame) setFrame(frame);
    } catch (error) {
      if (current === own && !cover.state.value.frame)
        cover.notice.value = `没能截取封面画面（${error.message}）。可以回到剪辑设为封面，或上传图片。`;
    }
  }
  function setFrame(frame) {
    pickedFrame = {...frame, dark: isDark(frame.image)};
    cover.setFrame(pickedFrame);
  }
  async function start({preserve = false} = {}) {
    if (switching) return;
    if (!session.ready()) return;
    const prior = current;
    if (active() && !preserve) {
      session.pause();
      const next = {...session.snapshot(), mark: selectedMark};
      const key = clipKey(next);
      current.stale = key === clipKey(current) || key === current.kept ? null : next;
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
      session.pause();
      const snapshot = session.snapshot();
      const own = (current = {
        ...snapshot,
        mark: selectedMark,
        setup: new AbortController(),
        stage: '正在读取投稿配置',
      });
      const {signal} = own.setup;
      // A restart keeps the cover being made; a new submission keeps only a frame picked for this clip.
      if (!preserve) {
        const kept =
          pickedFrame?.key === own.record.key &&
          pickedFrame.time >= own.selection.start &&
          pickedFrame.time <= own.selection.end;
        cover.reset(kept ? pickedFrame : null);
      }
      if (!cover.state.value.frame) void captureDefault(own);
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
          if (own.preview) URL.revokeObjectURL(own.preview);
          own.preview = null;
          if (!temporary) return;
          await temporary.remove();
          temporary = null;
          own.file = null;
          render(own);
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
                const groups = await plan.loadPart(own.segmentIndex, signal);
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
                // The finished clip, playable on the page before it is sent.
                own.preview = URL.createObjectURL(own.file);
                render(own);
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
      const files = await cover.files();
      const send = async file => {
        const body = new FormData();
        body.append('file', file);
        return (await client.request('/covers', {method: 'POST', body, signal: own.job.signal})).id;
      };
      const [wide, tall] = await Promise.all([send(files.wide), send(files.tall)]);
      own.job.signal.throwIfAborted();
      void own.job.confirm({...fields, cover_id: wide, cover43_id: tall});
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
  // A pasted image becomes the cover being edited, unless it is going into a text field.
  const paste = async event => {
    if (!view.value.open || view.value.locked || isEditing(event)) return;
    const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    try {
      cover.setImage(cover.active.value, await readImage(file));
    } catch (error) {
      cover.notice.value = error.message;
    }
  };
  window.addEventListener('paste', paste);
  return {
    view,
    cover,
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
      // The editor changed since this export began: export the new clip, or keep the old one.
      restart: () => void start({preserve: true}),
      keep() {
        if (!current?.stale) return;
        current.kept = clipKey(current.stale);
        current.stale = null;
        render(current);
      },
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
    setFrame,
    markSelected(mark) {
      selectedMark = mark;
    },
    clearMark() {
      selectedMark = null;
    },
    logout() {
      if (current && !current.job?.state().sent) void stop(current).catch(() => {});
    },
    dispose() {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('paste', paste);
      this.logout();
    },
  };
}
