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

export async function loadEmoteCatalog(room, {signal, fetcher = fetch} = {}) {
  const options = {signal, fetcher};
  const index = await readJson(publicUrl('index.json', 'emotes/'), options);
  return selectEmotes(await readJson(publicUrl(index.catalog, 'emotes/'), options), room);
}

export const referencedEmotes = events =>
  new Set(
    events.flatMap(event =>
      textTokens(event.text)
        .filter(token => /^\[.*\]$/u.test(token))
        .map(token => token.normalize('NFC')),
    ),
  );

// Lazy assets keep the animation clock exact, but decode only as far as the
// requested phase requires. All windows share the same decoded-byte budget.
export async function loadEmotes(
  events,
  room,
  fontSize,
  {signal, fetcher = fetch, selected, lazy = false, budget = {used: 0, compressed: 0}, metrics} = {},
) {
  const names = referencedEmotes(events);
  if (!names.size) return {assets: new Map(), close() {}};
  selected ??= await loadEmoteCatalog(room, {signal, fetcher});
  const required = [...names].filter(name => selected.has(name));
  const assets = new Map();
  const close = () => {
    for (const asset of assets.values()) asset.close();
    assets.clear();
  };
  try {
    if (required.length > 128) throw new Error('选区表情种类超过缓存上限，请缩短选区。');
    await mapConcurrent(
      required,
      3,
      async (name, _, taskSignal) => {
        const entry = selected.get(name);
        let decoder,
          retained = 0,
          closed = false,
          compressed = 0,
          frameCount = 0,
          initializing,
          fetching,
          fetched,
          prefetched = false;
        const controller = new AbortController();
        const cancelFetch = () => asset.close();
        const asset = {
          frames: [],
          ends: [],
          width: Math.ceil((entry.width * fontSize * 1.8) / 128),
          height: Math.ceil((entry.height * fontSize * 1.8) / 128),
          loops: Infinity,
          close() {
            if (closed) return;
            closed = true;
            controller.abort();
            signal?.removeEventListener('abort', cancelFetch);
            fetched = fetching = null;
            decoder?.close();
            decoder = null;
            for (const frame of asset.frames) frame.close();
            asset.frames.length = 0;
            budget.used -= retained;
            budget.compressed -= compressed;
            retained = compressed = 0;
          },
        };
        assets.set(name, asset);
        signal?.addEventListener('abort', cancelFetch, {once: true});
        async function fetchBytes() {
          const finish = metrics?.start('emoteFetch');
          try {
            const result = await boundedFetch(
              publicUrl(entry.file.split('/').map(encodeURIComponent).join('/'), 'emotes/'),
              {signal: controller.signal, fetcher, limit: 2 * 1024 * 1024},
            );
            controller.signal.throwIfAborted();
            if (lazy) {
              budget.makeRoom?.('compressed', result.bytes.byteLength);
              controller.signal.throwIfAborted();
              if (budget.compressed + result.bytes.byteLength > 16 * 1024 * 1024)
                throw new Error('弹幕表情压缩数据超过 16 MiB，请缩短选区。');
              compressed = result.bytes.byteLength;
              budget.compressed += compressed;
            }
            fetched = result;
            return result;
          } finally {
            finish?.();
          }
        }
        const getBytes = () => {
          if (closed) return Promise.reject(new Error('弹幕表情已释放。'));
          fetching ??= fetchBytes().catch(error => {
            fetching = null;
            throw error;
          });
          return fetching;
        };
        asset.prefetch = () => {
          if (closed || initializing || fetching) return fetching?.catch(() => {});
          prefetched = true;
          metrics?.add('emotePrefetches');
          return getBytes().catch(() => {});
        };
        async function initialize(readSignal) {
          const finish = metrics?.start('emoteLoad');
          let finishDecode;
          try {
            if (prefetched && fetched) metrics?.add('emotePrefetchHits');
            const {bytes, response} = await getBytes();
            readSignal?.throwIfAborted();
            if (closed) throw new Error('弹幕表情已释放。');
            if (typeof ImageDecoder === 'undefined')
              throw new Error('当前浏览器无法解码弹幕表情，请更新 Chrome / Edge。');
            finishDecode = metrics?.start('emoteDecode');
            decoder = new ImageDecoder({
              data: bytes,
              type: response.headers.get('content-type')?.split(';')[0] || 'image/webp',
            });
            await decoder.tracks.ready;
            readSignal?.throwIfAborted();
            const track = decoder.tracks.selectedTrack;
            if (!track || !track.frameCount || track.frameCount > 200 || asset.width * asset.height > 1024 * 1024)
              throw new Error('弹幕表情超过解码预算，请缩短选区。');
            asset.loops = track.repetitionCount === Infinity ? Infinity : track.repetitionCount + 1;
            frameCount = track.frameCount;
            metrics?.add('emoteLoads');
            fetched = fetching = null;
          } finally {
            finishDecode?.();
            finish?.();
          }
        }
        try {
          async function decodeNext(readSignal) {
            const finish = metrics?.start('emoteFrame');
            const finishDecode = metrics?.start('emoteDecode');
            try {
              readSignal?.throwIfAborted();
              if (closed) throw new Error('弹幕表情已释放。');
              const size = asset.width * asset.height * 4;
              budget.makeRoom?.('used', size);
              if (closed) throw new Error('弹幕表情已释放。');
              if (budget.used + size > 32 * 1024 * 1024) throw new Error('弹幕表情缓存超过 32 MiB，请缩短选区。');
              budget.used += size;
              retained += size;
              const {image} = await decoder.decode({frameIndex: asset.frames.length});
              try {
                if (image.displayWidth * image.displayHeight > 4 * 1024 * 1024) throw new Error('弹幕表情尺寸过大。');
                const bitmap = await createImageBitmap(image, {resizeWidth: asset.width, resizeHeight: asset.height});
                if (closed || readSignal?.aborted) {
                  bitmap.close();
                  readSignal?.throwIfAborted();
                  throw new Error('弹幕表情已释放。');
                }
                asset.frames.push(bitmap);
                metrics?.add('emoteFrames');
                asset.ends.push((asset.ends.at(-1) ?? 0) + Math.max(0.001, (image.duration ?? 100000) / 1e6));
              } finally {
                image.close();
              }
            } finally {
              finishDecode?.();
              finish?.();
            }
          }
          asset.needsPreparation = elapsed =>
            !initializing || (asset.frames.length < frameCount && (asset.ends.at(-1) ?? 0) <= Math.max(0, elapsed));
          asset.prepare = async (elapsed, readSignal = signal) => {
            const cancel = () => asset.close();
            readSignal?.throwIfAborted();
            readSignal?.addEventListener('abort', cancel, {once: true});
            try {
              initializing ??= initialize(readSignal);
              await initializing;
              while (asset.frames.length < frameCount && (asset.ends.at(-1) ?? 0) <= Math.max(0, elapsed))
                await decodeNext(readSignal);
              if (asset.frames.length === frameCount && decoder) {
                decoder.close();
                decoder = null;
                budget.compressed -= compressed;
                compressed = 0;
              }
            } catch (error) {
              asset.close();
              throw error;
            } finally {
              readSignal?.removeEventListener('abort', cancel);
            }
          };
          if (!lazy) {
            const cancel = () => asset.close();
            taskSignal.addEventListener('abort', cancel, {once: true});
            try {
              initializing = initialize(taskSignal);
              await initializing;
              while (asset.frames.length < frameCount) await decodeNext(taskSignal);
              decoder.close();
              decoder = null;
            } finally {
              taskSignal.removeEventListener('abort', cancel);
            }
          }
        } catch (error) {
          asset.close();
          throw error;
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
