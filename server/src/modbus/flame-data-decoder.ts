import { FLAME_PROTOCOLS, resolveFlameProtocol, type FlameProtocolProfile } from './flame-protocol.js';

export interface FlameSample {
  probe1: number;
  probe2: number;
  probe3: number;
  probe4?: number;
}

export interface FlameFeature {
  snr2: number;
  snr21: number;
  snr23: number;
  snr31: number;
  snr43?: number;
  peakPower: number;
}

export interface DecodedFeatureBlock {
  mode: number | null;
  rawMode: number | null;
  fifoCount: number;
  alarmTime: number | null;
  features: FlameFeature[];
  samples: FlameSample[];
  featureCount: number;
  registers: number[];
}

export interface DecodedCustomWaveform {
  channels: number;
  sampleEndian: 'little' | 'big';
  sampleOrder: string;
  frameLength: number;
  payloadLength: number;
  checksum: number;
  checksumCalculated: number;
  checksumValid: boolean;
  samples: FlameSample[];
  frame: number[];
}

/** Modbus RTU CRC16，返回值按 Modbus 的低字节在前格式表示。 */
export function calculateModbusCRC16(data: ArrayLike<number>): number {
  let crc = 0xFFFF;
  for (let index = 0; index < data.length; index += 1) {
    crc ^= Number(data[index]) & 0xFF;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
  }
  return crc & 0xFFFF;
}

function hasValidModbusCRC(frame: ArrayLike<number>): boolean {
  if (frame.length < 3) return false;
  const received = ((Number(frame[frame.length - 1]) & 0xFF) << 8)
    | (Number(frame[frame.length - 2]) & 0xFF);
  return calculateModbusCRC16(Array.prototype.slice.call(frame, 0, frame.length - 2)) === received;
}

/**
 * 拆出标准 Modbus 03H 实时主动推流帧：
 * [从站地址][03][字节数][寄存器数据][CRC_L][CRC_H]。
 *
 * 该帧与 5A A5 自定义推流共用同一 TCP 原始字节流，因此只保留尚未
 * 收完整的候选帧，避免半帧跨 TCP 包时被丢弃。
 */
export function extractModbusRealtimeFrames(
  input: Uint8Array,
  byteCounts: readonly number[] = [0x86, 0xA6, 0xC6],
): { frames: Buffer[]; remainder: Buffer } {
  let buffer = Buffer.from(input);
  const supported = new Set(byteCounts.filter((value) => Number.isInteger(value) && value > 0 && value <= 0xFA));
  const frames: Buffer[] = [];
  if (supported.size === 0) return { frames, remainder: buffer };

  while (buffer.length >= 5) {
    let extracted = false;
    let incompleteOffset = -1;

    for (let offset = 0; offset <= buffer.length - 3; offset += 1) {
      if (buffer[offset + 1] !== 0x03) continue;
      const byteCount = buffer[offset + 2] ?? 0;
      if (!supported.has(byteCount) || byteCount % 2 !== 0) continue;
      const frameLength = 5 + byteCount;
      if (buffer.length - offset < frameLength) {
        incompleteOffset = offset;
        break;
      }

      const candidate = buffer.subarray(offset, offset + frameLength);
      if (!hasValidModbusCRC(candidate)) continue;
      frames.push(Buffer.from(candidate));
      buffer = Buffer.concat([buffer.subarray(0, offset), buffer.subarray(offset + frameLength)]);
      extracted = true;
      break;
    }

    if (extracted) continue;
    if (incompleteOffset >= 0) {
      buffer = buffer.subarray(incompleteOffset);
    } else if (buffer.length > 4) {
      // 保留足够字节以识别下一个跨包的 [addr][03][byteCount] 头。
      buffer = buffer.subarray(-4);
    }
    break;
  }

  return { frames, remainder: Buffer.from(buffer) };
}

