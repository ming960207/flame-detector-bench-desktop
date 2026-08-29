import { randomUUID } from 'node:crypto';
import {
  type ClosureCommand,
  type ClosureCommandResult,
  type ClosureState,
  type Clock,
  type DetectorBatchStatus,
} from './types.js';

export interface OfflineEngineCheckpoint {
  state: ClosureState;
  completedCommands: Map<string, ClosureCommandResult>;
}

const STAGE_CODES: Record<ClosureState['stage'], readonly [number, number]> = {
  IDLE: [0, 0],
  INIT: [1, 1],
  HEAT: [2, 2],
  FLASH: [3, 3],
  EMC: [4, 3],
  // The PLC returns to its initial-position sequence after EMC (M10.0/M29.2).
  RETURN_HOME: [1, 1],
  COMPLETE: [0, 0],
  ABORTED: [0, 0],
};

const MAX_COMPLETED_COMMANDS = 1_024;

const NEXT_STAGE: Partial<Record<ClosureState['stage'], ClosureState['stage']>> = {
  INIT: 'HEAT',
  HEAT: 'FLASH',
  FLASH: 'EMC',
  EMC: 'RETURN_HOME',
  RETURN_HOME: 'COMPLETE',
};

function cloneState(state: ClosureState): ClosureState {
  return { ...state };
}

