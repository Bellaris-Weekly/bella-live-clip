import {mapConcurrent} from '../shared/concurrent.js';
import {boundedFetch, publicUrl, readJson} from './archive.js';

export function selectEmotes(catalog, room) {
  const selected = new Map(),
    ranks = new Map();
  for (const entry of catalog.emotes ?? []) {
    const rank =
      entry.kind === 'room'
        ? entry.file.startsWith(`room/${room}/`)
          ? 3
          : 0
        : entry.kind === 'official'
          ? 2
          : ['emoji', 'library', 'upower'].includes(entry.kind)
            ? 1
            : 0;
    const name = `[${entry.name.replace(/^\[|\]$/g, '').normalize('NFC')}]`;
    if (rank > (ranks.get(name) ?? 0)) {
      selected.set(name, entry);
      ranks.set(name, rank);
    }
  }
  return selected;
}

export const textTokens = text =>
  String(text)
    .split(/(\[[^[\]]+\])/u)
    .filter(Boolean);

// Cache belongs to one export and is closed in its finally block. Decode only
// referenced stickers, with explicit limits on both compressed and raster data.
export async function loadEmotes(events, room, fontSize, {signal, fetcher = fetch} = {}) {
  if (!events.some(event => /\[[^\]]+\]/u.test(event.text))) return {assets: new Map(), close() {}};
  const options = {signal, fetcher};
  const index = await readJson(publicUrl('index.json', 'emotes/'), options);
  const catalog = await readJson(publicUrl(index.catalog, 'emotes/'), options);
  const selected = selectEmotes(catalog, room);
  const names = new Set(
    events
      .flatMap(event => textTokens(event.text).map(token => token.normalize('NFC')))
      .filter(name => selected.has(name)),
  );
  const assets = new Map();
  let used = 0;
  const close = () => {
    for (const asset of assets.values()) for (const frame of asset.frames) frame.close();
    assets.clear();
  };
  try {
    if (names.size > 128) throw new Error('选区表情种类超过缓存上限，请缩短选区。');
    await mapConcurrent(
      [...names],
      3,
      async (name, _, signal) => {
        signal?.throwIfAborted();
        const entry = selected.get(name);
        const {bytes, response} = await boundedFetch(
          publicUrl(entry.file.split('/').map(encodeURIComponent).join('/'), 'emotes/'),
          {
            ...options,
            signal,
            limit: 2 * 1024 * 1024,
          },
        );
        if (typeof ImageDecoder === 'undefined') throw new Error('当前浏览器无法解码弹幕表情，请更新 Chrome / Edge。');
        const decoder = new ImageDecoder({
          data: bytes,
          type: response.headers.get('content-type')?.split(';')[0] || 'image/webp',
        });
        const asset = {
          frames: [],
          ends: [],
          width: Math.ceil((entry.width * fontSize * 1.8) / 128),
          height: Math.ceil((entry.height * fontSize * 1.8) / 128),
          loops: Infinity,
        };
        assets.set(name, asset);
        try {
          await decoder.tracks.ready;
          const track = decoder.tracks.selectedTrack;
          if (!track || track.frameCount > 200 || asset.width * asset.height > 1024 * 1024)
            throw new Error('弹幕表情超过解码预算，请缩短选区。');
          asset.loops = track.repetitionCount === Infinity ? Infinity : track.repetitionCount + 1;
          for (let i = 0; i < track.frameCount; i++) {
            signal?.throwIfAborted();
            used += asset.width * asset.height * 4;
            if (used > 32 * 1024 * 1024) throw new Error('弹幕表情缓存超过 32 MiB，请缩短选区。');
            const {image} = await decoder.decode({frameIndex: i});
            try {
              if (image.displayWidth * image.displayHeight > 4 * 1024 * 1024) throw new Error('弹幕表情尺寸过大。');
              asset.frames.push(await createImageBitmap(image, {resizeWidth: asset.width, resizeHeight: asset.height}));
              signal.throwIfAborted();
              asset.ends.push((asset.ends.at(-1) ?? 0) + Math.max(0.001, (image.duration ?? 100000) / 1e6));
            } finally {
              image.close();
            }
          }
        } finally {
          decoder.close();
        }
      },
      signal,
    );
    return {assets, close};
  } catch (error) {
    close();
    throw error;
  }
}

export function emoteFrame(asset, elapsed) {
  const total = asset.ends.at(-1);
  if (elapsed >= total * asset.loops) return asset.frames.at(-1);
  const phase = Math.max(0, elapsed) % total;
  return asset.frames[asset.ends.findIndex(end => end > phase)] ?? asset.frames.at(-1);
}
