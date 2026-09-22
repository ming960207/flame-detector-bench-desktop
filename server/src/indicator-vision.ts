export type IndicatorVisionVerdict = 'PASS' | 'FAIL' | 'PENDING' | 'NOT_APPLICABLE';
export type IndicatorVisionLightVerdict = 'PASS' | 'FAIL' | 'PENDING';

export interface IndicatorVisionUnitReport {
  slot: number;
  runningGreen: IndicatorVisionLightVerdict;
  fireRed: IndicatorVisionLightVerdict;
  /** 故障黄灯仅保留为视觉调试证据，不参与生产 LED 合格判定。 */
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

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function lightVerdict(value: unknown): IndicatorVisionLightVerdict {
  return typeof value === 'string' && LIGHT_VERDICTS.has(value as IndicatorVisionLightVerdict)
    ? value as IndicatorVisionLightVerdict
    : 'PENDING';
}

/**
 * 正式生产 LED 检验只包含运行绿灯和火警红灯。
 * 故障黄灯不是检测项：无论 FAIL/PENDING/缺失，都不得把产品降级为 NG。
 */
export function requiredIndicatorVerdict(
  runningGreen: IndicatorVisionLightVerdict,
  fireRed: IndicatorVisionLightVerdict,
): IndicatorVisionVerdict {
  if (runningGreen === 'PASS' && fireRed === 'PASS') return 'PASS';
  if (runningGreen === 'FAIL' || fireRed === 'FAIL') return 'FAIL';
  return 'PENDING';
}

function overallRequiredIndicatorVerdict(units: IndicatorVisionUnitReport[]): IndicatorVisionVerdict {
  if (units.length === 0) return 'PENDING';
  if (units.every((unit) => unit.verdict === 'PASS')) return 'PASS';
  if (units.some((unit) => unit.verdict === 'FAIL')) return 'FAIL';
  return 'PENDING';
}

export function normalizeIndicatorVisionReport(input: unknown, expectedBatchId: string | null): IndicatorVisionReport | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const batchId = text(source.batchId, 160) || null;
  if (expectedBatchId && batchId !== expectedBatchId) return null;
  const rawUnits = Array.isArray(source.units) ? source.units : [];
  const units = rawUnits
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => {
      const runningGreen = lightVerdict(item.runningGreen);
      const fireRed = lightVerdict(item.fireRed);
      const faultYellow = lightVerdict(item.faultYellow);
      return {
        slot: Number(item.slot),
        runningGreen,
        fireRed,
        faultYellow,
        // Never trust a caller-provided overall verdict here. Canonical production
        // judgement is derived from the two required LEDs only.
        verdict: requiredIndicatorVerdict(runningGreen, fireRed),
      } satisfies IndicatorVisionUnitReport;
    })
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
    verdict: overallRequiredIndicatorVerdict(units),
    units,
  };
}
