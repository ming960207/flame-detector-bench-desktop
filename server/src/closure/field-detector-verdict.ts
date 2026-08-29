import type { FlameDetectorState, FlameDetectorUnitState } from '../types.js';
import { DEFAULT_DETECTION_QUALITY_CONFIG } from './field-waveform-analysis.js';
import type {
  ChannelKey,
  DetectionRatioThresholds,
  DetectionQualityConfig,
  DetectionQualityThresholds,
  FieldWaveformAnalysisSnapshot,
  InterferenceStage,
  WaveformAnalysisUnitResult,
} from './field-waveform-analysis.js';

export type FieldDetectorVerdict = 'PASS' | 'FAIL' | 'PENDING';
export type FieldQualityGrade = 'A_PASS' | 'B_PASS' | 'FAIL' | 'PENDING';

export interface FieldDetectorMetrics {
  noiseRms: number | null;
  noisePeakToPeak: number | null;
  noiseAbsolute: number | null;
  interferenceRatio: number | null;
  consistencyTrend: number | null;
  snr21: number | null;
  snr23: number | null;
  snr31: number | null;
  sensitivity: number | null;
}

export interface FieldDetectorResult {
  index: number;
  address: number;
  verdict: FieldDetectorVerdict;
  grade: FieldQualityGrade;
  reason?: string;
  sampledAt: number;
  metrics: FieldDetectorMetrics;
}

