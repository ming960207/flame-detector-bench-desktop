import type { FlameDetectorState, FlameDetectorUnitState } from '../types.js';
import {
  expectedProbeChannels,
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
  type ProductPrecheckUnitResult,
  type ProductType,
} from '../product-profile.js';
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
  precheck?: ProductPrecheckUnitResult;
  noDataProbes?: ChannelKey[];
}

export interface FieldDetectorBatchVerdict {
  verdict: FieldDetectorVerdict;
  grade: FieldQualityGrade;
  units: FieldDetectorResult[];
  timestamp: number;
  productType?: ProductType;
  expectedSoftwareVersion?: string;
  expectedProbeCount?: number;
  productPrecheckVerdict?: ProductPrecheckReport['verdict'] | null;
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
  expectedProbeCount: number,
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

  const snrRanges: Array<[
    keyof Pick<FieldDetectorMetrics, 'snr21' | 'snr23' | 'snr31'>,
    DetectionRatioThresholds[keyof DetectionRatioThresholds],
    string,
    number,
  ]> = [
    ['snr21', ratios.snr21, 'SNR21', 2],
    ['snr23', ratios.snr23, 'SNR23', 3],
    ['snr31', ratios.snr31, 'SNR31', 3],
  ];
  for (const [key, range, label, requiredProbeCount] of snrRanges) {
    if (expectedProbeCount < requiredProbeCount) continue;
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

function noDataProbes(
  analysis: WaveformAnalysisUnitResult | undefined,
  analysisSnapshot: FieldWaveformAnalysisSnapshot | undefined,
  expectedChannels: ChannelKey[],
): ChannelKey[] {
  const noiseTest = analysis?.noiseTest;
  const thresholds = analysisSnapshot?.thresholds;
  if (!noiseTest || !thresholds || noiseTest.sampleCount < thresholds.minNoiseSamples) return [];
  const absoluteLimit = Number(thresholds.maxNoiseAbsolute);
  const fluctuationLimit = Number(thresholds.minNoiseRms);
  if (!Number.isFinite(absoluteLimit) || absoluteLimit <= 0 || !Number.isFinite(fluctuationLimit) || fluctuationLimit < 0) return [];
  const nearUpperLimit = absoluteLimit * 0.95;
  return expectedChannels.filter((key) => {
    const metrics = noiseTest.metrics[key];
    return Boolean(
      metrics
      && Number.isFinite(metrics.absolute)
      && Number.isFinite(metrics.fluctuation)
      && metrics.absolute >= nearUpperLimit
      && metrics.fluctuation <= fluctuationLimit,
    );
  });
}

function noiseThresholdFailure(
  analysis: WaveformAnalysisUnitResult,
  minNoiseRms: number,
  limits: DetectionQualityThresholds,
  expectedChannels: ChannelKey[],
): string | undefined {
  const noiseMetrics = analysis.noiseTest?.metrics;
  if (!noiseMetrics) return undefined;
  for (const key of expectedChannels) {
    const metrics = noiseMetrics[key];
    if (!metrics || !Number.isFinite(metrics.fluctuation)) return `${key.toUpperCase()}_NOISE_RMS_MISSING`;
    if (minNoiseRms > 0 && metrics.fluctuation < minNoiseRms) return `${key.toUpperCase()}_NOISE_RMS_BELOW_LIMIT`;
    if (limits.maxNoiseRms > 0 && metrics.fluctuation > limits.maxNoiseRms) return `${key.toUpperCase()}_NOISE_RMS_EXCEEDS_LIMIT`;
    if (limits.maxNoiseAbsolute != null && limits.maxNoiseAbsolute > 0) {
      if (!Number.isFinite(metrics.absolute)) return `${key.toUpperCase()}_NOISE_ABSOLUTE_MISSING`;
      if (metrics.absolute > limits.maxNoiseAbsolute) return `${key.toUpperCase()}_NOISE_ABSOLUTE_EXCEEDS_LIMIT`;
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
  precheck?: ProductPrecheckUnitResult,
  missingProbes: ChannelKey[] = [],
): FieldDetectorResult {
  return {
    ...base,
    metrics,
    verdict,
    grade,
    ...(reason ? { reason } : {}),
    ...(precheck ? { precheck } : {}),
    ...(missingProbes.length > 0 ? { noDataProbes: missingProbes } : {}),
  };
}

function evaluateUnit(
  unit: FlameDetectorUnitState,
  analysis: WaveformAnalysisUnitResult | undefined,
  analysisSnapshot: FieldWaveformAnalysisSnapshot | undefined,
  precheck: ProductPrecheckUnitResult | undefined,
  productConfig: ProductDetectionConfig | undefined,
): FieldDetectorResult {
  const base = { index: unit.index, address: unit.address, sampledAt: unit.lastUpdate };
  const metrics = detectorMetrics(unit, analysis);
  const complete = analysisSnapshot?.phase === 'COMPLETE';
  const quality = analysisSnapshot?.thresholds.quality ?? DEFAULT_DETECTION_QUALITY_CONFIG;
  const expectedProbeCount = productConfig ? selectedProductProfile(productConfig).expectedProbeCount : Math.max(1, unit.probeCount || 3);
  const expectedChannels = expectedProbeChannels(expectedProbeCount);
  const missingProbes = noDataProbes(analysis, analysisSnapshot, expectedChannels);

  if (precheck?.verdict === 'FAIL') {
    return result(base, metrics, 'FAIL', 'FAIL', precheck.reasons[0] || 'PRODUCT_PRECHECK_FAILED', precheck, missingProbes);
  }
  if (productConfig && complete && precheck?.verdict === 'PENDING') {
    return result(base, metrics, 'FAIL', 'FAIL', 'PRODUCT_PRECHECK_NOT_COMPLETED', precheck, missingProbes);
  }
  if (productConfig && complete && !precheck) {
    return result(base, metrics, 'FAIL', 'FAIL', 'PRODUCT_PRECHECK_NOT_COMPLETED', undefined, missingProbes);
  }
  if (missingProbes.length > 0) {
    return result(base, metrics, 'FAIL', 'FAIL', `${missingProbes[0].toUpperCase()}_SIGNAL_NO_DATA`, precheck, missingProbes);
  }
  if (unit.fault) return result(base, metrics, 'FAIL', 'FAIL', 'DETECTOR_FAULT', precheck);
  if (!complete || !analysis) {
    if (!unit.online) return result(base, metrics, 'PENDING', 'PENDING', 'DETECTOR_OFFLINE', precheck);
    if (!unit.sourceReady) return result(base, metrics, 'PENDING', 'PENDING', 'DETECTOR_SOURCE_NOT_READY', precheck);
    if (!unit.syncOk) return result(base, metrics, 'PENDING', 'PENDING', 'DETECTOR_SYNC_NOT_OK', precheck);
  }
  if (!analysisSnapshot) {
    return result(base, metrics, 'PASS', 'PENDING', undefined, precheck);
  }
  if (analysis?.verdict === 'FAIL') return result(base, metrics, 'FAIL', 'FAIL', analysis.reason || 'WAVEFORM_QUALITY_FAIL', precheck);
  if (analysisSnapshot.phase !== 'COMPLETE' || analysis?.verdict !== 'PASS') {
    return result(base, metrics, 'PENDING', 'PENDING', analysis?.reason || 'WAITING_FOR_QUANTITATIVE_DATA', precheck);
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
      expectedChannels,
    );
    if (noiseReason) return noiseReason;
    for (const stage of stages) {
      const stageResult = analysis.stages?.[stage];
      if (stageResult?.verdict === 'FAIL') return `${stage.toUpperCase()}_${stageResult.reason || 'STAGE_FAIL'}`;
      const reason = thresholdMatches(stageMetrics(stage), limits, ratios, expectedProbeCount);
      if (reason) return `${stage.toUpperCase()}_${reason}`;
    }
    return undefined;
  };

  const aReason = firstFailure(quality.a, quality.ratios.a);
  if (!aReason) return result(base, metrics, 'PASS', 'A_PASS', 'ALL_STAGES_A_GRADE_WITHIN_LIMIT', precheck);
  if (quality.acceptanceGrade === 'A') return result(base, metrics, 'FAIL', 'FAIL', aReason, precheck);
  const bReason = firstFailure(quality.b, quality.ratios.b);
  if (!bReason) return result(base, metrics, 'PASS', 'B_PASS', `A_GRADE_${aReason}`, precheck);
  return result(base, metrics, 'FAIL', 'FAIL', bReason, precheck);
}

/**
 * Field verdicts are derived from read-only detector telemetry, product identity
 * precheck, and the completed waveform snapshot.
 */
export function evaluateFieldDetectorBatch(
  state: FlameDetectorState,
  analysisSnapshot?: FieldWaveformAnalysisSnapshot,
  productPrecheck?: ProductPrecheckReport | null,
  productConfig?: ProductDetectionConfig,
): FieldDetectorBatchVerdict {
  const analysisByIndex = new Map((analysisSnapshot?.units ?? []).map((unit) => [unit.index, unit]));
  const precheckByIndex = new Map((productPrecheck?.units ?? []).map((unit) => [unit.index, unit]));
  const participatingIndexes = productPrecheck?.units?.length
    ? new Set(productPrecheck.units.map((unit) => unit.index))
    : null;
  const productProfile = productConfig ? selectedProductProfile(productConfig) : null;
  const sourceUnits = participatingIndexes
    ? state.units.filter((unit) => participatingIndexes.has(unit.index))
    : state.units;
  const units = sourceUnits.map((unit) => evaluateUnit(
    unit,
    analysisByIndex.get(unit.index),
    analysisSnapshot,
    precheckByIndex.get(unit.index),
    productConfig,
  ));
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
    ...(productConfig && productProfile ? {
      productType: productConfig.selectedType,
      expectedSoftwareVersion: productProfile.expectedSoftwareVersion,
      expectedProbeCount: productProfile.expectedProbeCount,
      productPrecheckVerdict: productPrecheck?.verdict ?? null,
    } : {}),
  };
}

export type { DetectionQualityConfig } from './field-waveform-analysis.js';
