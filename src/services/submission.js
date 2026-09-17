import {normalizeSubmission, parseSubmissionUrl, submissionPart} from '../domain/submission.js';
import {requestWithRetry} from './retry-request.js';

const API = 'https://api.bilibili.com';
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];

// MD5's 64 rounds and little-endian padding (RFC 1321). Only used for the
// platform's WBI request checksum, never for storing passwords or credentials.
export function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const buffer = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  buffer.set(bytes); buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, bytes.length * 8, true);
  view.setUint32(buffer.length - 4, Math.floor(bytes.length / 0x20000000), true);
  const state = [0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  const shifts = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
  for (let offset = 0; offset < buffer.length; offset += 64) {
    let [a,b,c,d] = state;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const index = round === 0 ? i : round === 1 ? (5*i+1)%16 : round === 2 ? (3*i+5)%16 : (7*i)%16;
      const sum = (a + f + Math.floor(Math.abs(Math.sin(i+1))*0x100000000) + view.getUint32(offset+index*4,true)) | 0;
      const shift = shifts[round][i%4];
      [a,b,c,d] = [d,(b + ((sum << shift) | (sum >>> (32-shift)))) | 0,b,c];
    }
    [a,b,c,d].forEach((value,i) => {state[i] = (state[i]+value) | 0;});
  }
  return state.map(word => [0,8,16,24].map(shift => ((word >>> shift)&255).toString(16).padStart(2,'0')).join('')).join('');
}

export function signWbi(params, images, now = Date.now()) {
  if (!images?.img_url || !images?.sub_url) throw new Error('B 站签名参数不可用，请刷新后重试。');
  const lookup = [images.img_url,images.sub_url].map(value => new URL(value).pathname.split('/').at(-1).split('.')[0]).join('');
  if (lookup.length !== 64) throw new Error('B 站签名参数不可用，请刷新后重试。');
  const key = MIXIN.map(index => lookup[index]).join('');
  const entries = Object.entries({...params,wts:Math.floor(now/1000)}).sort(([a],[b])=>a.localeCompare(b));
  const query = new URLSearchParams(entries.map(([name,value])=>[name,String(value).replace(/[!'()*]/g,'')]));
  query.set('w_rid',md5(query.toString()+key));
  return query;
}

export function createSubmissionService(request) {
  async function get(path, params, options, allowGuestKeys = false) {
    const {data:text} = await requestWithRetry({request}, `${API}${path}?${params}`, options, {onRetry:options.onRetry});
    options.signal?.throwIfAborted();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('B 站未返回视频接口数据，请刷新页面后重试。'); }
    if (allowGuestKeys && result.data?.wbi_img) return result.data;
    if (result.code !== 0) {
      const messages = {'-101':'请先登录 B 站后重新加载视频。','-404':'这个视频不存在或已被删除。',
        '-403':'当前账号没有这个视频的播放权限。','-10403':'当前账号没有这个视频的播放权限。',
        '-352':'B 站暂时限制了请求，请稍后再试。','-412':'B 站暂时限制了请求，请稍后再试。'};
      throw new Error(messages[result.code] || `视频接口返回 ${result.code}：${result.message || '请求未成功'}`);
    }
    if (!result.data) throw new Error('视频接口未返回内容，请重新加载。');
    return result.data;
  }
  return {async load(url, {signal,onRetry} = {}) {
    const route = parseSubmissionUrl(url);
    if (!route) throw new Error('请在 B 站普通投稿视频页面打开当前视频。');
    const identity = route.bvid ? {bvid:route.bvid} : {aid:route.aid};
    const referer = `https://www.bilibili.com/video/${route.bvid ?? `av${route.aid}`}/?p=${route.part}`;
    const options = {auth:true,signal,referer,onRetry};
    const metadata = await get('/x/web-interface/view',new URLSearchParams(identity),options);
    const page = submissionPart(metadata,route);
    const nav = await get('/x/web-interface/nav',new URLSearchParams(),options,true);
    const params = signWbi({bvid:metadata.bvid,cid:page.cid,qn:127,fnval:4048,fnver:0,fourk:1},nav.wbi_img);
    const play = await get('/x/player/wbi/playurl',params,options);
    return normalizeSubmission(metadata,route,play);
  }};
}
