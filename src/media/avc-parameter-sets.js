import { avccUnits, createAvcConfiguration, joinAvcc, readAvcConfiguration, UnsupportedAvcError } from './avc-packets.js';

const sameParameterSet = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const ueLength = value => 2 * Math.floor(Math.log2(value + 1)) + 1;

function unescape(unit) {
  const data = new Uint8Array(unit.length - 1);
  let length = 0;
  for (let index = 1; index < unit.length; index++) {
    if (index > 2 && unit[index] === 3 && unit[index - 1] === 0 && unit[index - 2] === 0) continue;
    data[length++] = unit[index];
  }
  return data.subarray(0, length);
}

function readUe(data, start) {
  let bit = start;
  function next() {
    if (bit >= data.length * 8) throw new Error('AVC 参数编号不完整。');
    return (data[bit >> 3] >> (7 - (bit++ & 7))) & 1;
  }
  let zeros = 0;
  while (!next()) if (++zeros > 31) throw new Error('AVC 参数编号超出范围。');
  let value = 1;
  for (let index = 0; index < zeros; index++) value = value * 2 + next();
  return { start, end: bit, value: value - 1 };
}

function parameterId(unit) {
  const data = unescape(unit), type = unit[0] & 31;
  const field = readUe(data, type === 7 ? 24 : 0);
  if (field.value > (type === 7 ? 31 : 255)) throw new Error('AVC 参数编号超出范围。');
  return field.value;
}

