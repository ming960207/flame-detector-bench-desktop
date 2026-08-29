import type {
  FlameDetectorState,
  FlameDetectorUnitState,
  FlameDetectorWaveformDelta,
  FlameDetectorWaveformDeltaUnit,
  FlameSample,
} from '../server/src/types';

export type WaveformDisplayMode = 'raw' | 'normalized';

export const DEFAULT_WAVEFORM_MAX_SAMPLES = 1000;

const CHANNEL_KEYS: Array<keyof FlameSample> = ['probe1', 'probe2', 'probe3', 'probe4'];

function boundedSampleCount(value: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(Math.floor(parsed), DEFAULT_WAVEFORM_MAX_SAMPLES)
    : DEFAULT_WAVEFORM_MAX_SAMPLES;
}

export function waveformSamples(
  unit: FlameDetectorUnitState | undefined,
  mode: WaveformDisplayMode = 'normalized',
  maxSamples = DEFAULT_WAVEFORM_MAX_SAMPLES,
): FlameSample[] {
  const normalized = unit?.historySamples?.length ? unit.historySamples : unit?.samples ?? [];
  const raw = unit?.rawHistorySamples?.length ? unit.rawHistorySamples : unit?.rawSamples ?? normalized;
  const source = mode === 'raw' && raw.length > 0 ? raw : normalized;
  const limit = boundedSampleCount(maxSamples);
  return source.slice(Math.max(0, source.length - limit));
}

function mergeWaveformUnit(
  previous: FlameDetectorUnitState | undefined,
  delta: FlameDetectorWaveformDeltaUnit,
  maxSamples: number,
): FlameDetectorUnitState {
  const {
    historyDelta,
    rawHistoryDelta,
    historyReset,
    ...metadata
  } = delta;
  const previousHistory = historyReset ? [] : previous?.historySamples ?? [];
  const previousRawHistory = historyReset ? [] : previous?.rawHistorySamples ?? [];

  return {
    ...previous,
    ...metadata,
    historySamples: [
      ...previousHistory,
      ...(Array.isArray(historyDelta) ? historyDelta : []),
    ].slice(-maxSamples),
    rawHistorySamples: [
      ...previousRawHistory,
      ...(Array.isArray(rawHistoryDelta) ? rawHistoryDelta : []),
    ].slice(-maxSamples),
  };
}

export function mergeFlameWaveformDelta(
  current: FlameDetectorState,
  delta: FlameDetectorWaveformDelta,
  maxSamples = DEFAULT_WAVEFORM_MAX_SAMPLES,
): FlameDetectorState {
  if (!delta || !Array.isArray(delta.units)) return current;

  const limit = boundedSampleCount(maxSamples);
  const incoming = new Map(delta.units.map((unit) => [unit.index, unit]));
  const mergedIndexes = new Set<number>();
  const units = current.units.map((unit) => {
    const next = incoming.get(unit.index);
    if (!next) return unit;
    mergedIndexes.add(unit.index);
    return mergeWaveformUnit(unit, next, limit);
  });

  for (const unit of delta.units) {
    if (!mergedIndexes.has(unit.index)) units.push(mergeWaveformUnit(undefined, unit, limit));
  }

  return {
    ...current,
    units,
    onlineCount: delta.onlineCount,
    fireCount: delta.fireCount,
    faultCount: delta.faultCount,
    timestamp: delta.timestamp,
  };
}

export function waveformKeys(samples: FlameSample[], unit?: FlameDetectorUnitState): Array<keyof FlameSample> {
  const hasFourthChannel = unit?.probe4 !== undefined
    || unit?.probeCount >= 4
    || unit?.protocol === 'four-wavelength'
    || samples.some((sample) => sample.probe4 !== undefined);
  return hasFourthChannel ? CHANNEL_KEYS : CHANNEL_KEYS.slice(0, 3);
}

export interface WaveformDomain {
  minValue: number;
  maxValue: number;
  min: number;
  max: number;
  span: number;
}

export function waveformDomain(samples: FlameSample[], keys: Array<keyof FlameSample>): WaveformDomain {
  const flat = samples.flatMap((sample) => keys
    .map((key) => Number(sample[key]))
    .filter((value) => Number.isFinite(value)));
  const minValue = flat.length ? Math.min(...flat) : -1;
  const maxValue = flat.length ? Math.max(...flat) : 1;
  const min = minValue === maxValue ? minValue - 1 : minValue;
  const max = minValue === maxValue ? maxValue + 1 : maxValue;
  return { minValue, maxValue, min, max, span: Math.max(1, max - min) };
}
