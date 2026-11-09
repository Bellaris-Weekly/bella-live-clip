// Ported from the studio UPOS/COS uploaders. Only slices of the OPFS File enter requests.
export function delay(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clean = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      clearTimeout(timer);
      clean();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      clean();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
}

export function createUploadTransport(gmRequest) {
  return {
    request({method, url, headers, body, signal}) {
      signal?.throwIfAborted();
      const target = new URL(url);
      if (target.protocol !== 'https:' || !target.hostname.endsWith('.bilivideo.com')) throw new Error('上传节点无效');
      return new Promise((resolve, reject) => {
        let handle,
          settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          callback(value);
        };
        const abort = () => {
          finish(reject, signal.reason);
          handle?.abort();
        };
        const fail = () => finish(reject, new Error('上传连接中断，请重试'));
        const timer = setTimeout(() => {
          fail();
          handle?.abort();
        }, 240000);
        signal?.addEventListener('abort', abort, {once: true});
        try {
          handle = gmRequest({
            method,
            url,
            headers,
            data: body,
            anonymous: true,
            timeout: 240000,
            onload: response => finish(resolve, {status: response.status, text: response.responseText}),
            onerror: fail,
            ontimeout: fail,
            onabort: fail,
          });
        } catch (error) {
          finish(reject, error);
        }
      });
    },
  };
}

const learned = /* @__PURE__ */ new Map();
// AIMD: start at six, grow after half a window of successes, halve on failure.
async function pool(count, channel, options, task) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let limit = options.concurrency || learned.get(channel) || 6,
    streak = 0,
    next = 0;
  const fixed = Boolean(options.concurrency);
  const adjust = success => {
    if (fixed) return;
    if (success && ++streak < Math.ceil(limit / 2)) return;
    limit = Math.max(2, Math.min(16, success ? limit + 1 : Math.floor(limit / 2)));
    streak = 0;
    learned.set(channel, limit);
  };
  const active = new Set();
  let failure;
  try {
    while (next < count || active.size) {
      signal.throwIfAborted();
      while (next < count && active.size < limit) {
        const index = next++;
        const work = (async () => {
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            try {
              await task(index, signal);
              adjust(true);
              return;
            } catch (error) {
              signal.throwIfAborted();
              adjust(false);
              if (attempt === 2) throw error;
              await (options.sleep || delay)((channel === 'upos' ? 2000 : 1000) * 2 ** attempt, signal);
            }
          }
        })()
          .catch(error => {
            failure ??= error;
            controller.abort(error);
          })
          .finally(() => active.delete(work));
        active.add(work);
      }
      await Promise.race(active);
      if (failure) throw failure;
    }
  } finally {
    controller.abort();
    await Promise.allSettled(active);
  }
}

export async function uploadFile(file, ticket, options) {
  const {transport, signal, onProgress = () => {}, onStage = () => {}} = options;
  signal?.throwIfAborted();
  const headers = {'X-Upos-Auth': ticket.auth};
  onStage('正在初始化上传');
  const init = await transport.request({method: 'POST', url: `${ticket.url}?uploads&output=json`, headers, signal});
  if (init.status !== 200) throw new Error(`初始化上传失败（${init.status}）`);
  const uploadId = JSON.parse(init.text).upload_id;
  if (!uploadId || !(ticket.chunk_size > 0)) throw new Error('上传凭证无效');
  const chunks = Math.ceil(file.size / ticket.chunk_size);
  let finished = 0;
  onStage('正在直传');
  await pool(chunks, 'upos', options, async (index, signal) => {
    const start = index * ticket.chunk_size,
      end = Math.min(start + ticket.chunk_size, file.size);
    const query = new URLSearchParams({
      uploadId,
      chunks,
      total: file.size,
      chunk: index,
      size: end - start,
      partNumber: index + 1,
      start,
      end,
    });
    const result = await transport.request({
      method: 'PUT',
      url: `${ticket.url}?${query}`,
      headers,
      body: file.slice(start, end),
      signal,
    });
    if (result.status !== 200) throw new Error(`分片 ${index + 1} 上传失败（${result.status}）`);
    onProgress(++finished / chunks);
  });
  signal?.throwIfAborted();
  onStage('正在合并上传分片');
  const query = new URLSearchParams({
    name: file.name,
    uploadId,
    biz_id: ticket.biz_id,
    output: 'json',
    profile: 'ugcupos/bup',
  });
  const complete = await transport.request({
    method: 'POST',
    url: `${ticket.url}?${query}`,
    headers: {...headers, 'Content-Type': 'application/json'},
    body: JSON.stringify({parts: Array.from({length: chunks}, (_, i) => ({partNumber: i + 1, eTag: 'etag'}))}),
    signal,
  });
  if (complete.status !== 200 || JSON.parse(complete.text).OK !== 1)
    throw new Error(`合并分片失败（${complete.status}）`);
}

