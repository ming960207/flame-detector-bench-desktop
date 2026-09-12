export type IndicatorVisionVerdict = 'PASS' | 'FAIL' | 'PENDING' | 'NOT_APPLICABLE';
export type IndicatorVisionLightVerdict = 'PASS' | 'FAIL' | 'PENDING';

export interface IndicatorVisionUnitReport {
  slot: number;
  runningGreen: IndicatorVisionLightVerdict;
  fireRed: IndicatorVisionLightVerdict;
  faultYellow: IndicatorVisionLightVerdict;
  verdict: IndicatorVisionVerdict;
}

export interface IndicatorVisionReport {
  batchId: string | null;
  capturedAt: number;
  source: 'UVC_HSV';
  captureCount: number;
  phases: string[];
  verdict: IndicatorVisionVerdict;
  units: IndicatorVisionUnitReport[];
}

const LIGHT_VERDICTS = new Set<IndicatorVisionLightVerdict>(['PASS', 'FAIL', 'PENDING']);
const VERDICTS = new Set<IndicatorVisionVerdict>(['PASS', 'FAIL', 'PENDING', 'NOT_APPLICABLE']);

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function lightVerdict(value: unknown): IndicatorVisionLightVerdict {
  return typeof value === 'string' && LIGHT_VERDICTS.has(value as IndicatorVisionLightVerdict)
    ? value as IndicatorVisionLightVerdict
    : 'PENDING';
}

function overallVerdict(value: unknown): IndicatorVisionVerdict {
  return typeof value === 'string' && VERDICTS.has(value as IndicatorVisionVerdict)
    ? value as IndicatorVisionVerdict
    : 'PENDING';
}

export function normalizeIndicatorVisionReport(input: unknown, expectedBatchId: string | null): IndicatorVisionReport | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const batchId = text(source.batchId, 160) || null;
  if (expectedBatchId && batchId !== expectedBatchId) return null;
  const rawUnits = Array.isArray(source.units) ? source.units : [];
  const units = rawUnits
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({
      slot: Number(item.slot),
      runningGreen: lightVerdict(item.runningGreen),
      fireRed: lightVerdict(item.fireRed),
      faultYellow: lightVerdict(item.faultYellow),
      verdict: overallVerdict(item.verdict),
    }))
    .filter((item) => Number.isInteger(item.slot) && item.slot >= 1 && item.slot <= 6)
    .sort((left, right) => left.slot - right.slot)
    .filter((item, index, all) => index === 0 || item.slot !== all[index - 1]!.slot)
    .slice(0, 6);

  if (units.length === 0) return null;
  const captureCount = Number(source.captureCount);
  const phases = Array.isArray(source.phases)
    ? [...new Set(source.phases.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean))].slice(0, 20)
    : [];
  return {
    batchId,
    capturedAt: Number.isFinite(Number(source.capturedAt)) ? Number(source.capturedAt) : Date.now(),
    source: 'UVC_HSV',
    captureCount: Number.isFinite(captureCount) ? Math.max(0, Math.min(100, Math.floor(captureCount))) : 0,
    phases,
    verdict: overallVerdict(source.verdict),
    units,
  };
}
