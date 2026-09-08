import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldWaveformAnalysis } from '../src/closure/field-waveform-analysis.js';
import type { PLCProcessStatus } from '../src/process-status.js';
import type { FlameDetectorState, FlameDetectorUnitState } from '../src/types.js';

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

function detectorUnit(lastUpdate: number, samples: FlameDetectorUnitState['samples']): FlameDetectorUnitState {
  return {
    index: 1,
    address: 1,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 5,
    probe2: 6,
    probe3: 7,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    sensitivity: 1,
    sendMode: 1,
    version: '01.02.03.04',
    address_r: 1,
    runTime: 0,
    probeCount: 2,
    lastUpdate,
    samples,
    rawSamples: samples,
    historySamples: samples,
    rawHistorySamples: samples,
    historySampleTotal: samples?.length ?? 0,
  };
}

function detectorState(timestamp: number, unit: FlameDetectorUnitState): FlameDetectorState {
  return { units: [unit], onlineCount: 1, fireCount: 0, faultCount: 0, timestamp };
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

test('noise window diagnostics log boundaries, gaps, and compact probe summaries', () => {
  const logs: string[] = [];
  const analysis = new FieldWaveformAnalysis(undefined, (message) => logs.push(message));
  const samples = [
    { probe1: 10, probe2: 20, probe3: 30 },
    { probe1: 14, probe2: 24, probe3: 34 },
  ];

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  analysis.observeDetectors(detectorState(11_100, detectorUnit(11_100, samples)));
  analysis.observeDetectors(detectorState(12_100, detectorUnit(12_100, [
    { probe1: 11, probe2: 21, probe3: 31 },
    { probe1: 15, probe2: 25, probe3: 35 },
  ])));

  const end = status(13_000);
  end.io!.internal!.noiseCaptureWindow = false;
  end.io!.internal!.signalStabilizing = false;
  end.io!.steps!.stepM10_4 = true;
  end.heatSubstage = 'HEAT_INTERFERENCE';
  analysis.observeProcess(end);

  assert.ok(logs.some((line) => line.includes('[噪声窗口] 开始') && line.includes('plcOpenAt=')));
  assert.ok(logs.some((line) => line.includes('[噪声窗口][每秒]') && line.includes('D1')));
  assert.ok(logs.some((line) => line.includes('[噪声窗口] 结束') && line.includes('durationMs=2000')));
  assert.ok(logs.some((line) => line.includes('[噪声窗口][D1]')
    && line.includes('frames=2')
    && line.includes('maxGapMs=1000')
    && line.includes('P1{n=4,min=10,max=15,last=15,fluct=2.5')));
  assert.ok(logs.every((line) => !line.includes('samples=[{')));
});

test('noise window diagnostics expose a PLC window that closes before capture starts', () => {
  const logs: string[] = [];
  const analysis = new FieldWaveformAnalysis(undefined, (message) => logs.push(message));

  analysis.observeProcess(status(1_000));
  const close = status(5_000);
  close.io!.internal!.noiseCaptureWindow = false;
  close.io!.internal!.signalStabilizing = false;
  analysis.observeProcess(close);

  assert.ok(logs.some((line) => line.includes('[噪声窗口][PLC] 开启')));
  assert.ok(logs.some((line) => line.includes('[噪声窗口][PLC] 关闭') && line.includes('CAPTURE_NOT_STARTED')));
  assert.ok(!logs.some((line) => line.includes('[噪声窗口] 开始 batch=')));
});
