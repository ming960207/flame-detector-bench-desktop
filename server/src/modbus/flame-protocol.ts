/**
 * 火焰探测器协议画像。
 *
 * 该画像来自旧上位机的协议画像模块，统一描述三波长/四波长设备在
 * 特征量步长、采样字节序、实时数据长度和波形分页上的差异。
 */

export type FlameProtocolId = 'standard' | 'four-wavelength';

export interface FlameProtocolProfile {
  readonly id: FlameProtocolId;
  readonly isFourWavelength: boolean;
  readonly channels: number;
  readonly featureRegistersPerGroup: number;
  readonly sampleRegistersPerPoint: number;
  readonly sampleOrder: string;
  readonly realtimeSampleOrder: string;
  readonly sampleEndian: 'little' | 'big';
  readonly realtimeRegisterQuantity: number;
  readonly realtimeMaxFeatureGroups: number;
  readonly alarmHeaderRegisters: number;
  readonly alarmTotalRegisters: number;
  readonly alarmPageQuantity: number;
  readonly alarmWaveformPageBase: number;
  readonly alarmMaxFeatureGroups: number;
  readonly customPushFrameLengths: readonly number[];
  readonly modbusPushByteCounts: readonly number[];
  readonly historyTotalRegisters: number;
  readonly historyPageQuantity: number;
  readonly historyMetaRegisters: number;
  readonly flameModeBase: number;
  readonly flameModeStart: number;
  readonly flameModeRegisters: number;
  readonly flameModeStride: number;
  readonly flameModeCount: number;
}

export const FLAME_PROTOCOLS: Readonly<{
  STANDARD: FlameProtocolProfile;
  FOUR_WAVELENGTH: FlameProtocolProfile;
}> = Object.freeze({
  STANDARD: Object.freeze({
    id: 'standard',
    isFourWavelength: false,
    channels: 3,
    featureRegistersPerGroup: 5,
    sampleRegistersPerPoint: 3,
    sampleOrder: 'probe1-probe2-probe3',
    realtimeSampleOrder: 'probe1-probe3-probe2',
    sampleEndian: 'little',
    realtimeRegisterQuantity: 83,
    realtimeMaxFeatureGroups: 16,
    alarmHeaderRegisters: 83,
    alarmTotalRegisters: 500,
    alarmPageQuantity: 125,
    alarmWaveformPageBase: 0x51BB,
    alarmMaxFeatureGroups: 16,
    customPushFrameLengths: Object.freeze([27, 29, 170]),
    modbusPushByteCounts: Object.freeze([0x86, 0xA6, 0xC6]),
    historyTotalRegisters: 512,
    historyPageQuantity: 127,
    historyMetaRegisters: 19,
    flameModeBase: 0x4000,
    flameModeStart: 0x4002,
    flameModeRegisters: 119,
    flameModeStride: 13,
    flameModeCount: 9,
  }),
  FOUR_WAVELENGTH: Object.freeze({
    id: 'four-wavelength',
    isFourWavelength: true,
    channels: 4,
    featureRegistersPerGroup: 6,
    sampleRegistersPerPoint: 4,
    sampleOrder: 'probe1-probe2-probe3-probe4',
    realtimeSampleOrder: 'probe1-probe2-probe3-probe4',
    sampleEndian: 'little',
    realtimeRegisterQuantity: 99,
    realtimeMaxFeatureGroups: 16,
    alarmHeaderRegisters: 99,
    alarmTotalRegisters: 579,
    alarmPageQuantity: 120,
    alarmWaveformPageBase: 0x5063,
    alarmMaxFeatureGroups: 16,
    customPushFrameLengths: Object.freeze([35]),
    modbusPushByteCounts: Object.freeze([0xC6]),
    historyTotalRegisters: 512,
    historyPageQuantity: 127,
    historyMetaRegisters: 19,
    flameModeBase: 0x4000,
    flameModeStart: 0x4002,
    flameModeRegisters: 119,
    flameModeStride: 13,
    flameModeCount: 9,
  }),
});

export function resolveFlameProtocol(value: unknown): FlameProtocolProfile {
  if (value && typeof value === 'object') {
    const candidate = value as { id?: unknown; isFourWavelength?: unknown; channels?: unknown };
    if (candidate.id === 'four-wavelength' || candidate.isFourWavelength === true || Number(candidate.channels) >= 4) {
      return FLAME_PROTOCOLS.FOUR_WAVELENGTH;
    }
    if (candidate.id === 'standard' || candidate.isFourWavelength === false || Number(candidate.channels) === 3) {
      return FLAME_PROTOCOLS.STANDARD;
    }
  }

  if (value === true || value === 'four' || value === 'four-wavelength' || value === '4') {
    return FLAME_PROTOCOLS.FOUR_WAVELENGTH;
  }
  return FLAME_PROTOCOLS.STANDARD;
}
