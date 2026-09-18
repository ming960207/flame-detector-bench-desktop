import type {
  DetectionQualityConfig,
  DetectionQualityThresholds,
  DetectionRatioThresholds,
  DetectionSNRRange,
} from './field-waveform-analysis.js';

/**
 * Production grade policy:
 * - A grade always uses the operator's configured A thresholds unchanged.
 * - B grade is never independently configured. It is derived from A with a fixed
 *   10% tolerance: upper bounds x1.10, lower bounds x0.90, ranges expand both ways.
 *
 * A zero limit means "disabled/unlimited" in the existing configuration contract
 * and therefore remains zero instead of being converted into a numeric B limit.
 */
export const B_GRADE_TOLERANCE_RATIO = 0.10;

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function deriveBUpperBound(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return rounded(parsed * (1 + B_GRADE_TOLERANCE_RATIO));
}

export function deriveBLowerBound(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return rounded(parsed * (1 - B_GRADE_TOLERANCE_RATIO));
}

export function deriveBQualityThresholds(a: DetectionQualityThresholds): DetectionQualityThresholds {
  return {
    maxNoiseRms: deriveBUpperBound(a.maxNoiseRms),
    maxNoiseAbsolute: a.maxNoiseAbsolute == null ? undefined : deriveBUpperBound(a.maxNoiseAbsolute),
    maxInterferenceRatio: deriveBUpperBound(a.maxInterferenceRatio),
    minConsistencyTrend: a.minConsistencyTrend == null ? undefined : deriveBLowerBound(a.minConsistencyTrend),
    minSensitivity: deriveBLowerBound(a.minSensitivity),
  };
}

function deriveBRange(a: DetectionSNRRange): DetectionSNRRange {
  return {
    min: deriveBLowerBound(a.min),
    max: deriveBUpperBound(a.max),
  };
}

export function deriveBRatioThresholds(a: DetectionRatioThresholds): DetectionRatioThresholds {
  return {
    snr21: deriveBRange(a.snr21),
    snr23: deriveBRange(a.snr23),
    snr31: deriveBRange(a.snr31),
  };
}

export function applyAutomaticBGradePolicy(quality: DetectionQualityConfig): DetectionQualityConfig {
  const a: DetectionQualityThresholds = { ...quality.a };
  const ratiosA: DetectionRatioThresholds = {
    snr21: { ...quality.ratios.a.snr21 },
    snr23: { ...quality.ratios.a.snr23 },
    snr31: { ...quality.ratios.a.snr31 },
  };
  return {
    ...quality,
    // B is the fixed production acceptance envelope; the old persisted selector is
    // retained only for schema compatibility and can no longer disable B grading.
    acceptanceGrade: 'B',
    a,
    b: deriveBQualityThresholds(a),
    ratios: {
      a: ratiosA,
      b: deriveBRatioThresholds(ratiosA),
    },
  };
}
