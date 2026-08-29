export type ClosureCommandType = 'START' | 'STOP' | 'RESET' | 'SUBMIT_BATCH';
export type ClosureCommandSource = 'UI' | 'API' | 'TEST';
export type ClosureStage = 'IDLE' | 'INIT' | 'HEAT' | 'FLASH' | 'EMC' | 'RETURN_HOME' | 'COMPLETE' | 'ABORTED';
export type ClosureCommandStatus = 'accepted' | 'rejected' | 'duplicate';
export type DetectorBatchStatus = 'pending' | 'valid' | 'invalid' | 'unknown';
export type ReportGate = 'blocked' | 'ready';
export type DetectorVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ClosureCommand {
  requestId: string;
  sequence: number;
  type: ClosureCommandType;
  source: ClosureCommandSource;
  issuedAt: number;
  batchId?: string;
  snapshots?: DetectorSnapshot[];
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
  verdict: DetectorVerdict;
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
  reportGate: ReportGate;
  reasonCode?: string;
}

export interface ClosureCommandResult {
  status: ClosureCommandStatus;
  reasonCode?: string;
  command: ClosureCommand;
  state: ClosureState;
}

export type ClosureAuditEventType = 'command' | 'simulation_input';

export interface ClosureAuditEvent {
  schemaVersion: 1;
  eventType: ClosureAuditEventType;
  occurredAt: number;
  batchId?: string;
  state: ClosureState;
  command?: ClosureCommand;
  commandResult?: ClosureCommandResult;
  simulationInput?: {
    type: 'SAFETY' | 'ADVANCE_STAGE';
    safetyReady?: boolean;
  };
  previousAuditHash?: string | null;
  auditHash?: string;
}

export type Clock = () => number;
