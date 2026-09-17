import {RequestError} from './retry-request.js';

// Use the page's network context for credentialed video APIs. Extension-origin
// requests can receive HTTP 412 even while the same page request succeeds.
export function createSubmissionRequest(pageFetch) {
  return async (url, {signal} = {}) => {
    if (new URL(url).origin !== 'https://api.bilibili.com') throw new Error('视频账号请求只能发送至 B 站视频接口。');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => controller.abort(new RequestError('视频接口请求超时，请重试。', {retryable:true})), 45000);
    try {
      const response = await pageFetch(url, {credentials:'include', mode:'cors', redirect:'error', signal:controller.signal});
      if (!response.ok) {
        const status = response.status;
        const message = status === 412 ? 'B 站暂时限制了视频请求（HTTP 412），请稍后重新检查。' : `视频接口请求失败（HTTP ${status}），请重新检查。`;
        throw new RequestError(message, {status, retryable:status===408||status===429||status>=500&&status<=599});
      }
      return {data:await response.text()};
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
