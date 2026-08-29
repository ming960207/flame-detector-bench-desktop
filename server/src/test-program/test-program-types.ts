import { PLC_HEAT_SUBSTAGE_LABELS, type PLCProcessStatus } from '../process-status.js';
import type {
  FlameDetectorState,
  FlameSample,
} from '../types.js';
import type { FieldDetectorBatchVerdict } from '../closure/field-detector-verdict.js';
import type { FieldFinalVerdict } from '../closure/field-final-verdict.js';
import type {
  ChannelKey,
  FieldWaveformAnalysisSnapshot,
} from '../closure/field-waveform-analysis.js';

export type TestProgramRunStatus = 'RUNNING' | 'COMPLETED' | 'ABORTED';
export type TestProgramStageStatus = 'RUNNING' | 'COMPLETED' | 'ABORTED';

export type TestProgramStageId =
  | 'INIT'
  | 'HEAT_POSITIONING'
  | 'HEAT_SIGNAL_STABILIZATION'
  | 'HEAT_NOISE_CAPTURE'
  | 'HEAT_INTERFERENCE'
  | 'FLASH'
  | 'EMC'
  | 'RETURN_HOME'
  | 'COMPLETE'
  | 'FAULT'
  | 'UNKNOWN';

export interface TestProgramStageDefinition {
  id: TestProgramStageId;
  label: string;
  plannedDurationMs: number | null;
  planBasis?: string;
}

/**
 * 设计时长只在已经有明确协议依据的地方填写。其余工序仍然完整统计，
 * 但显示为“未配置”，避免用离线原型步骤时长冒充现场 PLC 设计时长。
 */
export const DEFAULT_TEST_PROGRAM_STAGE_PLAN: readonly TestProgramStageDefinition[] = [
  { id: 'INIT', label: '初始化', plannedDurationMs: null },
  { id: 'HEAT_POSITIONING', label: '热源定位/阶段过渡', plannedDurationMs: null },
  { id: 'HEAT_SIGNAL_STABILIZATION', label: PLC_HEAT_SUBSTAGE_LABELS.SIGNAL_STABILIZATION, plannedDurationMs: null },
  {
    id: 'HEAT_NOISE_CAPTURE',
    label: PLC_HEAT_SUBSTAGE_LABELS.NOISE_CAPTURE,
    plannedDurationMs: 30_000,
    planBasis: 'PLC 程序契约 M25.2 标注为信号稳定后 30 秒噪声采集窗口',
  },
  { id: 'HEAT_INTERFERENCE', label: PLC_HEAT_SUBSTAGE_LABELS.HEAT_INTERFERENCE, plannedDurationMs: null },
  { id: 'FLASH', label: '爆闪干扰', plannedDurationMs: null },
  { id: 'EMC', label: '电磁干扰', plannedDurationMs: null },
  { id: 'RETURN_HOME', label: '回初始位确认', plannedDurationMs: null },
  { id: 'COMPLETE', label: '已完成', plannedDurationMs: null },
  { id: 'FAULT', label: '故障/中止', plannedDurationMs: null },
  { id: 'UNKNOWN', label: '未知工序', plannedDurationMs: null },
];

export interface TestProgramRelayState {
  key: string;
  address: string;
  label: string;
  value: boolean;
  changedAt: number | null;
}

export interface TestProgramRelayEvent {
  timestamp: number;
  stageId: TestProgramStageId;
  key: string;
  address: string;
  label: string;
  before: boolean | null;
  value: boolean;
}

export interface WaveformChannelStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  rms: number;
  peakToPeak: number;
}

export interface TestProgramUnitWaveform {
  index: number;
  address: number;
  sampleCount: number;
  rawSampleCount: number;
  firstAt: number | null;
  lastAt: number | null;
  channels: Partial<Record<ChannelKey, WaveformChannelStats>>;
  samples: FlameSample[];
  rawSamples: FlameSample[];
}

export type TestProgramDetectorScalarKey =
  | 'probe1'
  | 'probe2'
  | 'probe3'
  | 'probe4'
  | 'probe1Absolute'
  | 'probe2Absolute'
  | 'probe3Absolute'
  | 'probe4Absolute'
  | 'probe1Fluctuation'
  | 'probe2Fluctuation'
  | 'probe3Fluctuation'
  | 'probe4Fluctuation'
  | 'snr21'
  | 'snr23'
  | 'snr31'
  | 'sensitivity';

