// The wire schema deliberately accepts numeric aggregates only, never resource
// URLs, comment text, filenames, headers, encoded data or arbitrary objects.
const stages = new Set([
  'pickerWait',
  'originProbe',
  'planExtend',
  'commentWindowInitial',
  'compositorInit',
  'emoteFetch',
  'emoteDecode',
  'emoteStall',
  'archiveSetup',
  'archiveOpen',
  'archiveRead',
  'emoteCatalog',
  'emoteLoad',
  'emoteFrame',
  'playlistLoad',
  'mediaIndex',
  'fileOpen',
  'mediaRequest',
  'mediaPrepare',
  'streamWriteWait',
  'streamReady',
  'sampleWait',
  'danmakuPrepare',
  'render',
  'layout',
  'overlayDraw',
  'videoDraw',
  'overlayComposite',
  'frameSnapshot',
  'encoderSetup',
  'encodeSubmit',
  'encoderFlush',
  'muxAdd',
  'fileWrite',
  'fileClose',
  'outputFinalize',
]);
const counters = new Set([
  'mediaRequestBytes',
  'emotePrefetches',
  'emotePrefetchHits',
  'emoteFailures',
  'longTaskMs',
  'longTasks',
  'videoFrames',
  'encodedPackets',
  'encodedBytes',
  'writtenBytes',
  'downloadedBytes',
  'archiveWindows',
  'commentsRead',
  'emoteLoads',
  'emoteFrames',
  'overlayRedraws',
  'overlayReuses',
  'spriteRasters',
  'spriteHits',
]);
const gauges = new Set([
  'downloadConcurrency',
  'activeRequests',
  'bufferedMediaBytes',
  'emoteDecodedBytes',
  'emoteCompressedBytes',
  'activeComments',
  'waitingComments',
  'spriteBytes',
]);
const finite = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : undefined;
function numbers(value, fields) {
  return Object.fromEntries(
    fields.filter(key => finite(value?.[key]) !== undefined).map(key => [key, finite(value[key])]),
  );
}
function table(value, names, fields) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([key]) => names.has(key))
      .map(([key, item]) => [key, numbers(item, fields)]),
  );
}
export function performanceLog(value) {
  if (!value || typeof value !== 'object') return undefined;
  const encoder = numbers(value.encoder, ['width', 'height', 'bitrate', 'frameRate']);
  if (typeof value.encoder?.codec === 'string' && /^[\w.-]{1,64}$/.test(value.encoder.codec))
    encoder.codec = value.encoder.codec;
  if (['prefer-hardware', 'prefer-software', 'no-preference'].includes(value.encoder?.hardwarePreference))
    encoder.hardwarePreference = value.encoder.hardwarePreference;
  return {
    ...numbers(value, ['elapsedMs', 'firstPacketMs', 'firstFrameMs']),
    encoder,
    stages: table(value.stages, stages, ['count', 'totalMs', 'maxMs']),
    latency: table(value.latency, stages, ['p50UpperMs', 'p95UpperMs']),
    active: table(value.active, stages, ['count', 'oldestMs']),
    counters: numbers(value.counters, [...counters]),
    gauges: table(value.gauges, gauges, ['current', 'peak']),
  };
}
