import type { IndicatorVisionLightVerdict } from '../server/src/indicator-vision';

export type IndicatorVisionField = 'runningGreen' | 'fireRed' | 'faultYellow';
export type RelayLightField = 'alarmRelay' | 'faultRelay';
export type DetectorStatusLightKind = 'running-green' | 'fire-red' | 'fault-yellow' | 'alarm-relay' | 'fault-relay';

export const DETECTOR_STATUS_LIGHTS = [
  { kind: 'running-green', title: '运行绿灯', source: 'vision', field: 'runningGreen' },
  { kind: 'fire-red', title: '火警红灯', source: 'vision', field: 'fireRed' },
  { kind: 'fault-yellow', title: '故障黄灯', source: 'vision', field: 'faultYellow' },
  { kind: 'alarm-relay', title: '火警继电器', source: 'relay', field: 'alarmRelay' },
  { kind: 'fault-relay', title: '故障继电器', source: 'relay', field: 'faultRelay' },
] as const satisfies ReadonlyArray<{
  kind: DetectorStatusLightKind;
  title: string;
  source: 'vision' | 'relay';
  field: IndicatorVisionField | RelayLightField;
}>;

export interface RelayStatusSessionState {
  active: boolean;
  batchId: string | null;
}

export function startsNewRelayStatusSession(
  previous: RelayStatusSessionState,
  next: RelayStatusSessionState,
): boolean {
  const batchChanged = next.batchId !== null && next.batchId !== previous.batchId;
  return batchChanged || (next.active && !previous.active);
}

export function indicatorVisionState(verdict: IndicatorVisionLightVerdict | undefined): { active: boolean; known: boolean } {
  if (verdict === 'PASS') return { active: true, known: true };
  if (verdict === 'FAIL') return { active: false, known: true };
  return { active: false, known: false };
}