export interface TestProgramDetectorObservation {
  timestamp: number;
  stageId: TestProgramStageId;
  index: number;
  address: number;
  online: boolean;
  fire: boolean;
  fault: boolean;
  sourceReady: boolean;
  syncOk: boolean;
  probe1: number | null;
  probe2: number | null;
  probe3: number | null;
  probe4: number | null;
  probe1Absolute: number | null;
  probe2Absolute: number | null;
  probe3Absolute: number | null;
  probe4Absolute: number | null;
  probe1Fluctuation: number | null;
  probe2Fluctuation: number | null;
  probe3Fluctuation: number | null;
  probe4Fluctuation: number | null;
  snr21: number | null;
  snr23: number | null;
  snr31: number | null;
  sensitivity: number | null;
  sendMode: number | null;
}

export interface TestProgramDetectorValueStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  last: number;
}

export interface TestProgramDetectorStageSummary {
  index: number;
  address: number;
  observationCount: number;
  retainedObservationCount: number;
  firstAt: number | null;
  lastAt: number | null;
  onlineCount: number;
  offlineCount: number;
  fireCount: number;
  faultCount: number;
  sourceNotReadyCount: number;
  syncNotOkCount: number;
  latest: TestProgramDetectorObservation | null;
  stats: Partial<Record<TestProgramDetectorScalarKey, TestProgramDetectorValueStats>>;
}

export interface TestProgramStageRecord {
  sequence: number;
  stageId: TestProgramStageId;
  label: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  plannedDurationMs: number | null;
  durationDeltaMs: number | null;
  withinPlan: boolean | null;
  status: TestProgramStageStatus;
  relaySnapshot: TestProgramRelayState[];
  relayEventCount: number;
  waveforms: TestProgramUnitWaveform[];
  /** 有界原始标量时序；summary 中保留完整计数和统计范围。 */
  detectorObservations: TestProgramDetectorObservation[];
  detectors: TestProgramDetectorStageSummary[];
  decisionBasis: string[];
}

export interface TestProgramDecision {
  verdict: string | null;
  grade: string | null;
  reasons: string[];
  basis: string[];
  evaluatedAt: number | null;
}

export interface TestProgramFormalEvidence {
  process: PLCProcessStatus | null;
  detectorState: FlameDetectorState | null;
  waveformAnalysis: FieldWaveformAnalysisSnapshot | null;
  detectorVerdict: FieldDetectorBatchVerdict | null;
  finalVerdict: FieldFinalVerdict | null;
}

export interface TestProgramRun {
  runId: string;
  status: TestProgramRunStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  currentStage: TestProgramStageId;
  stages: TestProgramStageRecord[];
  relayEvents: TestProgramRelayEvent[];
  latestRelayOutputs: TestProgramRelayState[];
  decision: TestProgramDecision;
  evidence: TestProgramFormalEvidence;
  stagePlan: TestProgramStageDefinition[];
}

export interface TestProgramFormalSummary {
  process?: PLCProcessStatus;
  plcConnected?: boolean;
  detectorConnected?: boolean;
  detectorTransportConnected?: boolean;
  detectorDataStreamConnected?: boolean;
  waveformAnalysis?: FieldWaveformAnalysisSnapshot;
  detectorVerdict?: FieldDetectorBatchVerdict;
  finalVerdict?: FieldFinalVerdict;
  [key: string]: unknown;
}

export interface TestProgramSourceState {
  formalBackendUrl: string;
  connected: boolean;
  lastSeenAt: number | null;
  lastError: string | null;
  lastPollAt: number | null;
}

export interface TestProgramSnapshot {
  updatedAt: number;
  source: TestProgramSourceState;
  plan: TestProgramStageDefinition[];
  currentRun: TestProgramRun | null;
  lastProcess: PLCProcessStatus | null;
  lastDetectorState: FlameDetectorState | null;
  lastSummary: TestProgramFormalSummary | null;
}

export interface TestProgramArchiveSummary {
  runId: string;
  status: TestProgramRunStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  verdict: string | null;
  grade: string | null;
  stageCount: number;
  completedStageCount: number;
  waveformSampleCount: number;
  detectorObservationCount: number;
  relayEventCount: number;
}

export interface TestProgramArchive extends TestProgramRun {
  archivedAt: number;
  reportFile: string;
}

export function stageDefinitionMap(
  plan: readonly TestProgramStageDefinition[] = DEFAULT_TEST_PROGRAM_STAGE_PLAN,
): ReadonlyMap<TestProgramStageId, TestProgramStageDefinition> {
  return new Map(plan.map((stage) => [stage.id, stage]));
}