/** 校验并将 Modbus 03H 实时推流帧转换为实时特征/采样块。 */
export function decodeModbusRealtimeFrame(
  frame: ArrayLike<number>,
  profileOrOptions: FlameProtocolProfile | { channels?: number; sampleOrder?: string } = FLAME_PROTOCOLS.STANDARD,
): DecodedFeatureBlock {
  const values = Array.from(frame || [], Number).map((value) => value & 0xFF);
  if (values.length < 5 || values[1] !== 0x03) throw new Error('Modbus 实时推流帧头无效');
  const byteCount = values[2] ?? 0;
  const expectedLength = 5 + byteCount;
  if (values.length !== expectedLength || byteCount % 2 !== 0) {
    throw new Error(`Modbus 实时推流帧长度无效: byteCount=${byteCount}, length=${values.length}`);
  }
  if (!hasValidModbusCRC(values)) throw new Error('Modbus 实时推流帧 CRC 校验失败');

  const registers: number[] = [];
  for (let offset = 3; offset < 3 + byteCount; offset += 2) {
    registers.push(((values[offset] ?? 0) << 8) | (values[offset + 1] ?? 0));
  }
  return decodeRealtime(registers, profileOrOptions);
}

export function extractCustomWaveformFrames(
  input: Uint8Array,
  frameLengths: readonly number[],
): { frames: Buffer[]; remainder: Buffer } {
  let buffer = Buffer.from(input);
  const lengths = [...new Set(frameLengths.filter((length) => Number.isInteger(length) && length >= 3))].sort((a, b) => a - b);
  const frames: Buffer[] = [];
  if (lengths.length === 0) return { frames, remainder: buffer };

  while (buffer.length > 0) {
    const header = buffer.indexOf(Buffer.from([0x5A, 0xA5]));
    if (header < 0) return { frames, remainder: buffer.at(-1) === 0x5A ? buffer.subarray(-1) : Buffer.alloc(0) };
    if (header > 0) buffer = buffer.subarray(header);

    // The device tail byte is firmware-defined and is not a reliable checksum.
    // Prefer a length whose following bytes are the next frame header; otherwise
    // wait until a complete candidate is available.
    const boundary = lengths.find((length) => buffer.length >= length + 2 && buffer[length] === 0x5A && buffer[length + 1] === 0xA5);
    const exact = lengths.find((length) => buffer.length === length);
    const length = boundary ?? exact ?? (buffer.length >= lengths[lengths.length - 1]! ? lengths[lengths.length - 1] : undefined);
    if (!length) break;
    frames.push(Buffer.from(buffer.subarray(0, length)));
    buffer = buffer.subarray(length);
  }

  return { frames, remainder: Buffer.from(buffer) };
}

export interface WaveformChannelMetrics {
  fluctuation: number;
  absolute: number;
}

export function summarizeWaveformChannels(samples: FlameSample[]): Record<'probe1' | 'probe2' | 'probe3' | 'probe4', WaveformChannelMetrics> {
  const result = {
    probe1: { fluctuation: 0, absolute: 0 },
    probe2: { fluctuation: 0, absolute: 0 },
    probe3: { fluctuation: 0, absolute: 0 },
    probe4: { fluctuation: 0, absolute: 0 },
  } satisfies Record<'probe1' | 'probe2' | 'probe3' | 'probe4', WaveformChannelMetrics>;
  for (const key of Object.keys(result) as Array<keyof typeof result>) {
    let min = Infinity;
    let max = -Infinity;
    let absolute = 0;
    for (const sample of samples) {
      const value = Number(sample[key]);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      absolute = Math.max(absolute, Math.abs(value));
    }
    result[key] = Number.isFinite(min) ? { fluctuation: (max - min) / 2, absolute } : { fluctuation: 0, absolute: 0 };
  }
  return result;
}

export function toSignedInt16(value: number): number {
  const normalized = Number(value) & 0xFFFF;
  return normalized > 0x7FFF ? normalized - 0x10000 : normalized;
}

function profileFrom(value?: FlameProtocolProfile | unknown): FlameProtocolProfile {
  return resolveFlameProtocol(value ?? FLAME_PROTOCOLS.STANDARD);
}

function orderKeys(order: string, channels: number): string[] {
  return order.split('-').slice(0, channels);
}

function checksum8(values: number[]): number {
  return values.reduce((sum, value) => (sum + value) & 0xFF, 0);
}

