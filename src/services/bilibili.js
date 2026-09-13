import { recordFromReplay, recordFromRoom, roomFromHtml } from '../domain/records.js';

const API = 'https://api.live.bilibili.com';

export function createRequest(gmRequest) {
  return (url, { auth = false, type = 'text', range = null, signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (auth && new URL(url).origin !== API) { reject(new Error('账号请求只能发送至 B 站直播接口。')); return; }
    let request;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => { fail(signal.reason); request?.abort(); };
    // anonymous requests use fetch in Tampermonkey, which ignores its native timeout option.
    const timer = setTimeout(() => { fail(new Error('请求超时，请重试。')); request?.abort(); }, 45000);
    signal?.addEventListener('abort', abort, { once: true });
    const headers = { Referer: 'https://live.bilibili.com/' };
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    try {
      request = gmRequest({
        method: 'GET', url, headers, anonymous: !auth, responseType: type,
        onload(response) {
          cleanup();
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`请求失败（HTTP ${response.status}），请刷新场次后重试。`)); return;
          }
          if (range && response.status !== 206) {
            reject(new Error('视频服务器未按分片范围返回内容，已停止处理。')); return;
          }
          resolve({ data: type === 'text' ? response.responseText : response.response,
            url: response.finalUrl || url, headers: response.responseHeaders });
        },
        onerror: () => fail(new Error('网络请求失败，请检查网络和油猴的站点访问权限。')),
        onabort: () => fail(signal?.reason || new DOMException('已取消', 'AbortError')),
        ontimeout: () => fail(new Error('请求超时，请重试。')),
      });
    } catch (error) { fail(error); }
  });
}

export class BiliApi {
  constructor(request) { this.request = request; }

  async get(path, params, signal) {
    const { data: text } = await this.request(`${API}${path}?${new URLSearchParams(params)}`, { auth: true, signal });
    let response;
    try { response = JSON.parse(text); } catch { throw new Error('B 站没有返回接口数据，请刷新页面后重试。'); }
    if (response.code !== 0) {
      const messages = { '-101': '请先在这个浏览器中登录 B 站，再点击刷新。',
        '301': '当前账号没有该主播的回放剪辑权限。',
        '202': '这个场次已失效或暂时无法剪辑，请换一场重试。',
        '-352': 'B 站暂时限制了请求，请稍后再试。', '-412': 'B 站暂时限制了请求，请稍后再试。' };
      throw new Error(messages[response.code] || `B 站返回 ${response.code}：${response.message || '请求未成功'}`);
    }
    return response.data;
  }

  async history(member, signal) {
    const records = [];
    let page = 1, total;
    do {
      const data = await this.get('/xlive/web-room/v1/videoService/GetOtherSliceList',
        { live_uid: member.uid, time_range: 3, page, page_size: 30 }, signal);
      const items = data.replay_info || [];
      records.push(...items.map(item => recordFromReplay(item, member)));
      total = data.pagination.total;
      if (!items.length) break;
      page++;
    } while (records.length < total);
    return [...new Map(records.map(record => [record.key, record])).values()].sort((a,b)=>b.start-a.start);
  }

  async current(member, signal) {
    const { data } = await this.request(`https://live.bilibili.com/${member.room}`, { signal });
    return recordFromRoom(roomFromHtml(data), member);
  }

  async clips(record, start, end, signal) {
    const data = await this.get('/xlive/web-room/v1/videoService/GetUserSliceStream', {
      live_uid: record.uid, live_key: record.key,
      start_time: Math.floor(record.start + start), end_time: Math.ceil(record.start + end),
    }, signal);
    const list = data.list || [];
    if (!list.length) throw new Error('B 站暂未返回这段录像，请刷新场次重试；最新片段可能还在生成。');
    return [...list].sort((a, b) => a.start_time - b.start_time);
  }
}
