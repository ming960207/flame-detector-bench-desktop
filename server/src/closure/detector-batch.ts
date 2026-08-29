import { type ClosureState, type DetectorSnapshot } from './types.js';

export interface DetectorBatchValidation {
  status: 'valid' | 'invalid';
  reasonCode?: string;
}

export function validateDetectorBatch(
  state: ClosureState,
  snapshots: readonly DetectorSnapshot[],
  now: number,
): DetectorBatchValidation {
  if (!state.activeBatchId) return invalid('DETECTOR_NO_ACTIVE_BATCH');
  if (state.stage !== 'EMC') return invalid('DETECTOR_STAGE_NOT_READY');
  if (snapshots.length !== 6) return invalid('DETECTOR_UNIT_COUNT_INVALID');

  const indexes = new Set<number>();
  for (const snapshot of snapshots) {
    if (!isDetectorSnapshot(snapshot)) return invalid('DETECTOR_SNAPSHOT_INVALID');
    if (snapshot.batchId !== state.activeBatchId) return invalid('DETECTOR_BATCH_ID_MISMATCH');
    if (!Number.isInteger(snapshot.index) || snapshot.index < 1 || snapshot.index > 6 || indexes.has(snapshot.index)) {
      return invalid('DETECTOR_INDEX_INVALID');
    }
    indexes.add(snapshot.index);
    if (snapshot.expectedAddress !== snapshot.reportedAddress) return invalid('DETECTOR_ADDRESS_MISMATCH');
    if (!Number.isInteger(snapshot.communicationSequence) || snapshot.communicationSequence < 1) {
      return invalid('DETECTOR_SEQUENCE_INVALID');
    }
    if (snapshot.sampledAt > now) return invalid('DETECTOR_SNAPSHOT_NOT_YET_VALID');
    if (snapshot.validUntil < now || snapshot.validUntil < snapshot.sampledAt) {
      return invalid('DETECTOR_SNAPSHOT_EXPIRED');
    }
    if (!snapshot.online) return invalid('DETECTOR_OFFLINE');
    if (!snapshot.sourceReady) return invalid('DETECTOR_SOURCE_NOT_READY');
    if (!snapshot.syncOk) return invalid('DETECTOR_SYNC_NOT_OK');
    if (snapshot.fault) return invalid('DETECTOR_FAULT');
    if (!snapshot.fire) return invalid('DETECTOR_FIRE_NOT_DETECTED');
    if (snapshot.verdict === 'UNKNOWN') return invalid('DETECTOR_VERDICT_UNKNOWN');
    if (snapshot.verdict === 'FAIL') return invalid('DETECTOR_VERDICT_FAIL');
  }

  return { status: 'valid' };
}

function isDetectorSnapshot(value: unknown): value is DetectorSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DetectorSnapshot>;
  return typeof snapshot.batchId === 'string'
    && Number.isFinite(snapshot.index)
    && Number.isFinite(snapshot.expectedAddress)
    && Number.isFinite(snapshot.reportedAddress)
    && Number.isFinite(snapshot.communicationSequence)
    && Number.isFinite(snapshot.sampledAt)
    && Number.isFinite(snapshot.validUntil)
    && typeof snapshot.online === 'boolean'
    && typeof snapshot.sourceReady === 'boolean'
    && typeof snapshot.syncOk === 'boolean'
    && typeof snapshot.fault === 'boolean'
    && typeof snapshot.fire === 'boolean'
    && (snapshot.verdict === 'PASS' || snapshot.verdict === 'FAIL' || snapshot.verdict === 'UNKNOWN');
}

function invalid(reasonCode: string): DetectorBatchValidation {
  return { status: 'invalid', reasonCode };
}
