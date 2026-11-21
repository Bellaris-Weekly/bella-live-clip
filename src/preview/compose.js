import {signal} from '@preact/signals';
import {createClipUpload, createUploadTransport, pickLine} from './upload.js';
import {createSubmissionJob} from './submission.js';
import {liveValue, sameLive, submissionSchedule} from './templates.js';
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

const SAME_LIVE_SLACK = 6 * 3600;
const beijingTime = seconds => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
// Include unsent records: filtering by BV alone silently redirects songs to an older archive. A live
// matched in the schedule is recognised by its {live}; otherwise only archives sent while it was
// recorded or soon after count, so a later live's collection is never offered for an older recording.
export function liveCollections(submissions, record, mid, live = '', user = '') {
  const end = (record.end || Date.now() / 1000) + SAME_LIVE_SLACK;
  return submissions
    .filter(
      item =>
        (item.bvid || item.id) &&
        item.account_mid === mid &&
        item.created_at >= record.start &&
        item.title.includes('』') &&
        item.details?.origin?.template_name &&
        (live && item.details.origin.live ? sameLive(item.details.origin.live, live) : item.created_at <= end),
    )
    .sort((a, b) => b.created_at - a.created_at)
    .map(item => ({
      id: item.id,
      bvid: item.bvid,
      status: item.status || (item.bvid ? 'submitted' : ''),
      submitAt: item.submit_at,
      owned: !user || item.created_by === user,
      mid: item.account_mid,
      title: item.title,
      template: item.details.origin.template_name,
    }));
}

const quiet = {begin: () => ({stage() {}, progress() {}, observe() {}, note() {}, finish() {}, fail() {}}), event() {}};