export interface FieldDetectorBatchVerdict {
  verdict: FieldDetectorVerdict;
  grade: FieldQualityGrade;
  units: FieldDetectorResult[];
  timestamp: number;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function detectorMetrics(unit: FlameDetectorUnitState, analysis?: WaveformAnalysisUnitResult): FieldDetectorMetrics {
  const feature = unit.features?.[0];
  return {
    noiseRms: finiteOrNull(analysis?.noiseRms),
    noisePeakToPeak: finiteOrNull(analysis?.noisePeakToPeak),
    noiseAbsolute: finiteOrNull(analysis?.noiseAbsolute),
    interferenceRatio: finiteOrNull(analysis?.interferenceRatio),
    consistencyTrend: finiteOrNull(analysis?.consistencyTrend),
    snr21: finiteOrNull(analysis?.snr21 ?? unit.snr21 ?? feature?.snr21),
    snr23: finiteOrNull(analysis?.snr23 ?? unit.snr23 ?? feature?.snr23),
    snr31: finiteOrNull(analysis?.snr31 ?? unit.snr31 ?? feature?.snr31),
    sensitivity: finiteOrNull(unit.sensitivity),
  };
}

function thresholdMatches(
  metrics: FieldDetectorMetrics,
  limits: DetectionQualityThresholds,
  ratios: DetectionRatioThresholds,
): string | undefined {
  const upperBounds: Array<[keyof Pick<FieldDetectorMetrics, 'noiseRms' | 'noiseAbsolute' | 'interferenceRatio'>, number | undefined, string]> = [
    ['noiseRms', limits.maxNoiseRms, 'NOISE_RMS_EXCEEDS_LIMIT'],
    ['noiseAbsolute', limits.maxNoiseAbsolute, 'NOISE_ABSOLUTE_EXCEEDS_LIMIT'],
    ['interferenceRatio', limits.maxInterferenceRatio, 'INTERFERENCE_RATIO_EXCEEDS_LIMIT'],
  ];
  for (const [key, limit, reason] of upperBounds) {
    if (limit == null || limit <= 0) continue;
    const value = metrics[key];
    if (value === null) return `${key.toUpperCase()}_MISSING`;
    if (value > limit) return reason;
  }

  if ((limits.minConsistencyTrend ?? 0) > 0) {
    if (metrics.consistencyTrend === null) return 'CONSISTENCY_TREND_MISSING';
    if (metrics.consistencyTrend < limits.minConsistencyTrend!) return 'CONSISTENCY_TREND_BELOW_LIMIT';
  }

  const snrRanges: Array<[keyof Pick<FieldDetectorMetrics, 'snr21' | 'snr23' | 'snr31'>, DetectionRatioThresholds[keyof DetectionRatioThresholds], string]> = [
    ['snr21', ratios.snr21, 'SNR21'],
    ['snr23', ratios.snr23, 'SNR23'],
    ['snr31', ratios.snr31, 'SNR31'],
  ];
  for (const [key, range, label] of snrRanges) {
    const value = metrics[key];
    if (range.min > 0 || range.max > 0) {
      if (value === null) return `${key.toUpperCase()}_MISSING`;
      if (range.min > 0 && value < range.min) return `${label}_BELOW_LIMIT`;
      if (range.max > 0 && value > range.max) return `${label}_ABOVE_LIMIT`;
    }
  }

  if (limits.minSensitivity > 0) {
    const value = metrics.sensitivity;
    if (value === null) return 'SENSITIVITY_MISSING';
    if (value < limits.minSensitivity) return 'SENSITIVITY_BELOW_LIMIT';
  }
  return undefined;
}

function noiseThresholdFailure(
  analysis: WaveformAnalysisUnitResult,
  minNoiseRms: number,
  limits: DetectionQualityThresholds,
  noiseProbes: ChannelKey[] | undefined,
): string | undefined {
  const noiseMetrics = analysis.noiseTest?.metrics;
  if (!noiseMetrics) return undefined;
  const keys = noiseProbes?.length ? noiseProbes : (['probe1', 'probe2', 'probe3'] as ChannelKey[]);
  for (const key of keys) {
    const metrics = noiseMetrics[key];
    if (!metrics || !Number.isFinite(metrics.fluctuation)) return 'NOISE_RMS_MISSING';
    if (minNoiseRms > 0 && metrics.fluctuation < minNoiseRms) return 'NOISE_RMS_BELOW_LIMIT';
    if (limits.maxNoiseRms > 0 && metrics.fluctuation > limits.maxNoiseRms) return 'NOISE_RMS_EXCEEDS_LIMIT';
    if (limits.maxNoiseAbsolute != null && limits.maxNoiseAbsolute > 0) {
      if (!Number.isFinite(metrics.absolute)) return 'NOISE_ABSOLUTE_MISSING';
      if (metrics.absolute > limits.maxNoiseAbsolute) return 'NOISE_ABSOLUTE_EXCEEDS_LIMIT';
    }
  }
  return undefined;
}

function result(
  base: Pick<FieldDetectorResult, 'index' | 'address' | 'sampledAt'>,
  metrics: FieldDetectorMetrics,
  verdict: FieldDetectorVerdict,
  grade: FieldQualityGrade,
  reason?: string,
): FieldDetectorResult {
  return { ...base, metrics, verdict, grade, ...(reason ? { reason } : {}) };
}

function evaluateUnit(
  unit: FlameDetectorUnitState,
  analysis: WaveformAnalysisUnitResult | undefined,
  analysisSnapshot: FieldWaveformAnalysisSnapshot | undefined,
): FieldDetectorResult {
  const base = { index: unit.index, address: unit.address, sampledAt: unit.lastUpdate };
  const metrics = detectorMetrics(unit, analysis);
  const complete = analysisSnapshot?.phase === 'COMPLETE';
  const quality = analysisSnapshot?.thresholds.quality ?? DEFAULT_DETECTION_QUALITY_CONFIG;

  if (unit.fault) return result(base, metrics, 'FAIL', 'FAIL', 'DETECTOR_FAULT');
  if (!complete || !analysis) {
    if (!unit.online) return result(base, metrics, 'PENDING', 'PENDING', 'DETECTOR_OFFLINE');
    if (!unit.sourceReady) return result(base, metrics, 'PENDING', 'PENDING', 'DETECTOR_SOURCE_NOT_READY');
    if (!unit.syncOk) return result(base, metrics, 'PENDING', 'PENDING', 'DETECTOR_SYNC_NOT_OK');
  }
  if (!analysisSnapshot) {
    // Preserve the original telemetry verdict while the process has not exposed its quality snapshot yet.
    return result(base, metrics, 'PASS', 'PENDING');
  }
  if (analysis?.verdict === 'FAIL') return result(base, metrics, 'FAIL', 'FAIL', analysis.reason || 'WAVEFORM_QUALITY_FAIL');
  if (analysisSnapshot.phase !== 'COMPLETE' || analysis?.verdict !== 'PASS') {
    return result(base, metrics, 'PENDING', 'PENDING', analysis?.reason || 'WAITING_FOR_QUANTITATIVE_DATA');
  }

  const stageMetrics = (stage: InterferenceStage): FieldDetectorMetrics => {
    const stageResult = analysis.stages?.[stage];
    return stageResult ? {
      ...metrics,
      interferenceRatio: finiteOrNull(stageResult.interferenceRatio),
      consistencyTrend: finiteOrNull(stageResult.consistencyTrend),
      snr21: finiteOrNull(stageResult.snr21),
      snr23: finiteOrNull(stageResult.snr23),
      snr31: finiteOrNull(stageResult.snr31),
    } : metrics;
  };
  const stages: InterferenceStage[] = analysis.stages ? ['heat', 'flash', 'emc'] : ['heat'];
  const firstFailure = (limits: DetectionQualityThresholds, ratios: DetectionRatioThresholds) => {
    const noiseReason = noiseThresholdFailure(
      analysis,
      analysisSnapshot.thresholds.minNoiseRms,
      limits,
      analysisSnapshot.thresholds.noiseProbes,
    );
    if (noiseReason) return noiseReason;
    for (const stage of stages) {
      const stageResult = analysis.stages?.[stage];
      if (stageResult?.verdict === 'FAIL') return `${stage.toUpperCase()}_${stageResult.reason || 'STAGE_FAIL'}`;
      const reason = thresholdMatches(stageMetrics(stage), limits, ratios);
      if (reason) return `${stage.toUpperCase()}_${reason}`;
    }
    return undefined;
  };

  const aReason = firstFailure(quality.a, quality.ratios.a);
  if (!aReason) return result(base, metrics, 'PASS', 'A_PASS', 'ALL_STAGES_A_GRADE_WITHIN_LIMIT');
  if (quality.acceptanceGrade === 'A') return result(base, metrics, 'FAIL', 'FAIL', aReason);
  const bReason = firstFailure(quality.b, quality.ratios.b);
  if (!bReason) return result(base, metrics, 'PASS', 'B_PASS', `A_GRADE_${aReason}`);
  return result(base, metrics, 'FAIL', 'FAIL', bReason);
}

/**
 * Field verdicts are derived from read-only detector telemetry and the completed
 * waveform snapshot. Completed quantitative data is graded A, B, or NG using
 * the configured limits for the corresponding detector.
 */
export function evaluateFieldDetectorBatch(
  state: FlameDetectorState,
  analysisSnapshot?: FieldWaveformAnalysisSnapshot,
): FieldDetectorBatchVerdict {
  const analysisByIndex = new Map((analysisSnapshot?.units ?? []).map((unit) => [unit.index, unit]));
  const units = state.units.map((unit) => evaluateUnit(unit, analysisByIndex.get(unit.index), analysisSnapshot));
  const grade = units.some((unit) => unit.grade === 'FAIL')
    ? 'FAIL'
    : analysisSnapshot && units.some((unit) => unit.grade === 'PENDING')
      ? 'PENDING'
      : analysisSnapshot && units.some((unit) => unit.grade === 'B_PASS')
        ? 'B_PASS'
        : analysisSnapshot
          ? 'A_PASS'
          : 'PENDING';
  return {
    verdict: grade === 'FAIL'
      ? 'FAIL'
      : grade === 'PENDING' && units.some((unit) => unit.verdict === 'PENDING')
        ? 'PENDING'
        : 'PASS',
    grade,
    units,
    timestamp: state.timestamp,
  };
}

export type { DetectionQualityConfig } from './field-waveform-analysis.js';
