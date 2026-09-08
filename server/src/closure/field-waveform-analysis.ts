import { isPLCProcessComplete, PLC_HEAT_SUBSTAGE_LABELS, type PLCHeatSubstage, type PLCProcessStatus } from '../process-status.js';
import type { FlameDetectorState, FlameDetectorUnitState, FlameSample } from '../types.js';
import { summarizeWaveformChannels } from '../modbus/flame-data-decoder.js';
import type { DetectorStartupDiagnostic } from '../modbus/detector-startup.js';

export type WaveformAnalysisPhase = 'IDLE' | 'NOISE' | 'INTERFERENCE' | 'COMPLETE';
export type WaveformAnalysisVerdict = 'PASS' | 'FAIL' | 'PENDING';
export type WaveformAnalysisLogger = (message: string) => void;

// M25.2 marks the PLC noise window, but the detector signal needs an additional
// 10-second settling interval before the upper computer starts baseline sampling.
// The PLC window remains unchanged; this intentionally reduces effective noise
// sampling by 5 seconds to keep the signal stable before measurement.
const UPPER_COMPUTER_SIGNAL_STABILIZATION_WAIT_MS = 10_000;
const NOISE_TREND_LOG_INTERVAL_MS = 1_000;

export interface DetectionSNRRange {
  min: number;
  max: number;
}

export interface DetectionQualityThresholds {
  maxNoiseRms: number;
  maxNoiseAbsolute?: number;
  maxInterferenceRatio: number;
  minConsistencyTrend?: number;
  minSensitivity: number;
}

export interface DetectionRatioThresholds {
  snr21: DetectionSNRRange;
  snr23: DetectionSNRRange;
  snr31: DetectionSNRRange;
}

export interface DetectionQualityConfig {
  acceptanceGrade: 'A' | 'B';
  a: DetectionQualityThresholds;
  b: DetectionQualityThresholds;
  ratios: { a: DetectionRatioThresholds; b: DetectionRatioThresholds };
}

export interface WaveformAnalysisConfig {
  minNoiseSamples: number;
  minInterferenceSamples: number;
  minNoiseRms: number;
  maxNoiseRms: number;
  maxNoiseAbsolute?: number;
  maxInterferenceRatio: number;
  noiseProbes?: ChannelKey[];
  interferenceRatio?: { numerator: ChannelKey; denominator: ChannelKey };
  consistencyProbes?: ChannelKey[];
  minConsistencyTrend?: number;
  quality?: DetectionQualityConfig;
}

export type ChannelKey = 'probe1' | 'probe2' | 'probe3' | 'probe4';

export interface WaveformChannelMetrics {
  fluctuation: number;
  absolute: number;
}

export const DEFAULT_WAVEFORM_ANALYSIS_CONFIG: WaveformAnalysisConfig = Object.freeze({
  minNoiseSamples: 400,
  minInterferenceSamples: 80,
  minNoiseRms: 50,
  maxNoiseRms: 200,
  maxNoiseAbsolute: 1000,
  maxInterferenceRatio: 1.5,
  noiseProbes: ['probe2', 'probe3'] as ChannelKey[],
  interferenceRatio: { numerator: 'probe2' as ChannelKey, denominator: 'probe3' as ChannelKey },
  consistencyProbes: ['probe2', 'probe3'] as ChannelKey[],
  minConsistencyTrend: 0.75,
});

const DEFAULT_DETECTOR_RATIOS: DetectionRatioThresholds = {
  snr21: { min: 0, max: 0 },
  snr23: { min: 0.5, max: 1.5 },
  snr31: { min: 0, max: 0 },
};

function defaultRatioGrades(): DetectionQualityConfig['ratios'] {
  return {
    a: {
      snr21: { ...DEFAULT_DETECTOR_RATIOS.snr21 },
      snr23: { ...DEFAULT_DETECTOR_RATIOS.snr23 },
      snr31: { ...DEFAULT_DETECTOR_RATIOS.snr31 },
    },
    b: {
      snr21: { ...DEFAULT_DETECTOR_RATIOS.snr21 },
      snr23: { ...DEFAULT_DETECTOR_RATIOS.snr23 },
      snr31: { ...DEFAULT_DETECTOR_RATIOS.snr31 },
    },
  };
}

export const DEFAULT_DETECTION_QUALITY_CONFIG: DetectionQualityConfig = {
  acceptanceGrade: 'B',
  a: {
    maxNoiseRms: 180,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    minConsistencyTrend: 0.8,
    minSensitivity: 0,
  },
  b: {
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    minConsistencyTrend: 0.75,
    minSensitivity: 0,
  },
  ratios: {
    ...defaultRatioGrades(),
    b: {
      ...DEFAULT_DETECTOR_RATIOS,
      snr23: { min: 0.48, max: 1.5 },
    },
  },
};

