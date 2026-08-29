import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldFinalVerdict } from '../dist/closure/field-final-verdict.js';
import { decodePLCProcessStatus, hasActivePLCProcessAlarm, isPLCProcessComplete } from '../dist/process-status.js';

test('latched completion remains reportable when the post-run alarm/stop state is active', () => {
  const process = decodePLCProcessStatus({
    stageCode: 0,
    stepCode: 0,
    autoRunning: false,
    complete: true,
    alarm: true,
    returningHome: false,
    timestamp: 50,
  });
  const detectorVerdict = { verdict: 'PASS', units: [], onlineCount: 6, passCount: 6, failCount: 0, pendingCount: 0 };
  const waveformAnalysis = { batchId: 'batch-1', phase: 'COMPLETE', verdict: 'PASS', thresholds: {} };

  assert.equal(process.stage, 'COMPLETE');
  assert.equal(process.processStage, 'COMPLETE');
  assert.equal(process.alarm, true, 'the raw safety indication remains available to the alarm panel');
  assert.deepEqual(evaluateFieldFinalVerdict(process, detectorVerdict, waveformAnalysis), { verdict: 'PASS' });
});

test('completion evidence wins over a legacy fault wrapper and post-run stop bits', () => {
  const process = {
    stageCode: 0,
    stepCode: 0,
    autoRunning: false,
    complete: true,
    alarm: true,
    returningHome: false,
    timestamp: 51,
    stage: 'FAULT',
    label: '故障/中止',
    processStage: 'COMPLETE',
    processLabel: '已完成',
    valid: true,
    io: {
      inputs: {},
      outputs: {},
      internal: { complete: true, stopLatch: true, stopRequest: true },
      steps: {},
      syncedAt: 51,
    },
  };
  const detectorVerdict = { verdict: 'PASS', units: [], onlineCount: 6, passCount: 6, failCount: 0, pendingCount: 0 };
  const waveformAnalysis = { batchId: 'batch-1', phase: 'COMPLETE', verdict: 'PASS', thresholds: {} };

  assert.equal(isPLCProcessComplete(process), true);
  assert.equal(hasActivePLCProcessAlarm(process), false);
  assert.deepEqual(evaluateFieldFinalVerdict(process, detectorVerdict, waveformAnalysis), { verdict: 'PASS' });
});