export class OfflineEngine {
  private state: ClosureState;
  private readonly completedCommands = new Map<string, ClosureCommandResult>();
  private readonly now: Clock;

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now;
    this.state = this.createIdleState(false);
  }

  getState(): ClosureState {
    return cloneState(this.state);
  }

  createCheckpoint(): OfflineEngineCheckpoint {
    return {
      state: this.getState(),
      completedCommands: new Map([...this.completedCommands].map(([requestId, result]) => [
        requestId,
        { ...result, state: cloneState(result.state) },
      ])),
    };
  }

  restoreCheckpoint(checkpoint: OfflineEngineCheckpoint): void {
    this.state = cloneState(checkpoint.state);
    this.completedCommands.clear();
    for (const [requestId, result] of checkpoint.completedCommands) {
      this.completedCommands.set(requestId, { ...result, state: cloneState(result.state) });
    }
  }

  setSafetyReady(safetyReady: boolean): ClosureState {
    if (this.state.safetyReady === safetyReady) return this.getState();

    if (!safetyReady && this.state.running) {
      this.transition({
        safetyReady: false,
        running: false,
        completed: false,
        alarm: true,
        stage: 'ABORTED',
        activeBatchId: undefined,
        detectorBatch: 'unknown',
        reportGate: 'blocked',
        reasonCode: 'SAFETY_LOST',
      });
      return this.getState();
    }

    this.transition({ safetyReady, reasonCode: safetyReady ? undefined : 'SAFETY_NOT_READY' });
    return this.getState();
  }

  submit(command: ClosureCommand): ClosureCommandResult {
    return this.submitIdempotently(command, () => this.execute(command));
  }

  submitBatch(command: ClosureCommand, status: Extract<DetectorBatchStatus, 'valid' | 'invalid'>, reasonCode?: string): ClosureCommandResult {
    return this.submitIdempotently(command, () => {
      if (!this.state.running || !this.state.activeBatchId) return this.reject(command, 'CYCLE_NOT_RUNNING');
      if (command.batchId !== this.state.activeBatchId) return this.reject(command, 'ACTIVE_BATCH_ID_MISMATCH');
      if (this.state.stage !== 'EMC') return this.reject(command, 'DETECTOR_STAGE_NOT_READY');

      this.setDetectorBatchStatus(status, reasonCode);
      return this.accept(command, status === 'invalid' ? reasonCode ?? 'DETECTOR_BATCH_INVALID' : undefined);
    });
  }

  private submitIdempotently(command: ClosureCommand, execute: () => ClosureCommandResult): ClosureCommandResult {
    const duplicate = this.completedCommands.get(command.requestId);
    if (duplicate) return { ...duplicate, status: 'duplicate', state: this.getState() };

    if (!Number.isSafeInteger(command.sequence) || command.sequence < this.state.nextCommandSequence) {
      const stale = this.reject(command, 'COMMAND_SEQUENCE_STALE');
      this.rememberCommand(command.requestId, stale);
      return stale;
    }

    this.transition({ nextCommandSequence: command.sequence + 1 });

    const result = execute();
    this.rememberCommand(command.requestId, result);
    return result;
  }

  advanceStage(): ClosureState {
    const nextStage = NEXT_STAGE[this.state.stage];
    if (!nextStage) {
      if (this.state.stage === 'COMPLETE') throw new Error('STAGE_ALREADY_COMPLETE');
      throw new Error('STAGE_NOT_RUNNING');
    }

    const reportGate = this.state.detectorBatch === 'valid' && nextStage === 'COMPLETE' && !this.state.alarm
      ? 'ready'
      : 'blocked';
    this.transition({
      stage: nextStage,
      running: nextStage !== 'COMPLETE',
      completed: nextStage === 'COMPLETE',
      reportGate,
      reasonCode: this.state.detectorBatch === 'invalid' ? this.state.reasonCode : undefined,
    });
    return this.getState();
  }

  setDetectorBatchStatus(status: DetectorBatchStatus, reasonCode?: string): ClosureState {
    if (this.state.detectorBatch === 'invalid' && status !== 'invalid') return this.getState();

    const reportGate = status === 'valid' && this.state.stage === 'COMPLETE' && !this.state.alarm
      ? 'ready'
      : 'blocked';
    this.transition({ detectorBatch: status, reportGate, reasonCode });
    return this.getState();
  }

  private execute(command: ClosureCommand): ClosureCommandResult {
    switch (command.type) {
      case 'START': return this.start(command);
      case 'STOP': return this.stop(command);
      case 'RESET': return this.reset(command);
      case 'SUBMIT_BATCH': return this.reject(command, 'BATCH_SUBMISSION_REQUIRES_SNAPSHOTS');
    }
  }

  private start(command: ClosureCommand): ClosureCommandResult {
    if (!this.state.safetyReady) return this.reject(command, 'SAFETY_NOT_READY');
    if (this.state.alarm) return this.reject(command, 'ALARM_ACTIVE');
    if (this.state.running) return this.reject(command, 'CYCLE_ALREADY_RUNNING');

    const batchId = `offline-${command.sequence}-${this.now()}-${randomUUID()}`;
    this.transition({
      running: true,
      completed: false,
      stage: 'INIT',
      activeBatchId: batchId,
      detectorBatch: 'pending',
      reportGate: 'blocked',
      reasonCode: undefined,
    });
    return this.accept(command);
  }

  private stop(command: ClosureCommand): ClosureCommandResult {
    if (!this.state.running || !this.state.activeBatchId) return this.reject(command, 'CYCLE_NOT_RUNNING');
    if (command.batchId !== this.state.activeBatchId) return this.reject(command, 'ACTIVE_BATCH_ID_MISMATCH');

    this.transition({
      running: false,
      completed: false,
      stage: 'ABORTED',
      activeBatchId: undefined,
      detectorBatch: 'unknown',
      reportGate: 'blocked',
      reasonCode: 'STOP_REQUESTED',
    });
    return this.accept(command);
  }

  private reset(command: ClosureCommand): ClosureCommandResult {
    const safetyReady = this.state.safetyReady;
    this.state = this.createIdleState(safetyReady, this.state.stateVersion + 1, this.state.nextCommandSequence);
    return this.accept(command);
  }

  private accept(command: ClosureCommand, reasonCode?: string): ClosureCommandResult {
    return { status: 'accepted', reasonCode, command, state: this.getState() };
  }

  private reject(command: ClosureCommand, reasonCode: string): ClosureCommandResult {
    return { status: 'rejected', reasonCode, command, state: this.getState() };
  }

  private rememberCommand(requestId: string, result: ClosureCommandResult): void {
    this.completedCommands.set(requestId, { ...result, state: cloneState(result.state) });
    while (this.completedCommands.size > MAX_COMPLETED_COMMANDS) {
      const oldestRequestId = this.completedCommands.keys().next().value;
      if (oldestRequestId === undefined) return;
      this.completedCommands.delete(oldestRequestId);
    }
  }

  private transition(patch: Partial<Omit<ClosureState, 'mode' | 'stateVersion'>>): void {
    const stage = patch.stage ?? this.state.stage;
    const [stageCode, stepCode] = STAGE_CODES[stage];
    this.state = { ...this.state, ...patch, stage, stageCode, stepCode, stateVersion: this.state.stateVersion + 1 };
  }

  private createIdleState(safetyReady: boolean, stateVersion = 0, nextCommandSequence = 1): ClosureState {
    const [stageCode, stepCode] = STAGE_CODES.IDLE;
    return {
      mode: 'offline', stateVersion, nextCommandSequence, safetyReady, running: false, completed: false, alarm: false,
      stage: 'IDLE', stageCode, stepCode, detectorBatch: 'unknown', reportGate: 'blocked',
    };
  }
}
