export function parseSubmissionUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) return null;
  const part = Number(url.searchParams.get('p') ?? 1);
  if (!Number.isSafeInteger(part) || part < 1) return null;
  const id = match[1];
  return {...(id.startsWith('BV') ? {bvid:id} : {aid:id.slice(2)}), part, key:`${id}:${part}`};
}

export function submissionPart(metadata, route) {
  if (route.bvid && metadata.bvid !== route.bvid || route.aid && String(metadata.aid) !== route.aid) {
    throw new Error('视频信息与当前页面不一致，请重新加载。');
  }
  const page = metadata.pages?.find(item => item.page === route.part);
  if (!page) throw new Error('当前分 P 不存在，请切换到有效的视频分 P。');
  if (!Number.isSafeInteger(page.cid) || page.cid <= 0) throw new Error('视频没有返回有效的分 P 标识。');
  return page;
}

// Keep in sync with the media-domain @connect declarations in src/header.txt.
// The API can prefer peer CDN nodes on arbitrary domains/ports. Their ordinary
// CDN backups carry the same representation and work within existing permissions.
const MEDIA_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'acgvideo.com', 'hdslb.com'];

function allowedMedia(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.port ||
    !MEDIA_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
  // Preserve the complete signed path/query; only upgrade the transport protocol.
  return String(value).replace(/^http:/i, 'https:');
}

function descriptor(stream) {
  const candidates = [stream.baseUrl ?? stream.base_url ?? stream.url,
    ...(stream.backupUrl ?? stream.backup_url ?? [])];
  const urls = [...new Set(candidates.map(allowedMedia).filter(Boolean))];
  if (!urls.length) throw new Error('视频未返回受支持的 CDN 地址，请重新加载后重试。');
  return {url:urls[0], bandwidth:Number(stream.bandwidth) || 0, backupUrls:urls.slice(1)};
}

export function normalizeSubmission(metadata, route, play) {
  const page = submissionPart(metadata, route);
  if (play.is_preview) throw new Error('当前账号只能试看这个视频，无法导出完整选段。');
  let media, previewMedia, quality, previewQuality;
  if (play.dash) {
    const videos = (play.dash.video ?? []).filter(item => /^avc[13]\./i.test(item.codecs ?? ''));
    videos.sort((a,b) => Number(b.id)-Number(a.id) || Number(b.bandwidth)-Number(a.bandwidth));
    if (!videos.length) throw new Error('当前视频没有可用的 H.264 画面，请检查账号权限或换一个视频。');
    // An explicit empty audio list represents a silent source. Missing or incompatible
    // audio metadata must not turn an ordinary video into a successful silent export.
    if (!Array.isArray(play.dash.audio)) throw new Error('视频未返回完整的音轨信息，请重新加载。');
    const audios = play.dash.audio.filter(item => /^mp4a\.40\./i.test(item.codecs ?? ''));
    audios.sort((a,b) => Number(b.bandwidth)-Number(a.bandwidth));
    if (!audios.length && (play.dash.audio.length || play.dash.dolby?.audio?.length || play.dash.flac?.audio)) {
      throw new Error('当前视频没有兼容的 AAC 音轨，无法保留声音导出。');
    }
    media = {video:descriptor(videos[0]), audio:audios.length ? descriptor(audios[0]) : null, combined:false};
    previewMedia = {video:descriptor(videos.at(-1)), audio:audios.length ? descriptor(audios.at(-1)) : null, combined:false};
    quality = videos[0].id;
    previewQuality = videos.at(-1).id;
  } else {
    if (play.durl?.length !== 1 || !/^mp4/i.test(play.format ?? '')) {
      throw new Error('当前视频没有可用的 DASH 或单文件 MP4，请检查账号权限。');
    }
    media = {video:descriptor(play.durl[0]), audio:null, combined:true};
    previewMedia = media;
    quality = previewQuality = play.quality;
  }
  const duration = Number(play.timelength) / 1000 || Number(page.duration);
  if (!(duration > 0 && Number.isFinite(duration))) throw new Error('视频时长不可用，请重新加载。');
  const label = id => {
    const info = play.support_formats?.find(item => Number(item.quality) === Number(id));
    const index = play.accept_quality?.findIndex(item => Number(item) === Number(id)) ?? -1;
    return info?.new_description || info?.display_desc ||
      (index >= 0 && play.accept_description?.[index]) || `清晰度 ${id}`;
  };
  return {kind:'submission', key:`${metadata.bvid}:${page.cid}`, bvid:metadata.bvid, cid:page.cid,
    part:page.page, title:metadata.title, partTitle:metadata.pages.length > 1 ? page.part : '',
    uploader:metadata.owner?.name ?? '', duration,
    referer:`https://www.bilibili.com/video/${metadata.bvid}/?p=${page.page}`, qualityLabel:label(quality), previewQualityLabel:label(previewQuality), media, previewMedia};
}
