import { EventEmitter } from 'node:events';
import { PLC_PROGRAM } from '../plc-program-contract.js';
import { isPLCProcessComplete, type PLCProcessStatus } from '../process-status.js';
import type {
  FlameDetectorState,
  FlameDetectorUnitState,
  FlameDetectorWaveformDelta,
  FlameSample,
} from '../types.js';
import type { FieldDetectorBatchVerdict } from '../closure/field-detector-verdict.js';
import type { FieldFinalVerdict } from '../closure/field-final-verdict.js';
import type { FieldWaveformAnalysisSnapshot } from '../closure/field-waveform-analysis.js';
import {
  DEFAULT_TEST_PROGRAM_STAGE_PLAN,
  stageDefinitionMap,
  type TestProgramDecision,
  type TestProgramDetectorObservation,
  type TestProgramDetectorScalarKey,
  type TestProgramDetectorStageSummary,
  type TestProgramDetectorValueStats,
  type TestProgramFormalSummary,
  type TestProgramRelayEvent,
  type TestProgramRelayState,
  type TestProgramRun,
  type TestProgramRunStatus,
  type TestProgramSnapshot,
  type TestProgramStageDefinition,
  type TestProgramStageId,
  type TestProgramStageRecord,
  type TestProgramStageStatus,
  type TestProgramUnitWaveform,
  type WaveformChannelStats,
} from './test-program-types.js';

const WAVEFORM_CHANNELS = ['probe1', 'probe2', 'probe3', 'probe4'] as const;
const DETECTOR_SCALAR_KEYS = [
  'probe1',
  'probe2',
  'probe3',
  'probe4',
  'probe1Absolute',
  'probe2Absolute',
  'probe3Absolute',
  'probe4Absolute',
  'probe1Fluctuation',
  'probe2Fluctuation',
  'probe3Fluctuation',
  'probe4Fluctuation',
  'snr21',
  'snr23',
  'snr31',
  'sensitivity',
] as const satisfies readonly TestProgramDetectorScalarKey[];
const ACTIVE_PROCESS_STAGES = new Set(['INIT', 'HEAT', 'FLASH', 'EMC', 'RETURN_HOME']);

export interface TestProgramTrackerOptions {
  formalBackendUrl?: string;
  plan?: readonly TestProgramStageDefinition[];
  maxSamplesPerUnitStage?: number;
  maxDetectorObservationsPerStage?: number;
  now?: () => number;
  runIdFactory?: (startedAt: number) => string;
  onRunFinalized?: (run: TestProgramRun) => void;
}

interface PendingCompletion {
  timestamp: number;
  status: PLCProcessStatus;
}

