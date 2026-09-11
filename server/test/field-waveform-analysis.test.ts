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

function detectorUnit(
  lastUpdate: number,
  samples: FlameDetectorUnitState['samples'],
  rawSamples: FlameDetectorUnitState['rawSamples'] = samples,
): FlameDetectorUnitState {
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
    rawSamples,
    historySamples: samples,
    rawHistorySamples: rawSamples,
    historySampleTotal: samples?.length ?? 0,
  };
}

function detectorState(timestamp: number, unit: FlameDetectorUnitState): FlameDetectorState {
  return { units: [unit], onlineCount: 1, fireCount: 0, faultCount: 0, timestamp };
}

function closeNoiseWindow(analysis: FieldWaveformAnalysis, timestamp: number): void {
  const end = status(timestamp);
  end.io!.internal!.noiseCaptureWindow = false;
  end.io!.internal!.signalStabilizing = false;
  end.io!.steps!.stepM10_4 = true;
  end.heatSubstage = 'HEAT_INTERFERENCE';
  analysis.observeProcess(end);
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

test('a ready detector contributes noise samples while another detector has no signal', () => {
  const analysis = new FieldWaveformAnalysis();
  const samples = [
    { probe1: 10, probe2: 20, probe3: 30 },
    { probe1: 12, probe2: 22, probe3: 32 },
  ];
  const unavailable = {
    ...detectorUnit(11_100, []),
    online: false,
    sourceReady: false,
    syncOk: false,
  };
  const ready = {
    ...detectorUnit(11_100, samples),
    index: 2,
    address: 2,
    address_r: 2,
  };

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  analysis.observeDetectors({ units: [unavailable, ready], onlineCount: 1, fireCount: 0, faultCount: 0, timestamp: 11_100 });

  const readyResult = analysis.snapshot().units.find((unit) => unit.index === 2);
  assert.equal(readyResult?.noiseSampleCount, samples.length);
});

test('formal noise fluctuation uses adaptive-baseline normalized samples while absolute stays RAW', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 4, minNoiseRms: 0 });
  const normalized = [
    { probe1: 0, probe2: -50, probe3: -40 },
    { probe1: 0, probe2: 50, probe3: 40 },
    { probe1: 0, probe2: -50, probe3: -40 },
    { probe1: 0, probe2: 50, probe3: 40 },
  ];
  const rawWithSlowDrift = [
    { probe1: 0, probe2: 0, probe3: 20 },
    { probe1: 0, probe2: 100, probe3: 100 },
    { probe1: 0, probe2: 400, probe3: 420 },
    { probe1: 0, probe2: 500, probe3: 500 },
  ];

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  analysis.observeDetectors(detectorState(11_100, detectorUnit(11_100, normalized, rawWithSlowDrift)));
  closeNoiseWindow(analysis, 12_000);

  const result = analysis.snapshot().units[0];
  assert.equal(result.noiseTest.metrics.probe2.fluctuation, 50);
  assert.equal(result.noiseTest.metrics.probe3.fluctuation, 40);
  assert.equal(result.noiseTest.metrics.probe2.absolute, 500);
  assert.equal(result.noiseTest.metrics.probe3.absolute, 500);
  assert.equal(result.noiseTest.verdict, 'PASS');
});

test('RAW absolute-value protection still fails a normalized-stable waveform', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 4, minNoiseRms: 0 });
  const normalized = [
    { probe1: 0, probe2: -40, probe3: -40 },
    { probe1: 0, probe2: 40, probe3: 40 },
    { probe1: 0, probe2: -40, probe3: -40 },
    { probe1: 0, probe2: 40, probe3: 40 },
  ];
  const rawHighAbsolute = [
    { probe1: 0, probe2: 1_050, probe3: 100 },
    { probe1: 0, probe2: 1_100, probe3: 120 },
    { probe1: 0, probe2: 1_150, probe3: 140 },
    { probe1: 0, probe2: 1_200, probe3: 160 },
  ];

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  analysis.observeDetectors(detectorState(11_100, detectorUnit(11_100, normalized, rawHighAbsolute)));
  closeNoiseWindow(analysis, 12_000);

  const result = analysis.snapshot().units[0];
  assert.equal(result.noiseTest.metrics.probe2.fluctuation, 40);
  assert.equal(result.noiseTest.metrics.probe2.absolute, 1_200);
  assert.equal(result.noiseTest.verdict, 'FAIL');
  assert.equal(result.noiseTest.reason, 'NOISE_ABSOLUTE_EXCEEDS_LIMIT');
});

test('noise window diagnostics log boundaries, gaps, and normalized/raw probe summaries', () => {
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

  closeNoiseWindow(analysis, 13_000);

  assert.ok(logs.some((line) => line.includes('[噪声窗口] 开始') && line.includes('plcOpenAt=')));
  assert.ok(logs.some((line) => line.includes('[噪声窗口][每秒]') && line.includes('D1') && line.includes('Ncum[') && line.includes('Rcum[')));
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
