import {delay} from './upload.js';
import {assertResolved} from './templates.js';

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
  const requestId = uuid();
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
      if (fields.append) {
        // Appends are idempotent per request id; the studio reads the archive afresh, so others' songs are kept.
        const {mid, bvid} = fields.append;
        request ??= {request_id: requestId, upload_id: uploadId, title: fields.title};
        sent = true;
        emit();
        try {
          result = await client.request(`/accounts/${mid}/archives/${bvid}/append`, {method: 'POST', body: request});
          await clean();
          done = true;
        } catch (failure) {
          error = failure;
        }
        return;
      }
      const [main, ...rest] = fields.parts;
      request ??= {
        ...fields,
        request_id: requestId,
        account_mid: defaults.account_mid,
        parts: [{...main, upload_id: uploadId}, ...rest],
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
        await clean();
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
      if (!value.append) assertResolved(value.title, value.desc, ...(value.desc_v2 || []).map(row => row.raw_text));
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
