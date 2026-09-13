const PARAMETER_SET_TYPES = new Set([7, 8, 13]);
const EXTENDED_AVCC_PROFILES = new Set([100, 110, 122, 144]);

export class UnsupportedAvcError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedAvcError'; }
}

function bytesOf(value) {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function avccUnits(data, lengthSize) {
  const units = [];
  for (let offset = 0; offset < data.byteLength;) {
    if (offset + lengthSize > data.byteLength) throw new Error('AVC 数据的长度字段不完整。');
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[offset++];
    if (!length || offset + length > data.byteLength) throw new Error('AVC 数据长度与内容不符。');
    units.push(data.subarray(offset, offset + length));
    offset += length;
  }
  if (!units.length) throw new Error('AVC 数据包为空。');
  return units;
}

function annexBUnits(data) {
  const units = [];
  let start = -1;
  for (let index = 2; index < data.byteLength; index++) {
    if (data[index] !== 1 || data[index - 1] !== 0 || data[index - 2] !== 0) continue;
    let end = index - 2;
    while (end > 0 && data[end - 1] === 0) end--;
    if (start >= 0) {
      if (end <= start) throw new Error('AVC 数据包含空的 NAL 单元。');
      units.push(data.subarray(start, end));
    } else if (end !== 0) {
      throw new Error('AVC Annex B 数据的起始标记无效。');
    }
    start = index + 1;
  }
  if (start < 0) throw new Error('AVC Annex B 数据缺少起始标记。');
  let end = data.byteLength;
  while (end > start && data[end - 1] === 0) end--;
  if (end <= start) throw new Error('AVC 数据包含空的 NAL 单元。');
  units.push(data.subarray(start, end));
  return units;
}

function readConfiguration(description) {
  if (description.byteLength < 7 || description[0] !== 1) throw new Error('AVC 解码参数无效。');
  const lengthSize = (description[4] & 3) + 1;
  if (lengthSize === 3) throw new UnsupportedAvcError('这段录像使用了不支持的 AVC 长度格式。');
  let offset = 6;
  const parameterSets = [];
  function group(count, type) {
    for (let i = 0; i < count; i++) {
      if (offset + 2 > description.byteLength) throw new Error('AVC 参数集长度不完整。');
      const length = description[offset] * 256 + description[offset + 1];
      offset += 2;
      if (!length || offset + length > description.byteLength) throw new Error('AVC 参数集不完整。');
      const unit = description.subarray(offset, offset + length);
      if ((unit[0] & 31) !== type) throw new Error('AVC 参数集类型不符。');
      parameterSets.push(unit);
      offset += length;
    }
  }
  group(description[5] & 31, 7);
  if (offset >= description.byteLength) throw new Error('AVC 解码参数缺少 PPS 数量。');
  group(description[offset++], 8);
  if (EXTENDED_AVCC_PROFILES.has(description[1]) && offset < description.byteLength) {
    if (offset + 4 > description.byteLength) throw new Error('AVC 扩展解码参数不完整。');
    offset += 3;
    group(description[offset++], 13);
  }
  if (!parameterSets.some(unit => (unit[0] & 31) === 7)
    || !parameterSets.some(unit => (unit[0] & 31) === 8)) {
    throw new UnsupportedAvcError('录像缺少完整的 AVC 参数集，无法安全复用原始视频。');
  }
  return { lengthSize, parameterSets };
}

// Only the SPS prefix is needed for avcC's chroma/bit-depth fields, not frame decoding.
function extendedSpsFields(sps) {
  const rbsp = [];
  for (let index = 0; index < sps.byteLength; index++) {
    if (sps[index] === 3 && index >= 2 && sps[index - 1] === 0 && sps[index - 2] === 0) continue;
    rbsp.push(sps[index]);
  }
  let bit = 32;
  function nextBit() {
    if (bit >= rbsp.length * 8) throw new Error('AVC SPS 参数不完整。');
    return (rbsp[bit >> 3] >> (7 - (bit++ & 7))) & 1;
  }
  function unsignedExpGolomb() {
    let zeros = 0;
    while (nextBit() === 0) zeros++;
    let value = 1;
    for (let index = 0; index < zeros; index++) value = value * 2 + nextBit();
    return value - 1;
  }
  unsignedExpGolomb(); // seq_parameter_set_id
  const chromaFormat = unsignedExpGolomb();
  if (chromaFormat === 3) nextBit(); // separate_colour_plane_flag
  const lumaDepth = unsignedExpGolomb(), chromaDepth = unsignedExpGolomb();
  if (chromaFormat > 3 || lumaDepth > 7 || chromaDepth > 7) throw new Error('AVC SPS 色彩格式无效。');
  return [0xfc | chromaFormat, 0xf8 | lumaDepth, 0xf8 | chromaDepth];
}

function configurationFromAnnexB(units) {
  const parameterSets = units.filter(unit => PARAMETER_SET_TYPES.has(unit[0] & 31))
    .filter((unit, index, all) => all.findIndex(other => sameBytes(unit, other)) === index)
    .map(unit => unit.slice());
  const sps = parameterSets.filter(unit => (unit[0] & 31) === 7);
  const pps = parameterSets.filter(unit => (unit[0] & 31) === 8);
  const extensions = parameterSets.filter(unit => (unit[0] & 31) === 13);
  if (!sps.length || !pps.length) {
    throw new UnsupportedAvcError('录像首个关键帧缺少完整的 AVC 参数集，无法安全复用原始视频。');
  }
  if (sps[0].byteLength < 4) throw new Error('AVC SPS 参数不完整。');
  if (sps.length > 31 || pps.length > 255 || extensions.length > 255) throw new Error('AVC 参数集数量超出封装范围。');
  const data = [1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length];
  function append(group) {
    for (const unit of group) {
      if (unit.byteLength > 65535) throw new Error('AVC 参数集长度超出封装范围。');
      data.push(unit.byteLength >> 8, unit.byteLength & 255, ...unit);
    }
  }
  append(sps);
  data.push(pps.length);
  append(pps);
  if (EXTENDED_AVCC_PROFILES.has(sps[0][1])) {
    data.push(...extendedSpsFields(sps[0]), extensions.length);
    append(extensions);
  } else if (extensions.length) {
    throw new UnsupportedAvcError('这段录像的 AVC 扩展参数无法安全复用。');
  }
  return { description: Uint8Array.from(data), parameterSets };
}

function joinAvcc(units) {
  const data = new Uint8Array(units.reduce((size, unit) => size + 4 + unit.byteLength, 0));
  const view = new DataView(data.buffer);
  let offset = 0;
  for (const unit of units) {
    view.setUint32(offset, unit.byteLength);
    data.set(unit, offset + 4);
    offset += 4 + unit.byteLength;
  }
  return data;
}

/** Owns one stable AVC decoder configuration. Inputs keep their original packet format. */
export function createAvcNormalizer(decoderConfig, firstPacket) {
  let description = decoderConfig.description ? bytesOf(decoderConfig.description).slice() : null;
  let lengthSize = 0, parameterSets;
  if (description?.byteLength) {
    ({ lengthSize, parameterSets } = readConfiguration(description));
    description[4] = (description[4] & 0xfc) | 3;
  } else {
    if (!firstPacket) throw new UnsupportedAvcError('需要录像首个关键帧才能读取 AVC 参数。');
    ({ description, parameterSets } = configurationFromAnnexB(annexBUnits(firstPacket.data)));
  }
  const config = {
    ...decoderConfig,
    codec: `avc1.${Array.from(description.subarray(1, 4), byte => byte.toString(16).padStart(2, '0')).join('')}`,
    description,
  };
  function inspect(packet) {
    const units = lengthSize ? avccUnits(packet.data, lengthSize) : annexBUnits(packet.data);
    const samples = [];
    let idr = false;
    for (const unit of units) {
      const type = unit[0] & 31;
      if (PARAMETER_SET_TYPES.has(type)) {
        if (!parameterSets.some(expected => sameBytes(unit, expected))) {
          throw new UnsupportedAvcError('录像中的 AVC 参数发生变化，无法安全复用原始视频。');
        }
      } else samples.push(unit);
      if (type === 5) idr = true;
    }
    return { units, samples, idr };
  }
  return {
    decoderConfig: config,
    isIdr(packet) { return inspect(packet).idr; },
    normalize(packet) {
      const { units, samples, idr } = inspect(packet);
      const type = idr ? 'key' : 'delta';
      if (lengthSize === 4 && samples.length === units.length) {
        return packet.type === type ? packet : packet.clone({ type });
      }
      return packet.clone({ data: joinAvcc(samples), type });
    },
  };
}