export function createComposer({
  root,
  client,
  gmRequest,
  mediaApi,
  storage,
  get,
  set,
  schedules,
  session,
  diagnostics = quiet,
  pageUrl = () => location.href,
}) {
  const view = signal({open: false, canStart: false});
  const host = id => root.getElementById(id);
  const templateForm = createTemplateForm(host('composeForm'));
  const transport = createUploadTransport(gmRequest);
  const cover = createCover({get, set});
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
  // Every step of a submission goes to the log: the lifecycle as one operation, errors as they happen.
  const describeOwn = own => ({pageUrl: pageUrl(), record: own.record, selection: own.selection, mode: own.mode});
  function track(own, state) {
    const seen = (own.seen ??= {});
    const failure = state?.error || own.setupError;
    const error = failure ? [failure.message, failure.detail].filter(Boolean).join('：') : '';
    if (error && error !== seen.error)
      diagnostics.event(
        'clip_submit_error',
        {
          ...describeOwn(own),
          level: 'warn',
          facts: {
            stage: state?.sent ? 'sent' : state?.uploaded ? 'uploaded' : own.stage,
            status: failure.status,
            path: failure.diagnostic?.path,
          },
        },
        error,
      );
    seen.error = error;
    for (const step of ['uploaded', 'confirmed', 'sent']) {
      if (!state?.[step] || seen[step]) continue;
      seen[step] = true;
      own.log.stage(step);
    }
    if (state?.done && !seen.done) {
      seen.done = true;
      own.log.note({bvid: state.result?.bvid, part: state.result?.part, parts: state.result?.parts});
      own.log.finish();
    } else if ((state?.cancelled || own.cancelled) && !seen.done) {
      seen.done = true;
      own.log.finish({status: 'canceled'});
    }
  }
  function render(own) {
    const state = own.job?.state();
    track(own, state);
    if (current !== own) return;
    if (!own.ready || own.closed || state?.confirmed || own.confirming) templateForm.closePopups();
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
      done: Boolean(state?.done),
      scheduled: state?.result?.status === 'scheduled',
      cancellable: !(state?.sent || state?.done || state?.cancelled),
      retry: Boolean((state?.error && !state.needsTarget) || own.setupError),
      retryBusy: Boolean(state?.busy || own.confirming),
      error: state?.error?.detail || state?.error?.message || own.setupError?.message || own.formError?.message || '',
      stage: state?.cancelled
        ? '已取消'
        : state?.done
          ? state.result?.part
            ? state.result.status === 'scheduled'
              ? `已加入待定时稿第 ${state.result.part} P · ${beijingTime(state.result.submit_at)} 投稿`
              : `已追加为第 ${state.result.part} P`
            : state.result?.status === 'scheduled'
              ? `已安排在 ${beijingTime(state.result.submit_at)} 投稿`
              : '投稿完成'
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
      own.log = diagnostics.begin('clip_submit', {
        ...describeOwn(own),
        facts: {segment: own.segmentIndex, mark: own.mark?.id, restart: Boolean(prior && preserve)},
      });
      own.log.stage('config');
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
        const [defaults, me, options, templates, schedule, submissions] = await Promise.all([
          client.request('/clip-defaults', {signal}),
          client.request('/me', {signal}),
          client.request('/upload-options', {signal}),
          client.request('/templates', {signal}),
          submissionSchedule(own.record, schedules, signal),
          client.request('/submissions', {signal}),
        ]);
        signal.throwIfAborted();
        if (!defaults.account_mid) throw new Error('创作台尚未配置投稿账号，请联系管理员');
        own.log.note({
          templates: templates.length,
          scheduleMatched: Boolean(schedule.matched),
          collections: submissions.length,
        });
        templateForm.configure(templates, schedule, me.name, preserve && prior?.ready, {
          existing: liveCollections(submissions, own.record, defaults.account_mid, liveValue(schedule.matched), me.sub),
          song: own.mark?.note?.trim() || '',
          recordStart: own.record.start,
          cosEnabled: options.cos_enabled,
        });
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
              own.log.stage('exporting');
              render(own);
              const metrics = createExportMetrics({observeLongTasks: true});
              own.log.observe(metrics);
              try {
                await ensureTemporarySpace(
                  storage,
                  own.estimate ? estimateSelectionBytes(own.estimate, own.record.start, own.selection) * 2 : 0,
                );
                const plan = new RecordingPlan(mediaApi, own.streams, signal);
                const groups = await plan.loadPart(own.segmentIndex, signal);
                temporary = await createTemporaryMedia({storage, signal});
                const {exportSelection, readExportDimensions} = await import('../media/export.js');
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
                    own.log.progress({...progress, phase: 'exporting'});
                    render(own);
                  }),
                });
                signal.throwIfAborted();
                const file = await temporary.handle.getFile();
                // A diagnostic read failure must not interrupt an otherwise valid upload.
                const dimensions = await readExportDimensions(file).catch(() => ({}));
                signal.throwIfAborted();
                own.file = file;
                own.export = 1;
                own.log.note({fileBytes: file.size, ...dimensions});
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
            own.log.stage('line');
            render(own);
            const line = await pickLine(me.lines || {}, transport, signal);
            own.log.note({line});
            own.log.stage('uploading');
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
                own.log.progress({progress: value, phase: 'uploading'});
                render(own);
              },
            });
          },
        });
        void own.job.start();
        signal.throwIfAborted();
        own.ready = true;
      } catch (error) {
        if (!signal.aborted) {
          own.setupError = error;
          own.log.fail(error);
        }
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
      const chosen = {
        target: fields.append ? 'append' : 'new',
        targetBvid: fields.append?.bvid,
        targetSubmissionId: fields.append?.submissionId,
        template: fields.origin?.template_name,
        title: fields.title,
        parts: fields.parts?.length,
      };
      own.log.note(chosen);
      diagnostics.event('clip_confirm', {...describeOwn(own), facts: chosen});
      own.confirming = true;
      render(own);
      if (fields.append) {
        void own.job.confirm(fields);
        return;
      }
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
      if (!own.job.signal.aborted) {
        own.formError = error;
        diagnostics.event(
          'clip_confirm_rejected',
          {...describeOwn(own), level: 'warn', facts: {status: error.status, path: error.diagnostic?.path}},
          [error.message, error.detail].filter(Boolean).join('：'),
        );
      }
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
  // The browser blocks a submit with an invalid field before our handler runs; record which one.
  const invalid = event => {
    const field = event.target?.attributes?.[0]?.name?.replace(/^data-/, '') || event.target?.tagName;
    diagnostics.event(
      'clip_confirm_blocked',
      {...(current ? describeOwn(current) : {pageUrl: pageUrl()}), level: 'warn', facts: {field}},
      event.target?.validationMessage || '表单校验未通过',
    );
  };
  root.addEventListener('invalid', invalid, true);
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
      templateForm.dispose();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('paste', paste);
      root.removeEventListener('invalid', invalid, true);
      this.logout();
    },
  };
}