export function decodeCustomWaveformFrame(
  frame: ArrayLike<number>,
  profileOrOptions: FlameProtocolProfile | { channels?: number; sampleEndian?: 'little' | 'big'; sampleOrder?: string } = FLAME_PROTOCOLS.STANDARD,
): DecodedCustomWaveform {
  const values = Array.from(frame || [], Number);
  if (values.length < 3 || values[0] !== 0x5A || values[1] !== 0xA5) {
    throw new Error('5A A5 推流帧头无效或帧长度不足');
  }

  const profile = profileFrom(profileOrOptions);
  const options = profileOrOptions as { channels?: number; sampleEndian?: 'little' | 'big'; sampleOrder?: string };
  const channels = Number.isInteger(options.channels) ? Number(options.channels) : profile.channels;
  if (channels < 1 || channels > 8) throw new Error(`推流通道数无效: ${channels}`);
  const hasExplicitEndian = Object.prototype.hasOwnProperty.call(options, 'sampleEndian');
  const sampleEndian = hasExplicitEndian ? (options.sampleEndian === 'big' ? 'big' : 'little') : profile.sampleEndian;
  const sampleOrder = options.sampleOrder || profile.sampleOrder;
  // Short push frames (27/35 bytes) carry a trailing firmware byte after the
  // samples. One standard-firmware capture is 29 bytes and includes an extra
  // 16-bit word before that byte; remove it only when the byte-sum checksum
  // confirms the aligned 3-channel payload. The 170-byte standard frame is the
  // long form and uses all bytes after 5A A5 as sample data, so treating its last
  // byte as a checksum leaves an unaligned 167-byte payload and drops every
  // waveform frame.
  const bytesPerSample = channels * 2;
  const payloadWithTrailingByte = values.slice(2, -1);
  const trailingChecksum = values[values.length - 1] ?? 0;
  let hasTrailingByte = false;
  let checksumCalculated = 0;
  let payload: number[] = [];
  if (payloadWithTrailingByte.length > 0 && payloadWithTrailingByte.length % bytesPerSample === 0) {
    hasTrailingByte = true;
    payload = payloadWithTrailingByte;
    checksumCalculated = checksum8(values.slice(0, -1));
  } else if (
    payloadWithTrailingByte.length >= 2
    && (payloadWithTrailingByte.length - 2) % bytesPerSample === 0
  ) {
    for (let removeOffset = 0; removeOffset <= payloadWithTrailingByte.length - 2; removeOffset += 2) {
      const candidatePayload = [
        ...payloadWithTrailingByte.slice(0, removeOffset),
        ...payloadWithTrailingByte.slice(removeOffset + 2),
      ];
      const candidateFrame = [
        ...values.slice(0, 2 + removeOffset),
        ...values.slice(2 + removeOffset + 2, -1),
      ];
      const candidateChecksum = checksum8(candidateFrame);
      if (candidateChecksum !== trailingChecksum) continue;
      hasTrailingByte = true;
      payload = candidatePayload;
      checksumCalculated = candidateChecksum;
      break;
    }
  }
  if (payload.length === 0) payload = values.slice(2);
  if (payload.length === 0 || payload.length % bytesPerSample !== 0) {
    throw new Error(`5A A5 推流帧采样区未按${bytesPerSample}字节对齐`);
  }

  const keys = orderKeys(sampleOrder, channels);
  const samples: FlameSample[] = [];
  for (let offset = 0; offset < payload.length; offset += bytesPerSample) {
    const sample: Record<string, number> = {};
    for (let channel = 0; channel < channels; channel += 1) {
      const byteOffset = offset + channel * 2;
      const high = payload[byteOffset] ?? 0;
      const low = payload[byteOffset + 1] ?? 0;
      const raw = sampleEndian === 'big' ? (high << 8) | low : (low << 8) | high;
      sample[keys[channel] || `probe${channel + 1}`] = toSignedInt16(raw);
    }
    samples.push(sample as unknown as FlameSample);
  }

  const checksum = hasTrailingByte ? trailingChecksum : 0;
  return {
    channels,
    sampleEndian,
    sampleOrder,
    frameLength: values.length,
    payloadLength: payload.length,
    checksum,
    checksumCalculated,
    checksumValid: !hasTrailingByte || checksum === checksumCalculated,
    samples,
    frame: values,
  };
}

export function normalizeFeatureCount(value: number, maxFeatureGroups = 50): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) return 0;
  return Math.min(count, maxFeatureGroups);
}