function qualityThresholds(value: unknown, fallback: DetectionQualityThresholds): DetectionQualityThresholds {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (key: keyof DetectionQualityThresholds) => {
    const parsed = Number(source[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : (fallback[key] ?? 0);
  };
  return {
    maxNoiseRms: number('maxNoiseRms'),
    maxNoiseAbsolute: number('maxNoiseAbsolute'),
    maxInterferenceRatio: number('maxInterferenceRatio'),
    minConsistencyTrend: Math.min(1, number('minConsistencyTrend')),
    minSensitivity: number('minSensitivity'),
  };
}

function snrRange(value: unknown, fallback: DetectionSNRRange): DetectionSNRRange {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (key: keyof DetectionSNRRange) => {
    const parsed = Number(source[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback[key];
  };
  const min = number('min');
  const max = number('max');
  return { min, max: max > 0 && max < min ? min : max };
}

function ratioThresholds(value: unknown, fallback: DetectionRatioThresholds): DetectionRatioThresholds {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    snr21: snrRange(source.snr21, fallback.snr21),
    snr23: snrRange(source.snr23, fallback.snr23),
    snr31: snrRange(source.snr31, fallback.snr31),
  };
}

export function normalizeDetectionQualityConfig(input: unknown, fallback: DetectionQualityConfig = DEFAULT_DETECTION_QUALITY_CONFIG): DetectionQualityConfig {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const inputRatios = source.ratios && typeof source.ratios === 'object' && !Array.isArray(source.ratios)
    ? source.ratios as Record<string, unknown> : {};
  const legacyDetectors = source.detectors && typeof source.detectors === 'object' && !Array.isArray(source.detectors)
    ? source.detectors as Record<string, unknown> : {};
  const legacyFirst = legacyDetectors['1'] && typeof legacyDetectors['1'] === 'object'
    ? legacyDetectors['1'] as Record<string, unknown> : {};
  const fallbackRatios = fallback.ratios ?? DEFAULT_DETECTION_QUALITY_CONFIG.ratios;
  return {
    acceptanceGrade: source.acceptanceGrade === 'A' || source.acceptanceGrade === 'B'
      ? source.acceptanceGrade : fallback.acceptanceGrade,
    a: qualityThresholds(source.a, fallback.a),
    b: qualityThresholds(source.b, fallback.b),
    ratios: {
      a: ratioThresholds(inputRatios.a ?? legacyFirst.a, fallbackRatios.a),
      b: ratioThresholds(inputRatios.b ?? legacyFirst.b ?? legacyFirst.a, fallbackRatios.b),
    },
  };
}

export interface WaveformAnalysisUnitResult {
  index: number;
  address: number;
  phase: WaveformAnalysisPhase;
  verdict: WaveformAnalysisVerdict;
  noiseRms: number | null;
  noisePeakToPeak: number | null;
  noiseAbsolute: number | null;
  interferenceRms: number | null;
  interferenceRatio: number | null;
  consistencyTrend: number | null;
  snr21: number | null;
  snr23: number | null;
  snr31: number | null;
  noiseSampleCount: number;
  noiseTest: NoiseTestResult;
  interferenceSampleCount: number;
  stages: Record<InterferenceStage, InterferenceStageResult>;
  sampledAt: number;
  startup?: DetectorStartupDiagnostic;
  reason?: string;
}

export interface NoiseTestResult {
  verdict: WaveformAnalysisVerdict;
  reason: string;
  sampleCount: number;
  metrics: Record<ChannelKey, WaveformChannelMetrics>;
}

export type InterferenceStage = 'heat' | 'flash' | 'emc';

export interface InterferenceStageResult {
  completed: boolean;
  verdict: WaveformAnalysisVerdict;
  reason: string;
  sampleCount: number;
  interferenceRatio: number | null;
  consistencyTrend: number | null;
  snr21: number | null;
  snr23: number | null;
  snr31: number | null;
}

export interface HeatStageTimings {
  stabilizationStartedAt: number | null;
  stabilizationEndedAt: number | null;
  noiseStartedAt: number | null;
  noiseEndedAt: number | null;
  interferenceStartedAt: number | null;
  interferenceEndedAt: number | null;
}

export interface FieldWaveformAnalysisSnapshot {
  batchId: string | null;
  phase: WaveformAnalysisPhase;
  processStage: PLCProcessStatus['processStage'] | null;
  heatSubstage: PLCHeatSubstage;
  heatSubstageLabel: string;
  heatStageTimings: HeatStageTimings;
  verdict: WaveformAnalysisVerdict;
  startedAt: number | null;
  noiseCaptureActive: boolean;
  noiseStartedAt: number | null;
  noiseEndedAt: number | null;
  updatedAt: number;
  thresholds: WaveformAnalysisConfig;
  units: WaveformAnalysisUnitResult[];
}

const CHANNEL_KEYS: ChannelKey[] = ['probe1', 'probe2', 'probe3', 'probe4'];
interface LatestUnitState {
  address: number;
  online: boolean;
  fault: boolean;
  sourceReady: boolean;
  syncOk: boolean;
  lastUpdate: number;
  seen: boolean;
  startup?: DetectorStartupDiagnostic;
}

interface UnitAccumulator {
  index: number;
  address: number;
  noiseSamples: FlameSample[];
  noiseRawSamples: FlameSample[];
  interferenceSamples: Record<InterferenceStage, FlameSample[]>;
  latest: LatestUnitState;
  stageRatios: Record<InterferenceStage, { snr21: number | null; snr23: number | null; snr31: number | null }>;
  lastEventKey: string;
  lastNoiseSamples: FlameSample[];
  lastNoiseRawSamples: FlameSample[];
  noiseAcceptedFrameCount: number;
  noiseRejectedFrameCount: number;
  noiseFirstFrameAt: number | null;
  noiseLastFrameAt: number | null;
  noiseMaxGapMs: number;
  noiseTotalSampleCount: number;
  noiseTotalRawSampleCount: number;
}

interface Statistics {
  rms: number;
  peakToPeak: number;
  means: Partial<Record<ChannelKey, number>>;
}

function emptyHeatStageTimings(): HeatStageTimings {
  return {
    stabilizationStartedAt: null,
    stabilizationEndedAt: null,
    noiseStartedAt: null,
    noiseEndedAt: null,
    interferenceStartedAt: null,
    interferenceEndedAt: null,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeConfig(config?: Partial<WaveformAnalysisConfig>): WaveformAnalysisConfig {
  const validKeys = new Set(CHANNEL_KEYS);
  const probes = (value: unknown, fallback: ChannelKey[]) => Array.isArray(value)
    ? value.filter((key): key is ChannelKey => validKeys.has(key as ChannelKey))
    : fallback;
  const ratio = config?.interferenceRatio as { numerator?: ChannelKey; denominator?: ChannelKey } | undefined;
  return {
    minNoiseSamples: positiveInteger(config?.minNoiseSamples, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minNoiseSamples),
    minInterferenceSamples: positiveInteger(config?.minInterferenceSamples, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minInterferenceSamples),
    minNoiseRms: nonNegativeNumber(config?.minNoiseRms, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minNoiseRms),
    maxNoiseRms: nonNegativeNumber(config?.maxNoiseRms, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxNoiseRms),
    maxNoiseAbsolute: nonNegativeNumber(config?.maxNoiseAbsolute, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxNoiseAbsolute!),
    maxInterferenceRatio: nonNegativeNumber(config?.maxInterferenceRatio, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxInterferenceRatio),
    noiseProbes: probes(config?.noiseProbes, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.noiseProbes!),
    interferenceRatio: ratio && validKeys.has(ratio.numerator as ChannelKey) && validKeys.has(ratio.denominator as ChannelKey)
      ? { numerator: ratio.numerator!, denominator: ratio.denominator! } : DEFAULT_WAVEFORM_ANALYSIS_CONFIG.interferenceRatio,
    consistencyProbes: probes(config?.consistencyProbes, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.consistencyProbes!),
    minConsistencyTrend: Math.min(1, Math.max(0, nonNegativeNumber(config?.minConsistencyTrend, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minConsistencyTrend!))),
    quality: normalizeDetectionQualityConfig(config?.quality),
  };
}

function usableSamples(samples: FlameSample[]): FlameSample[] {
  return (Array.isArray(samples) ? samples : []).filter((sample) => CHANNEL_KEYS.some((key) => Number.isFinite(Number(sample?.[key]))));
}

function channelValues(samples: FlameSample[], key: ChannelKey): number[] {
  return samples
    .map((sample) => Number(sample[key]))
    .filter((value) => Number.isFinite(value));
}

function statistics(samples: FlameSample[], baseline?: Partial<Record<ChannelKey, number>>, selectedKeys: ChannelKey[] = CHANNEL_KEYS): Statistics | null {
  const usable = usableSamples(samples);
  if (usable.length === 0) return null;

  let squaredTotal = 0;
  let valueCount = 0;
  let peakToPeak = 0;
  const means: Partial<Record<ChannelKey, number>> = {};

  for (const key of selectedKeys) {
    const values = channelValues(usable, key);
    if (values.length === 0) continue;
    const mean = baseline?.[key] ?? values.reduce((total, value) => total + value, 0) / values.length;
    means[key] = mean;
    const min = Math.min(...values);
    const max = Math.max(...values);
    peakToPeak = Math.max(peakToPeak, max - min);
    for (const value of values) {
      squaredTotal += (value - mean) ** 2;
      valueCount += 1;
    }
  }

  return {
    rms: valueCount > 0 ? Math.sqrt(squaredTotal / valueCount) : 0,
    peakToPeak,
    means,
  };
}

function trendAgreement(samples: FlameSample[], selectedKeys: ChannelKey[]): number | null {
  if (selectedKeys.length < 2 || samples.length < 2) return null;
  let total = 0;
  let matching = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const directions = selectedKeys.map((key) => Math.sign(Number(samples[index][key]) - Number(samples[index - 1][key]))).filter(Boolean);
    if (directions.length < 2) continue;
    const positive = directions.filter((value) => value > 0).length;
    const negative = directions.length - positive;
    matching += Math.max(positive, negative) / directions.length;
    total += 1;
  }
  return total ? Number((matching / total).toFixed(3)) : null;
}

function channelAmplitude(samples: FlameSample[], key: ChannelKey): number | null {
  const values = channelValues(samples, key);
  if (!values.length) return null;
  return (Math.max(...values) - Math.min(...values)) / 2;
}

function blankLatest(address: number): LatestUnitState {
  return { address, online: false, fault: false, sourceReady: false, syncOk: false, lastUpdate: 0, seen: false };
}

function newAccumulator(index: number, address = index): UnitAccumulator {
  return {
    index,
    address,
    noiseSamples: [],
    noiseRawSamples: [],
    interferenceSamples: { heat: [], flash: [], emc: [] },
    latest: blankLatest(address),
    stageRatios: {
      heat: { snr21: null, snr23: null, snr31: null },
      flash: { snr21: null, snr23: null, snr31: null },
      emc: { snr21: null, snr23: null, snr31: null },
    },
    lastEventKey: '',
    lastNoiseSamples: [],
    lastNoiseRawSamples: [],
    noiseAcceptedFrameCount: 0,
    noiseRejectedFrameCount: 0,
    noiseFirstFrameAt: null,
    noiseLastFrameAt: null,
    noiseMaxGapMs: 0,
    noiseTotalSampleCount: 0,
    noiseTotalRawSampleCount: 0,
  };
}

function compactTimestamp(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '-';
  return `${timestamp}/${new Date(timestamp).toISOString()}`;
}

function compactNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : '-';
}

function compactProbeSummary(samples: FlameSample[], includeFluctuation: boolean): string {
  const usable = usableSamples(samples);
  return CHANNEL_KEYS.map((key) => {
    const values = channelValues(usable, key);
    if (values.length === 0) return `${key.replace('probe', 'P')}{n=0}`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const fluctuation = (max - min) / 2;
    const absolute = Math.max(...values.map((value) => Math.abs(value)));
    const fields = [
      `n=${values.length}`,
      `min=${compactNumber(min)}`,
      `max=${compactNumber(max)}`,
      `last=${compactNumber(values.at(-1)!)}`,
    ];
    if (includeFluctuation) {
      fields.push(`fluct=${compactNumber(fluctuation)}`, `abs=${compactNumber(absolute)}`);
    }
    return `${key.replace('probe', 'P')}{${fields.join(',')}}`;
  }).join(';');
}

function finiteRatio(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sampleFingerprint(samples: FlameSample[]): string {
  const last = samples[samples.length - 1];
  return last ? CHANNEL_KEYS.map((key) => String(last[key] ?? '')).join(',') : 'empty';
}

function acceptedQuality(config: WaveformAnalysisConfig): { limits: DetectionQualityThresholds; ratios: DetectionRatioThresholds } {
  const quality = config.quality ?? DEFAULT_DETECTION_QUALITY_CONFIG;
  const grade = quality.acceptanceGrade === 'A' ? 'a' : 'b';
  return { limits: quality[grade], ratios: quality.ratios[grade] };
}

function noiseFailureReason(
  noise: Statistics | null,
  noiseMetrics: Record<ChannelKey, WaveformChannelMetrics>,
  noiseMetricSamples: FlameSample[],
  noiseKeys: ChannelKey[],
  config: WaveformAnalysisConfig,
): string | undefined {
  if (!noise) return undefined;
  const { limits } = acceptedQuality(config);
  for (const key of noiseKeys) {
    if (channelValues(noiseMetricSamples, key).length === 0) continue;
    const metrics = noiseMetrics[key];
    if (config.minNoiseRms > 0 && metrics.fluctuation < config.minNoiseRms) return 'NOISE_RMS_BELOW_LIMIT';
    if (limits.maxNoiseRms > 0 && metrics.fluctuation > limits.maxNoiseRms) return 'NOISE_RMS_EXCEEDS_LIMIT';
    if (limits.maxNoiseAbsolute != null && limits.maxNoiseAbsolute > 0 && metrics.absolute > limits.maxNoiseAbsolute) {
      return 'NOISE_ABSOLUTE_EXCEEDS_LIMIT';
    }
  }
  return undefined;
}

function stageFailureReason(
  metrics: Pick<InterferenceStageResult, 'interferenceRatio' | 'consistencyTrend' | 'snr21' | 'snr23' | 'snr31'>,
  config: WaveformAnalysisConfig,
): string | undefined {
  const { limits, ratios } = acceptedQuality(config);
  if (limits.maxInterferenceRatio > 0) {
    if (metrics.interferenceRatio == null) return 'INTERFERENCE_RATIO_MISSING';
    if (metrics.interferenceRatio > limits.maxInterferenceRatio) return 'INTERFERENCE_RATIO_EXCEEDS_LIMIT';
  }
  if ((limits.minConsistencyTrend ?? 0) > 0) {
    if (metrics.consistencyTrend == null) return 'CONSISTENCY_TREND_MISSING';
    if (metrics.consistencyTrend < limits.minConsistencyTrend!) return 'CONSISTENCY_TREND_BELOW_LIMIT';
  }
  const snrRanges: Array<[keyof Pick<InterferenceStageResult, 'snr21' | 'snr23' | 'snr31'>, DetectionSNRRange, string]> = [
    ['snr21', ratios.snr21, 'SNR21'],
    ['snr23', ratios.snr23, 'SNR23'],
    ['snr31', ratios.snr31, 'SNR31'],
  ];
  for (const [key, range, label] of snrRanges) {
    const value = metrics[key];
    if (range.min > 0 || range.max > 0) {
      if (value == null) return `${label}_MISSING`;
      if (range.min > 0 && value < range.min) return `${label}_BELOW_LIMIT`;
      if (range.max > 0 && value > range.max) return `${label}_ABOVE_LIMIT`;
    }
  }
  return undefined;
}

function publicUnitResult(
  accumulator: UnitAccumulator,
  phase: WaveformAnalysisPhase,
  hasBatch: boolean,
  config: WaveformAnalysisConfig,
  noiseCompleted: boolean,
  completedStages: ReadonlySet<InterferenceStage>,
): WaveformAnalysisUnitResult {
  const noiseSamples = usableSamples(accumulator.noiseSamples);
  const noiseRawSamples = usableSamples(accumulator.noiseRawSamples);
  const stageSamples = Object.fromEntries((['heat', 'flash', 'emc'] as InterferenceStage[])
    .map((stage) => [stage, usableSamples(accumulator.interferenceSamples[stage])])) as Record<InterferenceStage, FlameSample[]>;
  const interferenceSamples = [...stageSamples.heat, ...stageSamples.flash, ...stageSamples.emc];
  const noiseKeys = config.noiseProbes?.length ? config.noiseProbes : CHANNEL_KEYS.slice(0, 3);
  const noise = statistics(noiseSamples, undefined, noiseKeys);
  const noiseAbsolute = noiseSamples.length ? Number(Math.max(...noiseSamples.flatMap((sample) => noiseKeys.map((key) => Math.abs(Number(sample[key]))).filter(Number.isFinite))).toFixed(3)) : null;
  const noiseMetricSamples = noiseRawSamples.length ? noiseRawSamples : noiseSamples;
  const noiseMetrics = summarizeWaveformChannels(noiseMetricSamples);
  const noiseTestComplete = noiseCompleted || phase === 'COMPLETE';
  const noiseFailure = noiseSamples.length < config.minNoiseSamples
    ? 'NOISE_SAMPLES_MISSING'
    : noiseFailureReason(noise, noiseMetrics, noiseMetricSamples, noiseKeys, config);
  const noiseTest: NoiseTestResult = {
    verdict: noiseTestComplete ? noiseFailure ? 'FAIL' : 'PASS' : 'PENDING',
    reason: !hasBatch
      ? 'WAITING_FOR_PROCESS_START'
      : noiseTestComplete
        ? noiseFailure ?? 'NOISE_WITHIN_LIMIT'
        : noiseSamples.length < config.minNoiseSamples ? 'WAITING_FOR_NOISE_SAMPLES' : 'WAITING_FOR_NOISE_WINDOW_COMPLETE',
    sampleCount: noiseSamples.length,
    metrics: noiseMetrics,
  };
  const interference = noise ? statistics(interferenceSamples, noise.means, noiseKeys) : null;
  const ratioConfig = config.interferenceRatio ?? { numerator: 'probe2' as ChannelKey, denominator: 'probe3' as ChannelKey };
  const numerator = channelAmplitude(interferenceSamples, ratioConfig.numerator);
  const denominator = channelAmplitude(interferenceSamples, ratioConfig.denominator);
  const stages = Object.fromEntries((['heat', 'flash', 'emc'] as InterferenceStage[]).map((stage) => {
    const samples = stageSamples[stage];
    const stageNumerator = channelAmplitude(samples, ratioConfig.numerator);
    const stageDenominator = channelAmplitude(samples, ratioConfig.denominator);
    const enough = samples.length >= config.minInterferenceSamples;
    const interferenceRatio = stageNumerator !== null && stageDenominator !== null && stageDenominator > 0
      ? Number((stageNumerator / stageDenominator).toFixed(3)) : null;
    const stageMetrics = {
      interferenceRatio,
      consistencyTrend: trendAgreement(samples, config.consistencyProbes?.length ? config.consistencyProbes : CHANNEL_KEYS.slice(0, 3)),
      ...accumulator.stageRatios[stage],
    };
    const completed = completedStages.has(stage) || phase === 'COMPLETE';
    const failure = enough ? stageFailureReason(stageMetrics, config) : 'SAMPLES_MISSING';
    return [stage, {
      completed,
      verdict: completed ? failure ? 'FAIL' : 'PASS' : 'PENDING',
      reason: completed
        ? failure ?? 'STAGE_WITHIN_LIMIT'
        : enough ? 'WAITING_FOR_PROCESS_COMPLETE' : 'WAITING_FOR_STAGE_SAMPLES',
      sampleCount: samples.length,
      ...stageMetrics,
    } satisfies InterferenceStageResult];
  })) as Record<InterferenceStage, InterferenceStageResult>;
  const result: WaveformAnalysisUnitResult = {
    index: accumulator.index,
    address: accumulator.address,
    phase,
    verdict: 'PENDING',
    noiseRms: noise ? Number(noise.rms.toFixed(3)) : null,
    noisePeakToPeak: noise ? Number((noise.peakToPeak / 2).toFixed(3)) : null,
    noiseAbsolute,
    interferenceRms: interference ? Number(interference.rms.toFixed(3)) : null,
    interferenceRatio: numerator !== null && denominator !== null && denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null,
    consistencyTrend: trendAgreement(interferenceSamples, config.consistencyProbes?.length ? config.consistencyProbes : CHANNEL_KEYS.slice(0, 3)),
    ...accumulator.stageRatios.heat,
    noiseSampleCount: noiseSamples.length,
    noiseTest,
    interferenceSampleCount: interferenceSamples.length,
    stages,
    sampledAt: accumulator.latest.lastUpdate,
    ...(accumulator.latest.startup ? { startup: { ...accumulator.latest.startup } } : {}),
  };

  if (!hasBatch) {
    result.reason = 'WAITING_FOR_PROCESS_START';
    return result;
  }
  if (noiseSamples.length < config.minNoiseSamples) {
    result.verdict = phase === 'COMPLETE' ? 'FAIL' : 'PENDING';
    result.reason = phase === 'COMPLETE' ? 'NOISE_SAMPLES_MISSING' : 'WAITING_FOR_NOISE_SAMPLES';
    return result;
  }
  if (noiseTestComplete && noiseFailure) {
    result.verdict = 'FAIL';
    result.reason = noiseFailure;
    return result;
  }
  const missingStage = (['heat', 'flash', 'emc'] as InterferenceStage[])
    .find((stage) => stages[stage].sampleCount < config.minInterferenceSamples);
  if (missingStage) {
    result.verdict = phase === 'COMPLETE' ? 'FAIL' : 'PENDING';
    result.reason = phase === 'COMPLETE' ? `${missingStage.toUpperCase()}_SAMPLES_MISSING` : 'WAITING_FOR_INTERFERENCE_SAMPLES';
    return result;
  }
  if (phase !== 'COMPLETE') {
    result.reason = 'WAITING_FOR_PROCESS_COMPLETE';
    return result;
  }
  // Return-home commonly removes detector power before the PLC latches COMPLETE.
  // Complete stage samples are authoritative; a terminal offline snapshot must
  // not overwrite an otherwise complete inspection.
  if (accumulator.latest.fault) {
    result.verdict = 'FAIL';
    result.reason = 'DETECTOR_FAULT';
    return result;
  }
  result.verdict = 'PASS';
  result.reason = 'WAVEFORM_WITHIN_LIMIT';
  return result;
}

export class FieldWaveformAnalysis {
  private config: WaveformAnalysisConfig;
  private readonly units = new Map<number, UnitAccumulator>();
  private batchSequence = 0;
  private batchId: string | null = null;
  private phase: WaveformAnalysisPhase = 'IDLE';
  private processStage: PLCProcessStatus['processStage'] | null = null;
  private heatSubstage: PLCHeatSubstage = 'IDLE';
  private heatStageTimings: HeatStageTimings = emptyHeatStageTimings();
  private startedAt: number | null = null;
  private updatedAt = 0;
  private capturePhase: Extract<WaveformAnalysisPhase, 'NOISE' | 'INTERFERENCE'> | null = null;
  private captureStage: InterferenceStage | null = null;
  private readonly completedStages = new Set<InterferenceStage>();
  private noiseCaptureActive = false;
  private noiseStartedAt: number | null = null;
  private noiseEndedAt: number | null = null;
  private noiseWindowOpenedAt: number | null = null;
  private noiseCompleted = false;
  private noiseNextTrendLogAt: number | null = null;
  private automaticRunActive = false;

  constructor(config?: Partial<WaveformAnalysisConfig>, logger?: WaveformAnalysisLogger) {
    this.config = normalizeConfig(config);
    this.log = logger ?? (() => undefined);
    for (let index = 1; index <= 6; index += 1) this.units.set(index, newAccumulator(index));
  }

  private readonly log: WaveformAnalysisLogger;

  private logNoiseWindowStart(timestamp: number): void {
    this.log(
      `[噪声窗口] 开始 batch=${this.batchId ?? '-'} plcOpenAt=${compactTimestamp(this.noiseWindowOpenedAt)} `
      + `captureStartAt=${compactTimestamp(timestamp)} stabilizationWaitMs=${UPPER_COMPUTER_SIGNAL_STABILIZATION_WAIT_MS}`,
    );
  }

  private logPLCNoiseWindowBoundary(kind: '开启' | '关闭', timestamp: number, reason?: string): void {
    this.log(
      `[噪声窗口][PLC] ${kind} batch=${this.batchId ?? '-'} at=${compactTimestamp(timestamp)}`
      + (reason ? ` reason=${reason}` : ''),
    );
  }

  private logNoiseWindowTrend(timestamp: number): void {
    const devices = Array.from(this.units.values())
      .sort((a, b) => a.index - b.index)
      .map((accumulator) => {
        const ageMs = accumulator.noiseLastFrameAt === null ? '-' : Math.max(0, timestamp - accumulator.noiseLastFrameAt);
        return `D${accumulator.index}{frames=${accumulator.noiseAcceptedFrameCount},reject=${accumulator.noiseRejectedFrameCount},`
          + `samples=${accumulator.noiseTotalSampleCount}/${accumulator.noiseSamples.length},ageMs=${ageMs},maxGapMs=${accumulator.noiseMaxGapMs},`
          + `ready=${accumulator.latest.sourceReady ? 1 : 0},sync=${accumulator.latest.syncOk ? 1 : 0},`
          + `N[${compactProbeSummary(accumulator.lastNoiseSamples, false)}]}`;
      })
      .join(' ');
    this.log(`[噪声窗口][每秒] at=${compactTimestamp(timestamp)} ${devices}`);
  }

  private logNoiseWindowEnd(timestamp: number, reason: string, plcOpenAt: number | null): void {
    const durationMs = this.noiseStartedAt === null ? '-' : Math.max(0, timestamp - this.noiseStartedAt);
    this.log(
      `[噪声窗口] 结束 batch=${this.batchId ?? '-'} reason=${reason} plcOpenAt=${compactTimestamp(plcOpenAt)} `
      + `captureStartAt=${compactTimestamp(this.noiseStartedAt)} captureEndAt=${compactTimestamp(timestamp)} durationMs=${durationMs}`,
    );
    for (const accumulator of Array.from(this.units.values()).sort((a, b) => a.index - b.index)) {
      const ageMs = accumulator.noiseLastFrameAt === null ? '-' : Math.max(0, timestamp - accumulator.noiseLastFrameAt);
      this.log(
        `[噪声窗口][D${accumulator.index}] frames=${accumulator.noiseAcceptedFrameCount},reject=${accumulator.noiseRejectedFrameCount},`
        + `samples=${accumulator.noiseTotalSampleCount}/${accumulator.noiseSamples.length},rawSamples=${accumulator.noiseTotalRawSampleCount}/${accumulator.noiseRawSamples.length},`
        + `firstFrameAt=${compactTimestamp(accumulator.noiseFirstFrameAt)},lastFrameAt=${compactTimestamp(accumulator.noiseLastFrameAt)},`
        + `ageMs=${ageMs},maxGapMs=${accumulator.noiseMaxGapMs},ready=${accumulator.latest.sourceReady ? 1 : 0},sync=${accumulator.latest.syncOk ? 1 : 0} `
        + `N[${compactProbeSummary(accumulator.noiseSamples, true)}] R[${compactProbeSummary(accumulator.noiseRawSamples, true)}]`,
      );
    }
  }

  updateConfig(config?: Partial<WaveformAnalysisConfig>): void {
    this.config = normalizeConfig({
      ...this.config,
      ...config,
      quality: normalizeDetectionQualityConfig(config?.quality, this.config.quality),
    });
  }

  observeProcess(status: PLCProcessStatus): void {
    const stage = status.processStage;
    const explicitNoiseCapture = status.io?.internal?.noiseCaptureWindow === true;
    const activeInterferenceStage: InterferenceStage | null = status.io?.steps?.stepM10_4 === true
      ? 'heat' : status.io?.steps?.stepM11_0 === true
        ? 'flash' : status.io?.steps?.stepM11_2 === true ? 'emc' : null;
    const previousCaptureStage = this.captureStage;
    const previousNoiseCaptureActive = this.noiseCaptureActive;
    const previousNoiseWindowOpenedAt = this.noiseWindowOpenedAt;
    const noiseWindowJustOpened = explicitNoiseCapture && this.noiseWindowOpenedAt === null;
    const noiseWindowOpenedAt = explicitNoiseCapture
      ? this.noiseWindowOpenedAt ?? status.timestamp
      : null;
    const noiseCaptureActive = explicitNoiseCapture
      && noiseWindowOpenedAt !== null
      && status.timestamp - noiseWindowOpenedAt >= UPPER_COMPUTER_SIGNAL_STABILIZATION_WAIT_MS;
    const currentHeatSubstage: PLCHeatSubstage = activeInterferenceStage === 'heat'
      ? 'HEAT_INTERFERENCE'
      : noiseCaptureActive
        ? 'NOISE_CAPTURE'
        : explicitNoiseCapture
          ? 'SIGNAL_STABILIZATION'
          : status.io?.internal?.signalStabilizing === true
            ? 'SIGNAL_STABILIZATION'
            : status.heatSubstage ?? 'IDLE';
    const processComplete = isPLCProcessComplete(status);
    const noiseCaptureEnded = previousNoiseCaptureActive && !noiseCaptureActive;
    const plcWindowClosedWithoutCapture = !explicitNoiseCapture
      && previousNoiseWindowOpenedAt !== null
      && !previousNoiseCaptureActive;
    const noiseEndReason = processComplete
      ? 'PROCESS_COMPLETE'
      : activeInterferenceStage
        ? 'INTERFERENCE_STAGE_STARTED'
        : explicitNoiseCapture
          ? 'CAPTURE_GATE_CLOSED'
          : 'PLC_WINDOW_CLOSED';
    const automaticRunActive = status.autoRunning || status.io?.internal?.autoRunning === true;
    const automaticRunStarted = automaticRunActive && !this.automaticRunActive;
    this.automaticRunActive = automaticRunActive;
    const canStartBatch = stage !== 'RETURN_HOME' && stage !== 'COMPLETE' && status.stage !== 'FAULT';
    if (canStartBatch && (automaticRunStarted || (!this.batchId && explicitNoiseCapture))) this.startBatch(status.timestamp);
    this.noiseWindowOpenedAt = noiseWindowOpenedAt;
    if (noiseWindowJustOpened) this.logPLCNoiseWindowBoundary('开启', status.timestamp);

    this.processStage = stage;
    this.updatedAt = status.timestamp;
    this.capturePhase = null;
    this.captureStage = null;
    if (!this.batchId) {
      this.heatSubstage = currentHeatSubstage;
      this.noiseCaptureActive = noiseCaptureActive;
      if (noiseCaptureActive && this.noiseStartedAt === null) this.noiseStartedAt = status.timestamp;
      return;
    }
    this.updateHeatStageTimings(currentHeatSubstage, status.timestamp);
    if (noiseCaptureActive && !previousNoiseCaptureActive && this.noiseStartedAt === null) {
      this.noiseStartedAt = status.timestamp;
      this.noiseNextTrendLogAt = status.timestamp + NOISE_TREND_LOG_INTERVAL_MS;
      this.logNoiseWindowStart(status.timestamp);
    }
    if (noiseCaptureEnded) {
      this.noiseCompleted = true;
      if (this.noiseEndedAt === null) this.noiseEndedAt = status.timestamp;
      this.noiseNextTrendLogAt = null;
      this.logNoiseWindowEnd(status.timestamp, noiseEndReason, previousNoiseWindowOpenedAt);
    }
    if (plcWindowClosedWithoutCapture) {
      this.logPLCNoiseWindowBoundary('关闭', status.timestamp, 'CAPTURE_NOT_STARTED');
    }
    if (previousCaptureStage && previousCaptureStage !== activeInterferenceStage) this.completedStages.add(previousCaptureStage);
    if (processComplete) {
      this.phase = 'COMPLETE';
      this.noiseCompleted = true;
      if (this.noiseStartedAt !== null && this.noiseEndedAt === null) this.noiseEndedAt = status.timestamp;
      this.closeOpenHeatStageTimings(status.timestamp);
      for (const captureStage of ['heat', 'flash', 'emc'] as InterferenceStage[]) this.completedStages.add(captureStage);
    } else if (noiseCaptureActive && this.phase !== 'INTERFERENCE' && this.phase !== 'COMPLETE') {
      this.phase = 'NOISE';
      this.capturePhase = 'NOISE';
    } else if (activeInterferenceStage && this.phase !== 'COMPLETE') {
      this.phase = 'INTERFERENCE';
      this.capturePhase = 'INTERFERENCE';
      this.captureStage = activeInterferenceStage;
    }
    this.noiseCaptureActive = !processComplete && noiseCaptureActive;
  }

  observeDetectors(state: FlameDetectorState): void {
    this.updatedAt = state.timestamp;
    for (const unit of state.units) {
      const accumulator = this.units.get(unit.index) ?? newAccumulator(unit.index, unit.address);
      accumulator.address = unit.address;
      accumulator.latest = latestFromUnit(unit);
      this.units.set(unit.index, accumulator);
      const capturingNoise = this.batchId !== null && this.capturePhase === 'NOISE';
      if (
        !this.batchId
        || !this.capturePhase
        || !unit.online
        || !unit.sourceReady
        || !unit.syncOk
      ) {
        if (capturingNoise) accumulator.noiseRejectedFrameCount += 1;
        continue;
      }

      // The service's normalized samples remove the detector carrier/baseline
      // (for example the signed 0x8001 marker). Raw samples remain a fallback
      // for producers that do not expose normalized waveform data.
      const normalizedSamples = usableSamples(unit.samples ?? []);
      const rawSamples = usableSamples(unit.rawSamples ?? []);
      const samples = normalizedSamples.length > 0 ? normalizedSamples : rawSamples;
      const capturedRawSamples = rawSamples.length > 0 ? rawSamples : samples;
      const eventKey = `${state.timestamp}:${unit.lastUpdate}:${samples.length}:${sampleFingerprint(samples)}`;
      if (eventKey === accumulator.lastEventKey) continue;
      accumulator.lastEventKey = eventKey;
      if (this.capturePhase === 'NOISE') {
        accumulator.noiseSamples.push(...samples);
        accumulator.noiseRawSamples.push(...capturedRawSamples);
        accumulator.noiseTotalSampleCount += samples.length;
        accumulator.noiseTotalRawSampleCount += capturedRawSamples.length;
        const frameAt = Number.isFinite(unit.lastUpdate) && unit.lastUpdate > 0 ? unit.lastUpdate : state.timestamp;
        if (accumulator.noiseLastFrameAt !== null) {
          accumulator.noiseMaxGapMs = Math.max(accumulator.noiseMaxGapMs, Math.max(0, frameAt - accumulator.noiseLastFrameAt));
        }
        accumulator.noiseFirstFrameAt ??= frameAt;
        accumulator.noiseLastFrameAt = frameAt;
        accumulator.lastNoiseSamples = samples;
        accumulator.lastNoiseRawSamples = capturedRawSamples;
        accumulator.noiseAcceptedFrameCount += 1;
      }
      if (this.capturePhase === 'INTERFERENCE' && this.captureStage) {
        accumulator.interferenceSamples[this.captureStage].push(...samples);
        const feature = unit.features?.[0];
        accumulator.stageRatios[this.captureStage] = {
          snr21: finiteRatio(unit.snr21 ?? feature?.snr21),
          snr23: finiteRatio(unit.snr23 ?? feature?.snr23),
          snr31: finiteRatio(unit.snr31 ?? feature?.snr31),
        };
      }
      accumulator.noiseSamples = accumulator.noiseSamples.slice(-2_000);
      accumulator.noiseRawSamples = accumulator.noiseRawSamples.slice(-2_000);
      for (const stage of ['heat', 'flash', 'emc'] as InterferenceStage[]) {
        accumulator.interferenceSamples[stage] = accumulator.interferenceSamples[stage].slice(-2_000);
      }
    }
    if (this.capturePhase === 'NOISE' && this.noiseNextTrendLogAt !== null && state.timestamp >= this.noiseNextTrendLogAt) {
      this.logNoiseWindowTrend(state.timestamp);
      do {
        this.noiseNextTrendLogAt += NOISE_TREND_LOG_INTERVAL_MS;
      } while (this.noiseNextTrendLogAt <= state.timestamp);
    }
  }

  snapshot(): FieldWaveformAnalysisSnapshot {
    const units = Array.from(this.units.values())
      .sort((a, b) => a.index - b.index)
      .map((unit) => publicUnitResult(unit, this.phase, Boolean(this.batchId), this.config, this.noiseCompleted, this.completedStages));
    const verdict: WaveformAnalysisVerdict = units.some((unit) => unit.verdict === 'FAIL')
      ? 'FAIL'
      : units.length === 6 && units.every((unit) => unit.verdict === 'PASS')
        ? 'PASS'
        : 'PENDING';
    return {
      batchId: this.batchId,
      phase: this.phase,
      processStage: this.processStage,
      heatSubstage: this.heatSubstage,
      heatSubstageLabel: PLC_HEAT_SUBSTAGE_LABELS[this.heatSubstage],
      heatStageTimings: { ...this.heatStageTimings },
      verdict,
      startedAt: this.startedAt,
      noiseCaptureActive: this.noiseCaptureActive,
      noiseStartedAt: this.noiseStartedAt,
      noiseEndedAt: this.noiseEndedAt,
      updatedAt: this.updatedAt,
      thresholds: { ...this.config },
      units,
    };
  }

  private startBatch(timestamp: number): void {
    const startedAt = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
    this.batchSequence += 1;
    this.batchId = `field-waveform-${startedAt}-${this.batchSequence}`;
    this.phase = 'NOISE';
    this.capturePhase = 'NOISE';
    this.captureStage = null;
    this.heatSubstage = 'IDLE';
    this.heatStageTimings = emptyHeatStageTimings();
    this.completedStages.clear();
    this.noiseCaptureActive = false;
    this.noiseStartedAt = null;
    this.noiseEndedAt = null;
    this.noiseWindowOpenedAt = null;
    this.noiseCompleted = false;
    this.noiseNextTrendLogAt = null;
    this.startedAt = startedAt;
    for (let index = 1; index <= 6; index += 1) this.units.set(index, newAccumulator(index));
  }

  private updateHeatStageTimings(substage: PLCHeatSubstage, timestamp: number): void {
    const previous = this.heatSubstage;
    if (previous === substage) return;
    if (previous === 'SIGNAL_STABILIZATION' && this.heatStageTimings.stabilizationStartedAt !== null && this.heatStageTimings.stabilizationEndedAt === null) {
      this.heatStageTimings.stabilizationEndedAt = timestamp;
    }
    if (previous === 'NOISE_CAPTURE' && this.heatStageTimings.noiseStartedAt !== null && this.heatStageTimings.noiseEndedAt === null) {
      this.heatStageTimings.noiseEndedAt = timestamp;
      if (this.noiseEndedAt === null) this.noiseEndedAt = timestamp;
    }
    if (previous === 'HEAT_INTERFERENCE' && this.heatStageTimings.interferenceStartedAt !== null && this.heatStageTimings.interferenceEndedAt === null) {
      this.heatStageTimings.interferenceEndedAt = timestamp;
    }
    if (substage === 'SIGNAL_STABILIZATION' && this.heatStageTimings.stabilizationStartedAt === null) {
      this.heatStageTimings.stabilizationStartedAt = timestamp;
    }
    if (substage === 'NOISE_CAPTURE' && this.heatStageTimings.noiseStartedAt === null) {
      this.heatStageTimings.noiseStartedAt = timestamp;
    }
    if (substage === 'HEAT_INTERFERENCE' && this.heatStageTimings.interferenceStartedAt === null) {
      this.heatStageTimings.interferenceStartedAt = timestamp;
    }
    this.heatSubstage = substage;
  }

  private closeOpenHeatStageTimings(timestamp: number): void {
    if (this.heatStageTimings.stabilizationStartedAt !== null && this.heatStageTimings.stabilizationEndedAt === null) {
      this.heatStageTimings.stabilizationEndedAt = timestamp;
    }
    if (this.heatStageTimings.noiseStartedAt !== null && this.heatStageTimings.noiseEndedAt === null) {
      this.heatStageTimings.noiseEndedAt = timestamp;
    }
    if (this.heatStageTimings.interferenceStartedAt !== null && this.heatStageTimings.interferenceEndedAt === null) {
      this.heatStageTimings.interferenceEndedAt = timestamp;
    }
  }
}

function latestFromUnit(unit: FlameDetectorUnitState): LatestUnitState {
  return {
    address: unit.address,
    online: unit.online,
    fault: unit.fault,
    sourceReady: unit.sourceReady,
    syncOk: unit.syncOk,
    lastUpdate: unit.lastUpdate,
    seen: true,
    ...(unit.startup ? { startup: { ...unit.startup } } : {}),
  };
}