export async function pickLine(lines, transport, signal) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await Promise.any(
      Object.entries(lines)
        .filter(([, host]) => host.endsWith('.bilivideo.com'))
        .map(async ([line, host]) => {
          const response = await transport.request({method: 'GET', url: `https://${host}/OK`, signal: combined});
          if (response.status !== 200) throw new Error('线路不可用');
          return line;
        }),
    );
  } catch {
    signal.throwIfAborted();
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export const VERIFICATION_MESSAGE = '上传触发安全验证，请前往 studio.bk0717.com 完成上传安全验证后重试';
export const needsVerification = error => error.code === 'rate_limited' || error.code === 'upload_verification';

// COS signed URLs use browser CORS, just as the studio does; never attach Bearer or cookies.
export async function putCosPart(url, blob, signal) {
  const response = await fetch(url, {
    method: 'PUT',
    body: blob,
    credentials: 'omit',
    headers: {'Content-Type': 'application/octet-stream'},
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  if (!response.ok) throw new Error(`上传分片失败（${response.status}）`);
}

export function createClipUpload({client, transport, put = putCosPart, sleep = delay}) {
  let direct,
    cos,
    directComplete = false;
  const post = (path, body, signal) => client.request(path, {method: 'POST', body, signal});
  return {
    async run(file, {mid, line, options, signal, onProgress, onStage}) {
      if (file.size <= 0 || file.size > options.max_file_bytes) throw new Error('文件为空或超过上传大小上限');
      const body = {account_mid: mid, file_name: file.name, size: file.size, line: line || 'bda2'};
      try {
        if (!cos && (direct || line)) {
          while (!direct) {
            signal.throwIfAborted();
            try {
              direct = await post('/uploads', body, signal);
            } catch (error) {
              if (error.status !== 429 || needsVerification(error)) throw error;
              onStage('上传排队中，稍后自动继续');
              await sleep((error.retryAfter ?? 60) * 1000, signal);
            }
          }
          if (!directComplete) {
            try {
              await uploadFile(file, direct, {transport, signal, onProgress, onStage, sleep});
              directComplete = true;
            } catch (error) {
              signal.throwIfAborted();
              if (!options.cos_enabled) throw error;
              await client.request(`/uploads/${direct.id}`, {method: 'DELETE', signal}).catch(() => {});
              direct = null;
              onStage('正在切换备用上传通道');
            }
          }
          if (directComplete) {
            await post(`/uploads/${direct.id}/complete`, undefined, signal);
            return direct.id;
          }
        }
        if (!options.cos_enabled) throw new Error('没有可用的上传通道');
        cos = cos ? await client.request(`/cos/uploads/${cos.id}`, {signal}) : await post('/cos/uploads', body, signal);
        if (cos.state === 'failed') cos = await post(`/cos/uploads/${cos.id}/retry`, undefined, signal);
        if (cos.state === 'uploading') {
          onStage('正在上传备用通道');
          const count = Math.ceil(file.size / cos.part_size);
          if (!(cos.part_size > 0)) throw new Error('上传凭证无效');
          let finished = 0;
          await pool(count, 'cos', {signal, sleep}, async (index, signal) => {
            const {url} = await client.request(`/cos/uploads/${cos.id}/parts/${index + 1}`, {signal});
            await put(url, file.slice(index * cos.part_size, (index + 1) * cos.part_size), signal);
            onProgress((++finished / count) * 0.8);
          });
          cos = await post(`/cos/uploads/${cos.id}/complete`, undefined, signal);
        } else if (cos.state === 'completing') cos = await post(`/cos/uploads/${cos.id}/complete`, undefined, signal);
        while (cos.state !== 'uploaded') {
          signal.throwIfAborted();
          if (cos.verification_required) throw new Error(VERIFICATION_MESSAGE);
          if (['failed', 'expired', 'cancelled'].includes(cos.state))
            throw new Error(cos.error_message || '上传已结束');
          onStage(cos.state === 'queued' ? '已接收，正在排队处理' : '已接收，服务器处理中');
          onProgress(0.8 + cos.progress * 0.2);
          await sleep(2000, signal);
          cos = await client.request(`/cos/uploads/${cos.id}`, {signal});
        }
        onProgress(1);
        return cos.id;
      } catch (error) {
        if (needsVerification(error)) throw new Error(VERIFICATION_MESSAGE, {cause: error});
        throw error;
      }
    },
    async cancel() {
      await Promise.allSettled([
        direct && client.request(`/uploads/${direct.id}`, {method: 'DELETE'}),
        cos && client.request(`/cos/uploads/${cos.id}`, {method: 'DELETE'}),
      ]);
    },
  };
}