export function decodeFeatures(registers: number[], featureCount: number, profile: FlameProtocolProfile): FlameFeature[] {
  const features: FlameFeature[] = [];
  for (let index = 0; index < featureCount; index += 1) {
    const base = 3 + index * profile.featureRegistersPerGroup;
    if (base + profile.featureRegistersPerGroup - 1 >= registers.length) break;
    const feature: FlameFeature = {
      snr2: toSignedInt16(registers[base] ?? 0),
      snr21: toSignedInt16(registers[base + 1] ?? 0),
      snr23: toSignedInt16(registers[base + 2] ?? 0),
      snr31: toSignedInt16(registers[base + 3] ?? 0),
      peakPower: toSignedInt16(registers[base + (profile.isFourWavelength ? 5 : 4)] ?? 0),
    };
    if (profile.isFourWavelength) feature.snr43 = toSignedInt16(registers[base + 4] ?? 0);
    features.push(feature);
  }
  return features;
}

export function decodeSamples(registers: number[], order: string, profile: FlameProtocolProfile): FlameSample[] {
  const keys = orderKeys(order || profile.sampleOrder, profile.sampleRegistersPerPoint);
  const samples: FlameSample[] = [];
  for (let index = 0; index + profile.sampleRegistersPerPoint - 1 < registers.length; index += profile.sampleRegistersPerPoint) {
    const sample: Record<string, number> = {};
    for (let offset = 0; offset < profile.sampleRegistersPerPoint; offset += 1) {
      sample[keys[offset] || `probe${offset + 1}`] = toSignedInt16(registers[index + offset] ?? 0);
    }
    samples.push(sample as unknown as FlameSample);
  }
  return samples;
}

export function limitSamples(samples: FlameSample[], maxSamples = 160): FlameSample[] {
  const limit = Number.isInteger(maxSamples) && maxSamples > 0 ? maxSamples : samples.length;
  return (Array.isArray(samples) ? samples : []).slice(0, limit);
}

export function decodeFeatureBlock(
  registers: number[],
  profileOrOptions: FlameProtocolProfile | { sampleRegisters?: number[]; includeInlineSamples?: boolean; maxFeatureGroups?: number; sampleOrder?: string } = FLAME_PROTOCOLS.STANDARD,
): DecodedFeatureBlock {
  const profile = profileFrom(profileOrOptions);
  const options = profileOrOptions as {
    sampleRegisters?: number[];
    includeInlineSamples?: boolean;
    maxFeatureGroups?: number;
    sampleOrder?: string;
  };
  const values = Array.from(registers || [], Number);
  const reportedCount = values.length >= 2 ? values[1] ?? 0 : 0;
  const featureCount = normalizeFeatureCount(reportedCount, options.maxFeatureGroups ?? 50);
  const featureRegistersEnd = Math.min(values.length, 3 + featureCount * profile.featureRegistersPerGroup);
  let inlineSampleRegisters = options.includeInlineSamples === false ? [] : values.slice(featureRegistersEnd);
  const pageRegisters = Array.isArray(options.sampleRegisters) ? options.sampleRegisters : [];
  if (pageRegisters.length > 0 && inlineSampleRegisters.length % profile.sampleRegistersPerPoint !== 0) {
    inlineSampleRegisters = inlineSampleRegisters.slice(0, inlineSampleRegisters.length - (inlineSampleRegisters.length % profile.sampleRegistersPerPoint));
  }

  return {
    mode: values.length > 0 ? toSignedInt16(values[0] ?? 0) : null,
    rawMode: values.length > 0 ? values[0] ?? 0 : null,
    fifoCount: Number.isInteger(reportedCount) ? reportedCount : 0,
    alarmTime: values.length > 2 ? values[2] ?? null : null,
    features: decodeFeatures(values, featureCount, profile),
    samples: decodeSamples(inlineSampleRegisters.concat(pageRegisters), options.sampleOrder || profile.sampleOrder, profile),
    featureCount,
    registers: values,
  };
}

export function decodeRealtime(registers: number[], profileOrOptions: FlameProtocolProfile | { sampleOrder?: string; maxFeatureGroups?: number } = FLAME_PROTOCOLS.STANDARD): DecodedFeatureBlock {
  const profile = profileFrom(profileOrOptions);
  const options = profileOrOptions as { sampleOrder?: string; maxFeatureGroups?: number };
  const isProfileObject = Boolean(profileOrOptions && typeof profileOrOptions === 'object' && 'id' in profileOrOptions);
  return decodeFeatureBlock(registers, {
    ...options,
    maxFeatureGroups: options.maxFeatureGroups ?? profile.realtimeMaxFeatureGroups,
    sampleOrder: isProfileObject ? profile.realtimeSampleOrder : (options.sampleOrder || profile.realtimeSampleOrder),
  });
}