function timestampOrNow(value: unknown, now: () => number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : now();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return numeric(value);
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function currentStageId(status: PLCProcessStatus): TestProgramStageId {
  if (status.stage === 'FAULT' || (status.alarm && !isPLCProcessComplete(status))) return 'FAULT';
  if (status.processStage === 'HEAT') {
    switch (status.heatSubstage) {
      case 'SIGNAL_STABILIZATION': return 'HEAT_SIGNAL_STABILIZATION';
      case 'NOISE_CAPTURE': return 'HEAT_NOISE_CAPTURE';
      case 'HEAT_INTERFERENCE': return 'HEAT_INTERFERENCE';
      default: return 'HEAT_POSITIONING';
    }
  }
  if (status.processStage === 'COMPLETE' || isPLCProcessComplete(status)) return 'COMPLETE';
  if (status.processStage === 'INIT') return 'INIT';
  if (status.processStage === 'FLASH') return 'FLASH';
  if (status.processStage === 'EMC') return 'EMC';
  if (status.processStage === 'RETURN_HOME') return 'RETURN_HOME';
  return 'UNKNOWN';
}

function isActiveProcess(status: PLCProcessStatus): boolean {
  return Boolean(status.autoRunning) || ACTIVE_PROCESS_STAGES.has(status.processStage);
}

function sampleValues(samples: FlameSample[], key: (typeof WAVEFORM_CHANNELS)[number]): number[] {
  return samples
    .map((sample) => numeric(sample?.[key]))
    .filter((value): value is number => value !== null);
}

function channelStats(samples: FlameSample[], key: (typeof WAVEFORM_CHANNELS)[number]): WaveformChannelStats | undefined {
  const values = sampleValues(samples, key);
  if (values.length === 0) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
  return {
    count: values.length,
    min,
    max,
    mean,
    rms,
    peakToPeak: max - min,
  };
}

function summarizeChannels(samples: FlameSample[]): Partial<Record<(typeof WAVEFORM_CHANNELS)[number], WaveformChannelStats>> {
  return Object.fromEntries(
    WAVEFORM_CHANNELS
      .map((key) => [key, channelStats(samples, key)] as const)
      .filter((entry): entry is readonly [typeof entry[0], WaveformChannelStats] => Boolean(entry[1])),
  );
}

function runSampleCount(run: TestProgramRun): number {
  return run.stages.reduce(
    (total, stage) => total + stage.waveforms.reduce((stageTotal, waveform) => stageTotal + waveform.sampleCount, 0),
    0,
  );
}

function runDetectorObservationCount(run: TestProgramRun): number {
  return run.stages.reduce((total, stage) => total + (stage.detectors ?? []).reduce((stageTotal, detector) => stageTotal + detector.observationCount, 0), 0);
}

function compactDetectorState(state: FlameDetectorState): FlameDetectorState {
  return {
    ...state,
    units: state.units.map((unit) => {
      const { historySamples: _historySamples, rawHistorySamples: _rawHistorySamples, ...metadata } = unit;
      return metadata;
    }),
  };
}

type DetectorScalarSource = Pick<FlameDetectorUnitState, 'index' | 'address' | 'online' | 'fire' | 'fault' | 'sourceReady' | 'syncOk' | 'probe1' | 'probe2' | 'probe3' | 'probe4' | 'probe1Absolute' | 'probe2Absolute' | 'probe3Absolute' | 'probe4Absolute' | 'probe1Fluctuation' | 'probe2Fluctuation' | 'probe3Fluctuation' | 'probe4Fluctuation' | 'snr21' | 'snr23' | 'snr31' | 'sensitivity' | 'sendMode'>;

function detectorObservation(
  unit: DetectorScalarSource,
  stageId: TestProgramStageId,
  timestamp: number,
): TestProgramDetectorObservation {
  const value = (key: TestProgramDetectorScalarKey): number | null => optionalNumeric(unit[key]);
  return {
    timestamp,
    stageId,
    index: unit.index,
    address: unit.address,
    online: Boolean(unit.online),
    fire: Boolean(unit.fire),
    fault: Boolean(unit.fault),
    sourceReady: Boolean(unit.sourceReady),
    syncOk: Boolean(unit.syncOk),
    probe1: value('probe1'),
    probe2: value('probe2'),
    probe3: value('probe3'),
    probe4: value('probe4'),
    probe1Absolute: value('probe1Absolute'),
    probe2Absolute: value('probe2Absolute'),
    probe3Absolute: value('probe3Absolute'),
    probe4Absolute: value('probe4Absolute'),
    probe1Fluctuation: value('probe1Fluctuation'),
    probe2Fluctuation: value('probe2Fluctuation'),
    probe3Fluctuation: value('probe3Fluctuation'),
    probe4Fluctuation: value('probe4Fluctuation'),
    snr21: value('snr21'),
    snr23: value('snr23'),
    snr31: value('snr31'),
    sensitivity: value('sensitivity'),
    sendMode: optionalNumeric(unit.sendMode),
  };
}

function updateDetectorStats(
  summary: TestProgramDetectorStageSummary,
  key: TestProgramDetectorScalarKey,
  value: number | null,
): void {
  if (value === null) return;
  const previous = summary.stats[key];
  if (!previous) {
    summary.stats[key] = { count: 1, min: value, max: value, mean: value, last: value };
    return;
  }
  const count = previous.count + 1;
  summary.stats[key] = {
    count,
    min: Math.min(previous.min, value),
    max: Math.max(previous.max, value),
    mean: ((previous.mean * previous.count) + value) / count,
    last: value,
  } satisfies TestProgramDetectorValueStats;
}

function detectorRangeText(summary: TestProgramDetectorStageSummary, key: TestProgramDetectorScalarKey): string {
  const stats = summary.stats[key];
  return stats ? `${stats.min.toFixed(3)}~${stats.max.toFixed(3)}` : '-';
}

function detectorStageBasis(stage: TestProgramStageRecord): string[] {
  return (stage.detectors ?? []).map((summary) => {
    const latest = summary.latest;
    const state = [
      summary.onlineCount > 0 ? '在线' : '离线',
      summary.faultCount > 0 ? '故障' : '无故障',
      latest?.sourceReady ? '光源就绪' : '光源未就绪',
      latest?.syncOk ? '同步正常' : '同步异常',
    ].join('/');
    return `设备${summary.index}：探测器观测 ${summary.observationCount} 次，P1 ${detectorRangeText(summary, 'probe1')}，P2 ${detectorRangeText(summary, 'probe2')}，P3 ${detectorRangeText(summary, 'probe3')}，SNR23 ${detectorRangeText(summary, 'snr23')}，最后状态 ${state}`;
  });
}

export class TestProgramTracker extends EventEmitter {
  private readonly now: () => number;
  private plan: TestProgramStageDefinition[];
  private planById: ReadonlyMap<TestProgramStageId, TestProgramStageDefinition>;
  private readonly maxSamplesPerUnitStage: number;
  private readonly maxDetectorObservationsPerStage: number;
  private readonly formalBackendUrl: string;
  private readonly runIdFactory: (startedAt: number) => string;
  private readonly onRunFinalized?: (run: TestProgramRun) => void;
  private currentRun: TestProgramRun | null = null;
  private lastProcess: PLCProcessStatus | null = null;
  private lastDetectorState: FlameDetectorState | null = null;
  private lastSummary: TestProgramFormalSummary | null = null;
  private lastOutputs: Record<string, boolean> | null = null;
  private readonly waveformCursors = new Map<number, number>();
  private pendingCompletion: PendingCompletion | null = null;
  private sourceConnected = false;
  private sourceLastSeenAt: number | null = null;
  private sourceLastError: string | null = null;
  private sourceLastPollAt: number | null = null;

  constructor(options: TestProgramTrackerOptions = {}) {
    super();
    this.now = options.now ?? (() => Date.now());
    this.plan = Array.from(clone(options.plan ?? DEFAULT_TEST_PROGRAM_STAGE_PLAN));
    this.planById = stageDefinitionMap(this.plan);
    this.maxSamplesPerUnitStage = Math.max(100, Math.floor(options.maxSamplesPerUnitStage ?? 2_000));
    this.maxDetectorObservationsPerStage = Math.max(100, Math.floor(options.maxDetectorObservationsPerStage ?? 2_000));
    this.formalBackendUrl = options.formalBackendUrl ?? 'http://127.0.0.1:3003';
    this.runIdFactory = options.runIdFactory ?? ((startedAt) => `test-${new Date(startedAt).toISOString().replace(/[-:.TZ]/g, '')}-${Math.random().toString(16).slice(2, 8)}`);
    this.onRunFinalized = options.onRunFinalized;
  }

  setSourceConnection(connected: boolean, error?: string | null): void {
    this.sourceConnected = connected;
    if (connected) this.sourceLastError = null;
    else if (error !== undefined) this.sourceLastError = error;
  }

  /**
   * Updates the observer-side plan for the next run. An active run keeps the
   * stagePlan and stage records captured when it started.
   */
  setPlan(plan: readonly TestProgramStageDefinition[]): void {
    this.plan = Array.from(clone(plan));
    this.planById = stageDefinitionMap(this.plan);
  }

  markSourceSeen(timestamp = this.now()): void {
    this.sourceConnected = true;
    this.sourceLastSeenAt = timestamp;
    this.sourceLastError = null;
  }

  markPoll(timestamp = this.now()): void {
    this.sourceLastPollAt = timestamp;
  }

  snapshot(): TestProgramSnapshot {
    return {
      updatedAt: this.now(),
      source: {
        formalBackendUrl: this.formalBackendUrl,
        connected: this.sourceConnected,
        lastSeenAt: this.sourceLastSeenAt,
        lastError: this.sourceLastError,
        lastPollAt: this.sourceLastPollAt,
      },
      plan: clone(this.plan),
      currentRun: this.currentRun ? clone(this.currentRun) : null,
      lastProcess: this.lastProcess ? clone(this.lastProcess) : null,
      lastDetectorState: this.lastDetectorState ? clone(this.lastDetectorState) : null,
      lastSummary: this.lastSummary ? clone(this.lastSummary) : null,
    };
  }

  current(): TestProgramRun | null {
    return this.currentRun;
  }

  observeProcess(status: PLCProcessStatus): void {
    const timestamp = timestampOrNow(status.timestamp, this.now);
    this.lastProcess = status;
    this.markSourceSeen(timestamp);

    if (isPLCProcessComplete(status)) {
      if (this.currentRun?.status === 'RUNNING') {
        this.updateRunEvidence({ process: status });
        const relaySnapshot = this.buildRelayStates(status.io?.outputs, timestamp);
        this.transitionTo('COMPLETE', timestamp, relaySnapshot);
        this.recordRelayChanges(status.io?.outputs, timestamp);
        this.pendingCompletion = { timestamp, status };
      }
      return;
    }

    const stageId = currentStageId(status);
    if (this.currentRun?.status !== 'RUNNING' && isActiveProcess(status)) {
      this.startRun(status, timestamp, stageId);
    }

    if (this.currentRun?.status !== 'RUNNING') return;

    this.updateRunEvidence({ process: status });
    const relaySnapshot = this.buildRelayStates(status.io?.outputs, timestamp);
    this.transitionTo(stageId, timestamp, relaySnapshot);
    this.recordRelayChanges(status.io?.outputs, timestamp);

    if (stageId === 'FAULT') {
      this.finalizeCurrentRun(timestamp, status, 'ABORTED');
    }
  }

  observeSummary(summary: TestProgramFormalSummary): void {
    this.lastSummary = summary;
    const process = summary.process;
    const processTimestamp = numeric(process?.timestamp);
    const lastProcessTimestamp = numeric(this.lastProcess?.timestamp);
    if (process && (!this.lastProcess || (processTimestamp !== null && (lastProcessTimestamp === null || processTimestamp > lastProcessTimestamp)))) {
      this.observeProcess(process);
    }

    if (summary.plcConnected === false && this.currentRun?.status === 'RUNNING') {
      this.sourceLastError = 'FORMAL_PLC_STATUS_DISCONNECTED';
    }
    if (this.currentRun?.status === 'RUNNING') {
      this.updateRunEvidence({
        waveformAnalysis: summary.waveformAnalysis,
        detectorVerdict: summary.detectorVerdict,
        finalVerdict: summary.finalVerdict,
      });
      this.refreshDecisionBasis();
    }

    if (this.pendingCompletion) this.completePending();
  }

  observeFlameState(state: FlameDetectorState): void {
    if (!state || !Array.isArray(state.units)) return;
    this.markSourceSeen(timestampOrNow(state.timestamp, this.now));
    if (this.currentRun?.status === 'RUNNING') {
      for (const unit of state.units) {
        this.observeFullUnitWaveform(unit, state.timestamp);
        this.recordDetectorObservation(unit, state.timestamp);
      }
    } else {
      for (const unit of state.units) {
        const total = numeric(unit.historySampleTotal);
        if (total !== null) this.waveformCursors.set(unit.index, Math.floor(total));
      }
    }
    this.lastDetectorState = compactDetectorState(state);
    if (this.currentRun?.status === 'RUNNING') this.updateRunEvidence({ detectorState: this.lastDetectorState });
  }

  observeWaveformDelta(delta: FlameDetectorWaveformDelta): void {
    if (!delta || !Array.isArray(delta.units)) return;
    const timestamp = timestampOrNow(delta.timestamp, this.now);
    this.markSourceSeen(timestamp);
    if (this.currentRun?.status !== 'RUNNING') {
      for (const unit of delta.units) {
        const previous = this.waveformCursors.get(unit.index) ?? 0;
        this.waveformCursors.set(unit.index, unit.historyReset ? unit.historyDelta.length : previous + unit.historyDelta.length);
      }
      return;
    }

    for (const unit of delta.units) {
      if (unit.historyReset) this.resetUnitWaveform(unit.index);
      this.appendWaveformSamples(
        unit.index,
        unit.address,
        unit.historyDelta,
        unit.rawHistoryDelta,
        timestamp,
      );
      this.recordDetectorObservation(unit, timestamp);
      const previous = this.waveformCursors.get(unit.index) ?? 0;
      this.waveformCursors.set(unit.index, unit.historyReset ? unit.historyDelta.length : previous + unit.historyDelta.length);
    }
  }

  completePending(timestamp = this.pendingCompletion?.timestamp ?? this.now()): void {
    const pending = this.pendingCompletion;
    if (!pending || this.currentRun?.status !== 'RUNNING') return;
    this.finalizeCurrentRun(timestamp, pending.status, 'COMPLETED');
  }

  private startRun(status: PLCProcessStatus, timestamp: number, stageId: TestProgramStageId): void {
    const relaySnapshot = this.buildRelayStates(status.io?.outputs, timestamp);
    this.currentRun = {
      runId: this.runIdFactory(timestamp),
      status: 'RUNNING',
      startedAt: timestamp,
      endedAt: null,
      durationMs: null,
      currentStage: stageId,
      stages: [],
      relayEvents: [],
      latestRelayOutputs: relaySnapshot,
      decision: {
        verdict: null,
        grade: null,
        reasons: [],
        basis: [],
        evaluatedAt: null,
      },
      evidence: {
        process: status,
        detectorState: this.lastDetectorState,
        waveformAnalysis: this.lastSummary?.waveformAnalysis ?? null,
        detectorVerdict: this.lastSummary?.detectorVerdict ?? null,
        finalVerdict: this.lastSummary?.finalVerdict ?? null,
      },
      stagePlan: clone(this.plan),
    };
    this.pendingCompletion = null;
    this.transitionTo(stageId, timestamp, relaySnapshot);
    this.recordRelayChanges(status.io?.outputs, timestamp);
  }

  private updateRunEvidence(patch: Partial<TestProgramFormalEvidenceUpdate>): void {
    const run = this.currentRun;
    if (!run || run.status !== 'RUNNING') return;
    if (patch.process) run.evidence.process = patch.process;
    if (patch.detectorState) run.evidence.detectorState = patch.detectorState;
    if (patch.waveformAnalysis !== undefined) run.evidence.waveformAnalysis = patch.waveformAnalysis ?? null;
    if (patch.detectorVerdict !== undefined) run.evidence.detectorVerdict = patch.detectorVerdict ?? null;
    if (patch.finalVerdict !== undefined) run.evidence.finalVerdict = patch.finalVerdict ?? null;
  }

  private transitionTo(stageId: TestProgramStageId, timestamp: number, relaySnapshot?: TestProgramRelayState[]): void {
    const run = this.currentRun;
    if (!run || run.status !== 'RUNNING') return;
    const previous = run.stages[run.stages.length - 1];
    if (previous?.stageId === stageId) return;
    if (previous) this.closeStage(previous, timestamp, stageId === 'FAULT' ? 'ABORTED' : 'COMPLETED');

    const definition = run.stagePlan.find((item) => item.id === stageId) ?? this.planById.get(stageId) ?? {
      id: stageId,
      label: stageId,
      plannedDurationMs: null,
    };
    const stage: TestProgramStageRecord = {
      sequence: run.stages.length + 1,
      stageId,
      label: definition.label,
      startedAt: timestamp,
      endedAt: null,
      durationMs: null,
      plannedDurationMs: definition.plannedDurationMs,
      durationDeltaMs: null,
      withinPlan: null,
      status: 'RUNNING',
      relaySnapshot: clone(relaySnapshot ?? run.latestRelayOutputs),
      relayEventCount: 0,
      waveforms: [],
      detectorObservations: [],
      detectors: [],
      decisionBasis: [],
    };
    run.stages.push(stage);
    run.currentStage = stageId;
  }

  private closeStage(stage: TestProgramStageRecord, timestamp: number, status: TestProgramStageStatus): void {
    if (stage.endedAt !== null) return;
    stage.decisionBasis = uniqueStrings([...stage.decisionBasis, ...detectorStageBasis(stage)]);
    const durationMs = Math.max(0, timestamp - stage.startedAt);
    stage.endedAt = timestamp;
    stage.durationMs = durationMs;
    stage.durationDeltaMs = stage.plannedDurationMs === null ? null : durationMs - stage.plannedDurationMs;
    stage.withinPlan = stage.plannedDurationMs === null ? null : durationMs <= stage.plannedDurationMs;
    stage.status = status;
  }

  private finalizeCurrentRun(timestamp: number, status: PLCProcessStatus, runStatus: TestProgramRunStatus): void {
    const run = this.currentRun;
    if (!run || run.status !== 'RUNNING') return;
    const finalTimestamp = Math.max(run.startedAt, timestamp);
    this.updateRunEvidence({ process: status });
    const finalVerdict = this.lastSummary?.finalVerdict;
    if (finalVerdict) run.evidence.finalVerdict = finalVerdict;
    const detectorVerdict = this.lastSummary?.detectorVerdict;
    if (detectorVerdict) run.evidence.detectorVerdict = detectorVerdict;
    const analysis = this.lastSummary?.waveformAnalysis;
    if (analysis) run.evidence.waveformAnalysis = analysis;
    this.refreshDecisionBasis();
    const lastStage = run.stages[run.stages.length - 1];
    if (lastStage) this.closeStage(lastStage, finalTimestamp, runStatus === 'ABORTED' ? 'ABORTED' : 'COMPLETED');
    run.status = runStatus;
    run.endedAt = finalTimestamp;
    run.durationMs = Math.max(0, finalTimestamp - run.startedAt);
    run.decision = this.buildDecision(finalTimestamp, status, runStatus);
    this.pendingCompletion = null;
    this.currentRun = run;
    const archived = clone(run);
    this.emit('run_finalized', archived);
    this.onRunFinalized?.(archived);
  }

  private buildDecision(timestamp: number, status: PLCProcessStatus, runStatus: TestProgramRunStatus): TestProgramDecision {
    const finalVerdict = this.currentRun?.evidence.finalVerdict;
    const detectorVerdict = this.currentRun?.evidence.detectorVerdict;
    const analysis = this.currentRun?.evidence.waveformAnalysis;
    const reasons = uniqueStrings([
      status.reason,
      finalVerdict?.reason,
      ...((detectorVerdict?.units ?? []).map((unit) => unit.reason ? `设备${unit.index}: ${unit.reason}` : undefined)),
      ...((analysis?.units ?? []).map((unit) => unit.reason ? `设备${unit.index}: ${unit.reason}` : undefined)),
      ...(runStatus === 'ABORTED' ? ['PLC 工序在 COMPLETE 前进入故障/中止'] : []),
    ]);
    const basis = uniqueStrings([
      `PLC 最终状态：${status.label || status.processLabel || status.processStage}`,
      `PLC 工序码：stage=${status.stageCode}, step=${status.stepCode}`,
      analysis ? `波形分析：${analysis.verdict}/${analysis.phase}，阈值配置已随批次保存` : undefined,
      detectorVerdict ? `探测器判定：${detectorVerdict.verdict}/${detectorVerdict.grade}` : undefined,
      ...runStageBasis(this.currentRun),
    ]);
    return {
      verdict: finalVerdict?.verdict ?? analysis?.verdict ?? detectorVerdict?.verdict ?? (runStatus === 'ABORTED' ? 'FAIL' : null),
      grade: finalVerdict?.grade ?? detectorVerdict?.grade ?? null,
      reasons,
      basis,
      evaluatedAt: timestamp,
    };
  }

  private refreshDecisionBasis(): void {
    const run = this.currentRun;
    if (!run || run.status !== 'RUNNING') return;
    const analysis = run.evidence.waveformAnalysis;
    const current = run.stages[run.stages.length - 1];
    if (!current) return;
    const units = analysis?.units ?? [];
    const basis: string[] = [];
    for (const unit of units) {
      if (current.stageId === 'HEAT_NOISE_CAPTURE') {
        basis.push(`设备${unit.index}：噪声样本 ${unit.noiseSampleCount}，判定 ${unit.noiseTest?.verdict ?? '-'} / ${unit.noiseTest?.reason ?? '-'}`);
      } else if (current.stageId === 'HEAT_INTERFERENCE') {
        const result = unit.stages?.heat;
        basis.push(`设备${unit.index}：热源干扰样本 ${result?.sampleCount ?? 0}，干扰比 ${result?.interferenceRatio ?? '-'}，判定 ${result?.verdict ?? '-'} / ${result?.reason ?? '-'}`);
      } else if (current.stageId === 'FLASH') {
        const result = unit.stages?.flash;
        basis.push(`设备${unit.index}：爆闪样本 ${result?.sampleCount ?? 0}，判定 ${result?.verdict ?? '-'} / ${result?.reason ?? '-'}`);
      } else if (current.stageId === 'EMC') {
        const result = unit.stages?.emc;
        basis.push(`设备${unit.index}：电磁干扰样本 ${result?.sampleCount ?? 0}，判定 ${result?.verdict ?? '-'} / ${result?.reason ?? '-'}`);
      }
    }
    current.decisionBasis = uniqueStrings([...basis, ...detectorStageBasis(current)]);
  }

  private buildRelayStates(outputs: Record<string, boolean> | undefined, timestamp: number): TestProgramRelayState[] {
    const source = outputs ?? {};
    const previous = this.currentRun?.latestRelayOutputs ?? [];
    return PLC_PROGRAM.relays.map((relay) => {
      const before = previous.find((item) => item.key === relay.key);
      const value = source[relay.key] === true;
      return {
        key: relay.key,
        address: relay.address,
        label: relay.label,
        value,
        changedAt: before && before.value !== value ? timestamp : before?.changedAt ?? null,
      };
    });
  }

  private recordRelayChanges(outputs: Record<string, boolean> | undefined, timestamp: number): void {
    if (!outputs) return;
    const source = outputs;
    const previous = this.lastOutputs;
    const run = this.currentRun?.status === 'RUNNING' ? this.currentRun : null;
    const currentStage = run?.currentStage ?? 'UNKNOWN';
    const next: Record<string, boolean> = {};
    for (const relay of PLC_PROGRAM.relays) {
      const value = source[relay.key] === true;
      const before = previous ? previous[relay.key] : null;
      next[relay.key] = value;
      if (run && (before === null || before !== value)) {
        const event: TestProgramRelayEvent = {
          timestamp,
          stageId: currentStage,
          key: relay.key,
          address: relay.address,
          label: relay.label,
          before,
          value,
        };
        run.relayEvents.push(event);
        const currentStageRecord = run.stages[run.stages.length - 1];
        if (currentStageRecord) currentStageRecord.relayEventCount += 1;
      }
    }
    this.lastOutputs = next;
    if (run) run.latestRelayOutputs = this.buildRelayStates(source, timestamp);
  }

  private recordDetectorObservation(unit: DetectorScalarSource, timestampValue: unknown): void {
    const run = this.currentRun;
    if (!run || run.status !== 'RUNNING') return;
    const stage = run.stages[run.stages.length - 1];
    if (!stage) return;
    const timestamp = timestampOrNow(timestampValue, this.now);
    const lastForUnit = [...(stage.detectorObservations ?? [])]
      .reverse()
      .find((observation) => observation.index === unit.index);
    if (lastForUnit?.timestamp === timestamp) return;

    const observation = detectorObservation(unit, stage.stageId, timestamp);
    stage.detectorObservations = [...(stage.detectorObservations ?? []), observation]
      .slice(-this.maxDetectorObservationsPerStage);
    const detectors = stage.detectors ?? (stage.detectors = []);
    let summary = detectors.find((item) => item.index === unit.index);
    if (!summary) {
      summary = {
        index: unit.index,
        address: unit.address,
        observationCount: 0,
        retainedObservationCount: 0,
        firstAt: null,
        lastAt: null,
        onlineCount: 0,
        offlineCount: 0,
        fireCount: 0,
        faultCount: 0,
        sourceNotReadyCount: 0,
        syncNotOkCount: 0,
        latest: null,
        stats: {},
      };
      detectors.push(summary);
    }
    summary.address = observation.address;
    summary.observationCount += 1;
    summary.firstAt ??= timestamp;
    summary.lastAt = timestamp;
    summary.onlineCount += observation.online ? 1 : 0;
    summary.offlineCount += observation.online ? 0 : 1;
    summary.fireCount += observation.fire ? 1 : 0;
    summary.faultCount += observation.fault ? 1 : 0;
    summary.sourceNotReadyCount += observation.sourceReady ? 0 : 1;
    summary.syncNotOkCount += observation.syncOk ? 0 : 1;
    summary.latest = observation;
    for (const key of DETECTOR_SCALAR_KEYS) updateDetectorStats(summary, key, observation[key]);
    for (const item of detectors) {
      item.retainedObservationCount = stage.detectorObservations.filter((entry) => entry.index === item.index).length;
    }
  }

  private observeFullUnitWaveform(unit: FlameDetectorUnitState, timestampValue: unknown): void {
    const timestamp = timestampOrNow(timestampValue, this.now);
    const totalValue = numeric(unit.historySampleTotal);
    const history = Array.isArray(unit.historySamples) ? unit.historySamples : [];
    const rawHistory = Array.isArray(unit.rawHistorySamples) ? unit.rawHistorySamples : [];
    const previous = this.waveformCursors.get(unit.index);
    let samples: FlameSample[] = [];
    let rawSamples: FlameSample[] = [];
    let reset = false;
    if (totalValue !== null) {
      const total = Math.floor(totalValue);
      if (previous === undefined) {
        samples = history;
        rawSamples = rawHistory;
      } else if (total < previous) {
        reset = true;
        samples = history;
        rawSamples = rawHistory;
      } else {
        const deltaCount = total - previous;
        if (deltaCount > 0) {
          samples = deltaCount > history.length ? history : history.slice(-deltaCount);
          rawSamples = deltaCount > rawHistory.length ? rawHistory : rawHistory.slice(-deltaCount);
        }
      }
      this.waveformCursors.set(unit.index, total);
    } else if (previous === undefined) {
      samples = history;
      rawSamples = rawHistory;
    }
    if (reset) this.resetUnitWaveform(unit.index);
    this.appendWaveformSamples(unit.index, unit.address, samples, rawSamples, timestamp);
  }

  private resetUnitWaveform(index: number): void {
    const stage = this.currentRun?.stages[this.currentRun.stages.length - 1];
    if (!stage) return;
    stage.waveforms = stage.waveforms.filter((waveform) => waveform.index !== index);
  }

  private appendWaveformSamples(
    index: number,
    address: number,
    samples: FlameSample[],
    rawSamples: FlameSample[],
    timestamp: number,
  ): void {
    const run = this.currentRun;
    if (!run || run.status !== 'RUNNING') return;
    if (samples.length === 0 && rawSamples.length === 0) return;
    const stage = run.stages[run.stages.length - 1];
    if (!stage) return;
    let waveform = stage.waveforms.find((item) => item.index === index);
    if (!waveform) {
      waveform = {
        index,
        address,
        sampleCount: 0,
        rawSampleCount: 0,
        firstAt: timestamp,
        lastAt: timestamp,
        channels: {},
        samples: [],
        rawSamples: [],
      };
      stage.waveforms.push(waveform);
    }
    waveform.address = address;
    waveform.sampleCount += samples.length;
    waveform.rawSampleCount += rawSamples.length;
    waveform.lastAt = timestamp;
    waveform.samples = [...waveform.samples, ...samples].slice(-this.maxSamplesPerUnitStage);
    waveform.rawSamples = [...waveform.rawSamples, ...rawSamples].slice(-this.maxSamplesPerUnitStage);
    waveform.channels = summarizeChannels(waveform.samples);
  }
}

interface TestProgramFormalEvidenceUpdate {
  process?: PLCProcessStatus;
  detectorState?: FlameDetectorState;
  waveformAnalysis?: FieldWaveformAnalysisSnapshot | null;
  detectorVerdict?: FieldDetectorBatchVerdict | null;
  finalVerdict?: FieldFinalVerdict | null;
}

function runStageBasis(run: TestProgramRun | null): string[] {
  if (!run) return [];
  return run.stages.flatMap((stage) => stage.decisionBasis.map((basis) => `${stage.label}: ${basis}`));
}

export function summarizeTestProgramRun(run: TestProgramRun): {
  runId: string;
  status: TestProgramRun['status'];
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
} {
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    verdict: run.decision.verdict,
    grade: run.decision.grade,
    stageCount: run.stages.length,
    completedStageCount: run.stages.filter((stage) => stage.status === 'COMPLETED').length,
    waveformSampleCount: runSampleCount(run),
    detectorObservationCount: runDetectorObservationCount(run),
    relayEventCount: run.relayEvents.length,
  };
}

export { currentStageId as resolveTestProgramStage, isActiveProcess as isTestProgramProcessActive };
