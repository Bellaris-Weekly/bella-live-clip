import {matchSchedule, scheduleMonths} from '../services/schedule.js';
import {delay} from './upload.js';

export function fillDescription(template, record, event, name) {
  const values = {
    stream_title: event?.title || record.title || '',
    stream_date: new Date(((event?.start ?? record.start) + 8 * 3600) * 1000).toISOString().slice(0, 10),
    name,
  };
  return (template || '').replace(/\{(stream_title|stream_date|name)\}/g, (_, key) => values[key]);
}

export async function descriptionFor(template, record, name, schedules, signal) {
  let event;
  try {
    const calendars = await Promise.all(
      scheduleMonths(record.start).map(month => schedules.calendar(month, {signal, refresh: false})),
    );
    event = matchSchedule(record, calendars.flat());
  } catch {
    signal.throwIfAborted();
  }
  return fillDescription(template, record, event, name);
}

export function submissionTags(fixed, added) {
  const tags = [...new Set([...fixed, ...added.split(/[,，\n]/)].map(tag => tag.trim()).filter(Boolean))];
  if (!tags.length || tags.length > 12 || tags.some(tag => [...tag].length > 20))
    throw new Error('请填写 1–12 个标签，每个标签最多 20 字（包含固定标签）');
  return tags;
}

// A request is frozen before its first send and retained after ambiguous network errors.
export function createSubmissionJob({
  client,
  defaults,
  upload,
  clean,
  changed = () => {},
  sleep = delay,
  uuid = () => crypto.randomUUID(),
}) {
  const controller = new AbortController(),
    {signal} = controller;
  const requestId = uuid(),
    collectionId = uuid();
  let fields,
    uploadId,
    request,
    result,
    running,
    transfer,
    cancelled = false,
    sent = false,
    done = false,
    error;
  const state = () => ({
    sent,
    cancelled,
    done,
    confirmed: Boolean(fields),
    uploaded: Boolean(uploadId),
    result,
    error,
    busy: Boolean(running),
    canCancel: !sent && !cancelled && !done,
  });
  const emit = () => changed(state());
  async function send(retry = false) {
    if (running || cancelled || done || !fields || !uploadId) return running;
    running = (async () => {
      error = null;
      request ??= {
        ...fields,
        request_id: requestId,
        account_mid: defaults.account_mid,
        tid: defaults.tid,
        copyright: 1,
        source: '',
        no_reprint: true,
        cover43_id: null,
        dtime: null,
        is_only_self: false,
        parts: [{upload_id: uploadId, title: fields.title}],
      };
      sent = true;
      emit();
      try {
        if (!result) result = await client.request('/submissions', {method: 'POST', body: request});
        else if (retry && result.status === 'failed')
          result = await client.request(`/submissions/${result.id}/retry`, {method: 'POST'});
        while (!result.bvid) {
          if (result.status === 'failed') throw new Error(result.error_message || '投稿失败');
          emit();
          await sleep(2000, signal);
          result = await client.request(`/submissions/${result.id}`, {signal});
        }
        // A collection error must not retain a large local file or hide a successful BV.
        await clean();
        if (defaults.season_id && defaults.section_id) {
          try {
            await client.request(
              `/accounts/${defaults.account_mid}/seasons/${defaults.season_id}/sections/${defaults.section_id}`,
              {method: 'POST', body: {request_id: collectionId, action: 'season_add', video_ids: [result.bvid]}},
            );
          } catch (failure) {
            throw new Error(`已投稿，加入合集未确认：${failure.message}。可重试或到创作台核对`);
          }
        }
        done = true;
      } catch (failure) {
        error = failure;
      }
    })();
    emit();
    try {
      await running;
    } finally {
      running = null;
      emit();
    }
  }
  return {
    signal,
    state,
    start() {
      if (transfer || cancelled || uploadId || sent) return transfer;
      error = null;
      transfer = (async () => {
        try {
          uploadId = await upload(signal);
          signal.throwIfAborted();
        } catch (failure) {
          if (!cancelled) error = failure;
        } finally {
          transfer = null;
          emit();
        }
        if (uploadId && !cancelled) await send();
      })();
      emit();
      return transfer;
    },
    confirm(value) {
      if (cancelled || sent) return;
      fields = structuredClone(value);
      emit();
      return send();
    },
    async retry() {
      if (sent) return send(true);
      return this.start();
    },
    async cancel() {
      if (sent || cancelled || done) return false;
      cancelled = true;
      controller.abort();
      emit();
      await transfer;
      await clean();
      return true;
    },
  };
}
