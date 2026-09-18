import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldFinalVerdict } from '../src/closure/field-final-verdict.js';
import { FieldWaveformAnalysis } from '../src/closure/field-waveform-analysis.js';
import type { FieldDetectorBatchVerdict } from '../src/closure/field-detector-verdict.js';
import type { PLCProcessCurrentStage, PLCProcessStatus } from '../src/process-status.js';

function plcStatus(
  timestamp: number,
  processStage: PLCProcessCurrentStage,
  autoRunning: boolean,
  complete = false,
): PLCProcessStatus {
  const stageCode = processStage === 'HEAT' ? 2 : processStage === 'INIT' ? 1 : 0;
  const stepCode = processStage === 'HEAT' ? 2 : processStage === 'INIT' ? 1 : 0;
  return {
    stageCode,
    stepCode,
    autoRunning,
    complete,
    alarm: false,
    returningHome: false,
    timestamp,
    io: {
      inputs: {},
      outputs: {},
      internal: { autoRunning, complete },
      steps: {},
      syncedAt: timestamp,
    },
    stage: processStage,
    label: processStage,
    processStage,
    processLabel: processStage,
    heatSubstage: 'IDLE',
    heatSubstageLabel: '非热源阶段',
    valid: true,
  };
}

const completedDetectorVerdict: FieldDetectorBatchVerdict = {
  verdict: 'PASS',
  grade: 'A_PASS',
  units: [],
  timestamp: 1_000,
  testInvalidCount: 0,
  productFailCount: 0,
};

const qualityThresholds = {
  quality: {
    acceptanceGrade: 'A' as const,
    a: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0, minSensitivity: 0 },
    b: { maxNoiseRms: 220, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0, minSensitivity: 0 },
    ratios: {
      a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } },
      b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.45, max: 1.65 }, snr31: { min: 0, max: 0 } },
    },
  },
} as any;

test('completed production verdict remains visible after PLC returns to idle or becomes unavailable', () => {
  const completedWaveform = {
    batchId: 'batch-complete-1',
    phase: 'COMPLETE' as const,
    verdict: 'PASS' as const,
    thresholds: qualityThresholds,
  };

  assert.deepEqual(
    evaluateFieldFinalVerdict(plcStatus(2_000, 'IDLE', false), completedDetectorVerdict, completedWaveform),
    { verdict: 'PASS', grade: 'A_PASS' },
  );
  assert.deepEqual(
    evaluateFieldFinalVerdict(undefined, completedDetectorVerdict, completedWaveform),
    { verdict: 'PASS', grade: 'A_PASS' },
  );
});

test('waveform batch stays COMPLETE through idle and initializes only when the next automatic run starts', () => {
  const analysis = new FieldWaveformAnalysis();

  analysis.observeProcess(plcStatus(1_000, 'HEAT', true));
  const running = analysis.snapshot();
  assert.ok(running.batchId);
  assert.notEqual(running.phase, 'COMPLETE');

  analysis.observeProcess(plcStatus(2_000, 'COMPLETE', false, true));
  const completed = analysis.snapshot();
  assert.equal(completed.phase, 'COMPLETE');
  assert.equal(completed.batchId, running.batchId);

  analysis.observeProcess(plcStatus(3_000, 'IDLE', false));
  const idle = analysis.snapshot();
  assert.equal(idle.phase, 'COMPLETE');
  assert.equal(idle.batchId, completed.batchId);

  const heldVerdict = evaluateFieldFinalVerdict(
    plcStatus(3_000, 'IDLE', false),
    completedDetectorVerdict,
    { ...idle, verdict: 'PASS', thresholds: qualityThresholds },
  );
  assert.deepEqual(heldVerdict, { verdict: 'PASS', grade: 'A_PASS' });

  analysis.observeProcess(plcStatus(4_000, 'HEAT', true));
  const nextRun = analysis.snapshot();
  assert.notEqual(nextRun.batchId, completed.batchId);
  assert.notEqual(nextRun.phase, 'COMPLETE');

  const initializedVerdict = evaluateFieldFinalVerdict(
    plcStatus(4_000, 'HEAT', true),
    { ...completedDetectorVerdict, verdict: 'PENDING', grade: 'PENDING', timestamp: 4_000 },
    { ...nextRun, verdict: 'PENDING', thresholds: qualityThresholds },
  );
  assert.deepEqual(initializedVerdict, { verdict: 'PENDING', reason: 'WAITING_FOR_PLC_COMPLETE' });
});