function rewrite(unit, fields, parameterSet) {
  const data = unescape(unit);
  let bits = data.length * 8;
  if (parameterSet) {
    // Strip only alignment zeroes, retaining rbsp_stop_one_bit. Slice trailing
    // data may include CABAC zero words and must instead retain its full length.
    while (bits && !(data[(bits - 1) >> 3] & (1 << (7 - ((bits - 1) & 7))))) bits--;
    if (!bits) throw new Error('AVC 参数集缺少结束标记。');
  }
  const size = bits + fields.reduce((sum, field) => sum + ueLength(field.target) - (field.end - field.start), 0);
  const result = new Uint8Array(Math.ceil(size / 8));
  let written = 0;
  function copy(from, length) {
    while (length) {
      const count = Math.min(length, 8 - (written & 7), 8 - (from & 7));
      const value = (data[from >> 3] >> (8 - (from & 7) - count)) & ((1 << count) - 1);
      result[written >> 3] |= value << (8 - (written & 7) - count);
      written += count; from += count; length -= count;
    }
  }
  let from = 0;
  for (const field of fields) {
    copy(from, field.start - from);
    written += Math.floor(Math.log2(field.target + 1));
    for (const bit of (field.target + 1).toString(2)) {
      if (bit === '1') result[written >> 3] |= 1 << (7 - (written & 7));
      written++;
    }
    from = field.end;
  }
  copy(from, bits - from);
  const escaped = [unit[0]];
  let zeros = 0;
  for (const byte of result) {
    if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(escaped);
}

function compatibleGeometry(source, boundary) {
  return source.codedWidth === boundary.codedWidth && source.codedHeight === boundary.codedHeight
    && (source.displayAspectWidth ?? source.codedWidth) * (boundary.displayAspectHeight ?? boundary.codedHeight)
      === (boundary.displayAspectWidth ?? boundary.codedWidth) * (source.displayAspectHeight ?? source.codedHeight);
}

/** One avc1 description, with original IDs untouched and independent encoder IDs. */
export function createAvcSplicer(source, boundaries) {
  const parameterSets = readAvcConfiguration(new Uint8Array(source.description)).parameterSets.map(unit => unit.slice());
  const sps = new Map(), pps = new Map();
  for (const unit of parameterSets) {
    const type = unit[0] & 31;
    if (type !== 7 && type !== 8) continue;
    const map = type === 7 ? sps : pps, id = parameterId(unit);
    if (map.has(id) && !sameParameterSet(map.get(id), unit)) throw new UnsupportedAvcError('原片包含冲突的 AVC 参数编号');
    map.set(id, unit);
  }
  function allocate(map, originalId, limit, byteAligned) {
    for (let id = 0; id <= limit; id++) {
      if (!map.has(id) && (!byteAligned || (ueLength(id) - ueLength(originalId)) % 8 === 0)) return id;
    }
    throw new UnsupportedAvcError('没有可用于拼接的独立 AVC 参数编号');
  }
  const mappings = boundaries.map(boundary => {
    if (!compatibleGeometry(source, boundary)) throw new UnsupportedAvcError('边界编码改变了画面尺寸');
    const units = readAvcConfiguration(new Uint8Array(boundary.description)).parameterSets;
    if (units.some(unit => (unit[0] & 31) === 13)) throw new UnsupportedAvcError('边界编码使用了 AVC 扩展参数');
    const spsIds = new Map(), ppsIds = new Map();
    for (const unit of units.filter(unit => (unit[0] & 31) === 7)) {
      const data = unescape(unit), field = readUe(data, 24), id = parameterId(unit);
      // Canonicalize the ID before comparing so identical head/tail parameter
      // sets share one entry even when the source already occupies encoder ID 0.
      let target = [...sps].find(([candidate, existing]) => sameParameterSet(existing, rewrite(unit, [{ ...field, target: candidate }], true)))?.[0];
      if (target === undefined) {
        target = allocate(sps, id, 31, false);
        const rewritten = rewrite(unit, [{ ...field, target }], true);
        sps.set(target, rewritten); parameterSets.push(rewritten);
      }
      spsIds.set(id, target);
    }
    for (const unit of units.filter(unit => (unit[0] & 31) === 8)) {
      const data = unescape(unit), field = readUe(data, 0), reference = readUe(data, field.end), id = parameterId(unit);
      const sequence = spsIds.get(reference.value);
      if (sequence === undefined) throw new Error('AVC PPS 引用了不存在的 SPS。');
      const rewritePps = target => rewrite(unit, [{ ...field, target }, { ...reference, target: sequence }], true);
      let target = [...pps].find(([candidate, existing]) => (ueLength(candidate) - ueLength(id)) % 8 === 0 && sameParameterSet(existing, rewritePps(candidate)))?.[0];
      if (target === undefined) {
        target = allocate(pps, id, 255, true);
        const rewritten = rewritePps(target);
        pps.set(target, rewritten); parameterSets.push(rewritten);
      }
      ppsIds.set(id, target);
    }
    return ppsIds;
  });
  if (sps.size > 31 || pps.size > 255) throw new UnsupportedAvcError('拼接参数数量超出 MP4 容量');
  const { description } = createAvcConfiguration(parameterSets);
  return {
    decoderConfig: { ...source, description },
    normalize(packet, boundaryIndex) {
      const mapping = mappings[boundaryIndex];
      const units = avccUnits(packet.data, 4).filter(unit => (unit[0] & 31) !== 6).map(unit => {
        const type = unit[0] & 31;
        if ([2, 3, 4, 19, 20, 21].includes(type)) throw new UnsupportedAvcError('边界编码使用了不支持的 AVC 图像扩展');
        if (type !== 1 && type !== 5) return unit;
        const data = unescape(unit);
        const firstMb = readUe(data, 0), sliceType = readUe(data, firstMb.end), field = readUe(data, sliceType.end);
        const target = mapping.get(field.value);
        if (target === undefined) throw new Error('AVC 图像引用了不存在的 PPS。');
        // An integral-byte length change preserves every CABAC/CAVLC/I_PCM
        // alignment point. Entropy-coded picture data is never decoded or edited.
        return target === field.value ? unit : rewrite(unit, [{ ...field, target }], false);
      });
      // Encoder SEI can reference its old SPS ID. Boundary timing is carried by
      // MP4; omitting those optional encoder messages avoids stale references.
      return packet.clone({ data: joinAvcc(units) });
    },
  };
}
