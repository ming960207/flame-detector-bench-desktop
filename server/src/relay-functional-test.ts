export type RelayFunctionalTestMode = 'FAST_BATCH' | 'DIAGNOSTIC';
export type RelayFunctionalTestVerdict = 'PASS' | 'FAIL' | 'TEST_INVALID' | 'SKIPPED' | 'PENDING';
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

export type RelayDioReadFunction = 2 | 4;

export interface RelayDioConfig {
  host: string;
  port: number;
  unitId: number;
  functionCode: RelayDioReadFunction;
  startAddress: number;
  inputCount: number;
  requestTimeoutMs: number;
}

export const DEFAULT_RELAY_DIO_CONFIG: RelayDioConfig = Object.freeze({
  host: '',
  port: 502,
  unitId: 1,
  functionCode: 4,
  startAddress: 0,
  inputCount: 16,
  requestTimeoutMs: 1500,
});

export interface RelayFeedbackMapping {
  detectorIndex: number;
  /** DIO 输入通道，例如 X1；协议地址 0x0000 对应 X1。 */
  alarmInputAddress: string;
  faultInputAddress: string;
  /** 正常态电平；动作态取反，兼容 NO/NC 与失电安全接法。 */
  alarmNormalLevel: boolean;
  faultNormalLevel: boolean;
}

export interface RelayFunctionalTestConfig {
  /** 设备级总开关；具体产品型号还需要 relayFunctionalTestEnabled=true 才实际执行。 */
  enabled: boolean;
  /** 继电器反馈专用的 Modbus TCP 数字量输入模块。 */
  dio: RelayDioConfig;
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
  // 未配置 DIO 反馈模块前保持关闭；现场完成 12 路映射后再打开总开关。
  enabled: false,
  dio: DEFAULT_RELAY_DIO_CONFIG,
  mode: 'FAST_BATCH',
  feedbackTimeoutMs: 2000,
  resetTimeoutMs: 3000,
  stableSamples: 3,
  sampleIntervalMs: 200,
  mappings: Array.from({ length: 6 }, (_, index) => ({
    detectorIndex: index + 1,
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
  const candidate = typeof value === 'string' ? value : fallback;
  const address = candidate.trim().toUpperCase();
  if (!address) return '';
  const channel = relayInputChannelIndex(address);
  return channel === null ? fallback : `X${channel + 1}`;
}

export function relayInputChannelIndex(value: string): number | null {
  const normalized = value.trim().toUpperCase();
  const channelMatch = /^X(\d+)$/.exec(normalized);
  if (channelMatch) {
    const channel = Number(channelMatch[1]) - 1;
    return Number.isInteger(channel) && channel >= 0 && channel < 64 ? channel : null;
  }
  const protocolMatch = /^0X([0-9A-F]+)$/.exec(normalized);
  if (protocolMatch) {
    const address = Number.parseInt(protocolMatch[1]!, 16);
    return Number.isInteger(address) && address >= 0 && address < 64 ? address : null;
  }
  return null;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.floor(parsed) : fallback;
}

export function normalizeRelayDioConfig(input: unknown, fallback: RelayDioConfig = DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG.dio): RelayDioConfig {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    host: typeof source.host === 'string' ? source.host.trim() : fallback.host,
    port: boundedNumber(source.port, fallback.port, 1, 65535),
    unitId: boundedNumber(source.unitId, fallback.unitId, 1, 255),
    functionCode: source.functionCode === 2 || source.functionCode === 4
      ? source.functionCode
      : fallback.functionCode,
    startAddress: boundedNumber(source.startAddress, fallback.startAddress, 0, 65535),
    inputCount: boundedNumber(source.inputCount, fallback.inputCount, 1, 64),
    requestTimeoutMs: boundedNumber(source.requestTimeoutMs, fallback.requestTimeoutMs, 200, 5000),
  };
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
      alarmInputAddress: cleanInputAddress(raw.alarmInputAddress, base.alarmInputAddress),
      faultInputAddress: cleanInputAddress(raw.faultInputAddress, base.faultInputAddress),
      alarmNormalLevel: typeof raw.alarmNormalLevel === 'boolean' ? raw.alarmNormalLevel : base.alarmNormalLevel,
      faultNormalLevel: typeof raw.faultNormalLevel === 'boolean' ? raw.faultNormalLevel : base.faultNormalLevel,
    });
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    dio: normalizeRelayDioConfig(source.dio, fallback.dio),
    mode: source.mode === 'DIAGNOSTIC' ? 'DIAGNOSTIC' : source.mode === 'FAST_BATCH' ? 'FAST_BATCH' : fallback.mode,
    feedbackTimeoutMs: boundedInteger(source.feedbackTimeoutMs, fallback.feedbackTimeoutMs, 200, 10_000),
    resetTimeoutMs: boundedInteger(source.resetTimeoutMs, fallback.resetTimeoutMs, 200, 15_000),
    stableSamples: boundedInteger(source.stableSamples, fallback.stableSamples, 1, 10),
    sampleIntervalMs: boundedInteger(source.sampleIntervalMs, fallback.sampleIntervalMs, 50, 1000),
    mappings,
  };
}

export function relayDioConfigReady(config: RelayDioConfig): boolean {
  return Boolean(config.host.trim())
    && config.port >= 1 && config.port <= 65535
    && config.unitId >= 1 && config.unitId <= 255
    && config.inputCount >= 1 && config.inputCount <= 64;
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
    const check = (address: string | undefined, label: string) => {
      const channel = address ? relayInputChannelIndex(address) : null;
      if (channel === null) {
        missing.push(`D${index}_${label}_DI`);
        return;
      }
      if (channel < config.dio.startAddress || channel >= config.dio.startAddress + config.dio.inputCount) {
        missing.push(`D${index}_${label}_DI_OUT_OF_RANGE`);
      }
    };
    check(mapping?.alarmInputAddress, 'ALARM');
    check(mapping?.faultInputAddress, 'FAULT');
  }
  return missing;
}

export function relayFunctionalTestReady(
  config: RelayFunctionalTestConfig,
  detectorIndexes: number[],
): boolean {
  return config.enabled
    && relayDioConfigReady(config.dio)
    && relayFunctionalTestMissingMappings(config, detectorIndexes).length === 0;
}
