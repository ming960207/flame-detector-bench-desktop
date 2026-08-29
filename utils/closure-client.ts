export type ClosureCommandType = 'START' | 'STOP' | 'RESET' | 'SUBMIT_BATCH';
export type ClosureStage = 'IDLE' | 'INIT' | 'HEAT' | 'FLASH' | 'EMC' | 'RETURN_HOME' | 'COMPLETE' | 'ABORTED';
export type DetectorBatchStatus = 'pending' | 'valid' | 'invalid' | 'unknown';

export interface ClosureCommand {
  type: ClosureCommandType;
  requestId: string;
  sequence: number;
  source: 'UI';
  issuedAt: number;
  batchId?: string;
  snapshots?: DetectorSnapshot[];
}

export interface ClosureState {
  mode: 'offline';
  stateVersion: number;
  nextCommandSequence: number;
  safetyReady: boolean;
  running: boolean;
  completed: boolean;
  alarm: boolean;
  stage: ClosureStage;
  stageCode: number;
  stepCode: number;
  activeBatchId?: string;
  detectorBatch: DetectorBatchStatus;
  reportGate: 'blocked' | 'ready';
  reasonCode?: string;
}

export interface ClosureCommandResult {
  status: 'accepted' | 'rejected' | 'duplicate';
  reasonCode?: string;
  command: ClosureCommand;
  state: ClosureState;
}

export interface ClosureAuditEvent {
  schemaVersion: 1;
  eventType: 'command' | 'simulation_input';
  occurredAt: number;
  batchId?: string;
  state: ClosureState;
  command?: ClosureCommand;
  commandResult?: ClosureCommandResult;
  simulationInput?: {
    type: 'SAFETY' | 'ADVANCE_STAGE';
    safetyReady?: boolean;
  };
}

export interface DetectorSnapshot {
  batchId: string;
  index: number;
  expectedAddress: number;
  reportedAddress: number;
  communicationSequence: number;
  sampledAt: number;
  validUntil: number;
  online: boolean;
  sourceReady: boolean;
  syncOk: boolean;
  fault: boolean;
  fire: boolean;
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
}

export const CLOSURE_STAGES: Array<{ stage: ClosureStage; label: string; subtitle: string }> = [
  { stage: 'INIT', label: '01 初始化', subtitle: '准备与联锁确认' },
  { stage: 'HEAT', label: '02 移动热源', subtitle: '工艺阶段' },
  { stage: 'FLASH', label: '03 爆闪干扰', subtitle: '工艺阶段' },
  { stage: 'EMC', label: '04 电磁占位', subtitle: '结果校验窗口' },
  { stage: 'RETURN_HOME', label: '05 回初始位', subtitle: '回零确认，禁止提前放行报告' },
  { stage: 'COMPLETE', label: '完成', subtitle: '报告门禁裁决' },
];

export function createClosureCommand(
  type: ClosureCommandType,
  sequence: number,
  requestId: string,
  issuedAt = Date.now(),
  batchId?: string,
  snapshots?: DetectorSnapshot[],
): ClosureCommand {
  return {
    type,
    requestId,
    sequence,
    source: 'UI',
    issuedAt,
    ...(batchId === undefined ? {} : { batchId }),
    ...(snapshots === undefined ? {} : { snapshots }),
  };
}

export function isOfflineReportReady(state: ClosureState): boolean {
  return state.mode === 'offline'
    && state.stage === 'COMPLETE'
    && state.completed
    && typeof state.activeBatchId === 'string'
    && state.activeBatchId.length > 0
    && state.detectorBatch === 'valid'
    && state.reportGate === 'ready'
    && !state.alarm;
}

export function canStartOfflineCycle(state: ClosureState): boolean {
  return state.mode === 'offline' && !state.running && !state.alarm;
}

export function canStopOfflineCycle(state: ClosureState): boolean {
  return state.mode === 'offline' && state.running && typeof state.activeBatchId === 'string' && state.activeBatchId.length > 0;
}

export function canAdvanceOfflineStage(state: ClosureState): boolean {
  return state.mode === 'offline'
    && state.running
    && (state.stage === 'INIT' || state.stage === 'HEAT' || state.stage === 'FLASH' || state.stage === 'EMC' || state.stage === 'RETURN_HOME');
}

export function hasCurrentCompletionAuditEvidence(events: readonly ClosureAuditEvent[], state: ClosureState): boolean {
  if (!isOfflineReportReady(state) || !state.activeBatchId) return false;
  return events.some((event) => event.batchId === state.activeBatchId
    && event.state.activeBatchId === state.activeBatchId
    && event.state.stateVersion === state.stateVersion
    && isOfflineReportReady(event.state));
}

export function shouldApplyClosureState(currentVersion: number, nextVersion: number): boolean {
  return nextVersion >= currentVersion;
}

export function createPassSnapshots(batchId: string, now = Date.now()): DetectorSnapshot[] {
  return Array.from({ length: 6 }, (_, index) => ({
    batchId,
    index: index + 1,
    expectedAddress: index + 1,
    reportedAddress: index + 1,
    communicationSequence: index + 1,
    sampledAt: now,
    validUntil: now + 30_000,
    online: true,
    sourceReady: true,
    syncOk: true,
    fault: false,
    fire: true,
    verdict: 'PASS',
  }));
}
