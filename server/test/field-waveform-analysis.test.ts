import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldWaveformAnalysis } from '../src/closure/field-waveform-analysis.js';
import type { PLCProcessStatus } from '../src/process-status.js';

function status(timestamp: number): PLCProcessStatus {
  return {
    stageCode: 2,
    stepCode: 2,
    autoRunning: true,
    complete: false,
    alarm: false,
    returningHome: false,
    timestamp,
    stage: 'HEAT',
    label: '移动热源',
    processStage: 'HEAT',
    processLabel: '移动热源',
    heatSubstage: 'SIGNAL_STABILIZATION',
    heatSubstageLabel: '信号稳定阶段',
    valid: true,
    io: {
      inputs: {},
      outputs: {},
      internal: {
        autoRunning: true,
        complete: false,
        processAlarm: false,
        safetyOk: true,
        stopLatch: false,
        stopRequest: false,
        safetyLimit: false,
        startRequest: true,
        manualEnable: false,
        signalStabilizing: true,
        noiseCaptureWindow: true,
        returnHomeFlag: false,
      },
      steps: {
        stepM10_4: false,
        stepM11_0: false,
        stepM11_2: false,
      },
      syncedAt: timestamp,
    },
  };
}

test('noise capture waits 10 seconds for signal stabilization before opening', () => {
  const analysis = new FieldWaveformAnalysis();

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(9_999));
  assert.equal(analysis.snapshot().heatSubstage, 'SIGNAL_STABILIZATION');
  assert.equal(analysis.snapshot().noiseCaptureActive, false);

  analysis.observeProcess(status(11_000));
  const snapshot = analysis.snapshot();
  assert.equal(snapshot.heatSubstage, 'NOISE_CAPTURE');
  assert.equal(snapshot.noiseCaptureActive, true);
  assert.equal(snapshot.noiseStartedAt, 11_000);
});
