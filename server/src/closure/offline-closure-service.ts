import { OfflineEngine, type OfflineEngineCheckpoint } from './offline-engine.js';
import { validateDetectorBatch } from './detector-batch.js';
import {
  type ClosureCommand,
  type ClosureCommandResult,
  type ClosureState,
  type Clock,
  type DetectorSnapshot,
} from './types.js';

export type { ClosureCommand, ClosureCommandResult, ClosureState, DetectorSnapshot } from './types.js';

export class OfflineClosureService {
  private readonly engine: OfflineEngine;
  private readonly now: Clock;

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now;
    this.engine = new OfflineEngine(options);
  }

  getState(): ClosureState { return this.engine.getState(); }
  createCheckpoint(): OfflineEngineCheckpoint { return this.engine.createCheckpoint(); }
  restoreCheckpoint(checkpoint: OfflineEngineCheckpoint): void { this.engine.restoreCheckpoint(checkpoint); }
  setSafetyReady(safetyReady: boolean): ClosureState { return this.engine.setSafetyReady(safetyReady); }
  submit(command: ClosureCommand): ClosureCommandResult {
    if (command.type !== 'SUBMIT_BATCH') return this.engine.submit(command);

    const validation = validateDetectorBatch(this.engine.getState(), command.snapshots ?? [], this.now());
    return this.engine.submitBatch(command, validation.status, validation.reasonCode);
  }
  advanceStage(): ClosureState { return this.engine.advanceStage(); }

  submitDetectorSnapshots(snapshots: DetectorSnapshot[]): ClosureState {
    const validation = validateDetectorBatch(this.engine.getState(), snapshots, this.now());
    return this.engine.setDetectorBatchStatus(validation.status, validation.reasonCode);
  }
}
