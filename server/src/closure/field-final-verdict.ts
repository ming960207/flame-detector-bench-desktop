import { isPLCProcessComplete, type PLCProcessStatus } from '../process-status.js';
import type { FieldDetectorBatchVerdict, FieldDetectorVerdict, FieldQualityGrade } from './field-detector-verdict.js';
import type { FieldWaveformAnalysisSnapshot } from './field-waveform-analysis.js';

export interface FieldFinalVerdict {
  verdict: FieldDetectorVerdict;
  grade?: FieldQualityGrade;
  reason?: 'WAITING_FOR_PLC_COMPLETE' | 'PLC_PROCESS_STATUS_INVALID' | 'WAITING_FOR_WAVEFORM_ANALYSIS';
}

/**
 * A detector batch may be technically ready before the mechanical process has
 * finished.  Do not expose that intermediate evaluation as a production result.
 */
export function evaluateFieldFinalVerdict(
  process: Pick<PLCProcessStatus, 'stage' | 'processStage' | 'complete' | 'valid'>
    & Partial<Pick<PLCProcessStatus, 'io'>> | undefined,
  detectorVerdict: FieldDetectorBatchVerdict,
  waveformAnalysis?: Pick<FieldWaveformAnalysisSnapshot, 'batchId' | 'phase' | 'verdict' | 'thresholds'>,
): FieldFinalVerdict {
  if (!process || !process.valid) return { verdict: 'PENDING', reason: 'PLC_PROCESS_STATUS_INVALID' };
  if (!isPLCProcessComplete(process)) return { verdict: 'PENDING', reason: 'WAITING_FOR_PLC_COMPLETE' };
  const qualityEnabled = Boolean((waveformAnalysis as (Pick<FieldWaveformAnalysisSnapshot, 'thresholds'> | undefined))?.thresholds?.quality);
  if (waveformAnalysis && waveformAnalysis.verdict !== 'PASS') {
    return waveformAnalysis.verdict === 'FAIL'
      ? qualityEnabled ? { verdict: 'FAIL', grade: 'FAIL' } : { verdict: 'FAIL' }
      : { verdict: 'PENDING', reason: 'WAITING_FOR_WAVEFORM_ANALYSIS' };
  }
  if (qualityEnabled && detectorVerdict.grade === 'PENDING') {
    return { verdict: 'PENDING', reason: 'WAITING_FOR_WAVEFORM_ANALYSIS' };
  }
  if (qualityEnabled) return { verdict: detectorVerdict.verdict, grade: detectorVerdict.grade };
  return { verdict: detectorVerdict.verdict };
}
