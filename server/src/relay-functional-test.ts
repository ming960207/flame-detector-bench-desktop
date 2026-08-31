export type RelayFunctionalTestMode = 'FAST_BATCH' | 'DIAGNOSTIC';
export type RelayFunctionalTestVerdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'PENDING';
export type RelayFunctionalTestPhase =
  | 'BASELINE'
  | 'ALARM_COMMAND'
  | 'ALARM_VERIFY'
  | 'ALARM_RESET'
  | 'ALARM_RESET_VERIFY'
  | 'FAULT_COMMAND'
  | 'FAULT_VERIFY'
  | 'FAULT_RESET'
  | 'FAULT_RESET_VERIFY'
  | 'COMPLETE';

export interface RelayFeedbackMapping {
  detectorIndex: number;
  /** PLC process-status io.inputs 中的逻辑键。 */
  alarmInputKey: string;
  faultInputKey: string;
  /** S7-200 SMART 实际输入地址，例如 I2.0。未接线前留空，不臆造地址。 */
  alarmInputAddress: string;
  faultInputAddress: string;
  /** 正常态电平；动作态取反，兼容 NO/NC 与失电安全接法。 */
  alarmNormalLevel: boolean;
  faultNormalLevel: boolean;
}

export interface RelayFunctionalTestConfig {
  /** 设备级总开关；具体产品型号还需要 relayFunctionalTestEnabled=true 才实际执行。 */
  enabled: boolean;
  mode: RelayFunctionalTestMode;
  feedbackTimeoutMs: number;
  resetTimeoutMs: number;
  stableSamples: number;
  sampleIntervalMs: number;
  mappings: RelayFeedbackMapping[];
}

export interface RelayActionResult {
  commandAccepted: boolean;
  internalStateReached: boolean;
  physicalStateReached: boolean;
  oppositeRelayStayedNormal: boolean;
  responseTimeMs: number | null;
  resetAccepted: boolean;
  internalRecovered: boolean;
  physicalRecovered: boolean;
  verdict: RelayFunctionalTestVerdict;
  reasons: string[];
}

export interface RelayFunctionalTestUnitResult {
  detectorIndex: number;
  enabled: boolean;
  baseline: {
    alarmInternal: boolean | null;
    faultInternal: boolean | null;
    alarmPhysical: boolean | null;
    faultPhysical: boolean | null;
  };
  alarm: RelayActionResult;
  fault: RelayActionResult;
  verdict: RelayFunctionalTestVerdict;
}

export interface RelayFunctionalTestReport {
  batchId: string | null;
  mode: RelayFunctionalTestMode;
  phase: RelayFunctionalTestPhase;
  startedAt: number;
  completedAt: number;
  verdict: RelayFunctionalTestVerdict;
  units: RelayFunctionalTestUnitResult[];
}

export const DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG: RelayFunctionalTestConfig = Object.freeze({
  // 未接入 PLC 扩展 DI 前保持关闭；现场完成 12 路映射后再打开总开关。
  enabled: false,
  mode: 'FAST_BATCH',
  feedbackTimeoutMs: 2000,
  resetTimeoutMs: 3000,
  stableSamples: 3,
  sampleIntervalMs: 200,
  mappings: Array.from({ length: 6 }, (_, index) => ({
    detectorIndex: index + 1,
    alarmInputKey: `detector${index + 1}AlarmRelay`,
    faultInputKey: `detector${index + 1}FaultRelay`,
    alarmInputAddress: '',
    faultInputAddress: '',
    alarmNormalLevel: false,
    faultNormalLevel: false,
  })),
});

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function cleanInputAddress(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const address = value.trim().toUpperCase();
  if (!address) return '';
  return /^I\d+\.\d$/.test(address) ? address : fallback;
}

export function normalizeRelayFunctionalTestConfig(
  input: unknown,
  fallback: RelayFunctionalTestConfig = DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
): RelayFunctionalTestConfig {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const rawMappings = Array.isArray(source.mappings) ? source.mappings : [];
  const mappings: RelayFeedbackMapping[] = [];
  for (let detectorIndex = 1; detectorIndex <= 6; detectorIndex += 1) {
    const base = fallback.mappings.find((item) => item.detectorIndex === detectorIndex)
      ?? DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG.mappings[detectorIndex - 1]!;
    const candidate = rawMappings.find((item) => item && typeof item === 'object' && Number((item as Record<string, unknown>).detectorIndex) === detectorIndex);
    const raw = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    mappings.push({
      detectorIndex,
      alarmInputKey: typeof raw.alarmInputKey === 'string' ? raw.alarmInputKey.trim() || base.alarmInputKey : base.alarmInputKey,
      faultInputKey: typeof raw.faultInputKey === 'string' ? raw.faultInputKey.trim() || base.faultInputKey : base.faultInputKey,
      alarmInputAddress: cleanInputAddress(raw.alarmInputAddress, base.alarmInputAddress),
      faultInputAddress: cleanInputAddress(raw.faultInputAddress, base.faultInputAddress),
      alarmNormalLevel: typeof raw.alarmNormalLevel === 'boolean' ? raw.alarmNormalLevel : base.alarmNormalLevel,
      faultNormalLevel: typeof raw.faultNormalLevel === 'boolean' ? raw.faultNormalLevel : base.faultNormalLevel,
    });
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    mode: source.mode === 'DIAGNOSTIC' ? 'DIAGNOSTIC' : source.mode === 'FAST_BATCH' ? 'FAST_BATCH' : fallback.mode,
    feedbackTimeoutMs: boundedInteger(source.feedbackTimeoutMs, fallback.feedbackTimeoutMs, 200, 10_000),
    resetTimeoutMs: boundedInteger(source.resetTimeoutMs, fallback.resetTimeoutMs, 200, 15_000),
    stableSamples: boundedInteger(source.stableSamples, fallback.stableSamples, 1, 10),
    sampleIntervalMs: boundedInteger(source.sampleIntervalMs, fallback.sampleIntervalMs, 50, 1000),
    mappings,
  };
}

export function relayInputIsActive(level: boolean | undefined, normalLevel: boolean): boolean | null {
  return typeof level === 'boolean' ? level !== normalLevel : null;
}

export function relayFeedbackMappingFor(
  config: RelayFunctionalTestConfig,
  detectorIndex: number,
): RelayFeedbackMapping | undefined {
  return config.mappings.find((mapping) => mapping.detectorIndex === detectorIndex);
}

export function relayFunctionalTestMissingMappings(
  config: RelayFunctionalTestConfig,
  detectorIndexes: number[],
): string[] {
  const missing: string[] = [];
  for (const index of detectorIndexes) {
    const mapping = relayFeedbackMappingFor(config, index);
    if (!mapping?.alarmInputAddress) missing.push(`D${index}_ALARM_DI`);
    if (!mapping?.faultInputAddress) missing.push(`D${index}_FAULT_DI`);
  }
  return missing;
}

export function relayFunctionalTestReady(
  config: RelayFunctionalTestConfig,
  detectorIndexes: number[],
): boolean {
  return config.enabled && relayFunctionalTestMissingMappings(config, detectorIndexes).length === 0;
}
