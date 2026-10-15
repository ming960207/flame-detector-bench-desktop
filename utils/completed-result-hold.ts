import type { PLCProcessStatus } from '../server/src/process-status';

interface ResultSummary {
  process?: PLCProcessStatus;
  waveformAnalysis?: { batchId: string | null; phase: string; startedAt: number | null };
  detectorVerdict?: unknown;
  finalVerdict: { verdict: string };
}

/** Lock production evidence before render coalescing, while keeping live controls/I/O current. */
export function createCompletedResultHold<Summary extends ResultSummary>() {
  let held: Summary | null = null;
  let batchId: string | null = null;
  let startedAt: number | null = null;
  let latest: Summary | null = null;

  return {
    accept(incoming: Summary): Summary {
      const incomingBatch = incoming.waveformAnalysis?.batchId;
      const incomingStart = incoming.waveformAnalysis?.startedAt ?? null;
      // A delayed HTTP response or old WebSocket snapshot cannot reopen an older run.
      const olderBatch = Boolean(incomingBatch && batchId && incomingBatch !== batchId
        && incomingStart !== null && startedAt !== null && incomingStart <= startedAt);
      if (olderBatch && latest) return latest;
      if (incomingBatch && incomingBatch !== batchId && !olderBatch) {
        batchId = incomingBatch;
        startedAt = incomingStart;
        held = null;
      }
      if (!held && !olderBatch && incomingBatch && incoming.waveformAnalysis?.phase === 'COMPLETE'
        && (incoming.finalVerdict.verdict === 'PASS' || incoming.finalVerdict.verdict === 'FAIL')) {
        held = incoming;
      }
      if (!held) return latest = incoming;
      // Same-batch COMPLETE frames can also be recomputed from changing live fault bits.
      // Freeze only evidence/result fields; product selection, precheck and relay controls stay live.
      return latest = {
        ...incoming,
        waveformAnalysis: held.waveformAnalysis,
        detectorVerdict: held.detectorVerdict,
        finalVerdict: held.finalVerdict,
      };
    },
    completed(): Summary | null { return held; },
  };
}

export function hasCompletedResult(summary: ResultSummary): boolean {
  return Boolean(summary.waveformAnalysis?.batchId && summary.waveformAnalysis.phase === 'COMPLETE'
    && (summary.finalVerdict.verdict === 'PASS' || summary.finalVerdict.verdict === 'FAIL'));
}

export function detectorResultTone(
  fault: boolean,
  grade: string | undefined,
  completed: boolean,
): 'pass' | 'fail' | 'pending' {
  if (grade === 'FAIL' || (!completed && fault)) return 'fail';
  if (grade === 'A_PASS' || grade === 'B_PASS') return 'pass';
  return 'pending';
}
