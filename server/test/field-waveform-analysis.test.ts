import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DETECTION_QUALITY_CONFIG, FieldWaveformAnalysis } from '../src/closure/field-waveform-analysis.js';
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

test('default formal noise quality thresholds are A 200 and B 220', () => {
  assert.equal(DEFAULT_DETECTION_QUALITY_CONFIG.a.maxNoiseRms, 200);
  assert.equal(DEFAULT_DETECTION_QUALITY_CONFIG.b.maxNoiseRms, 220);
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

test('formal noise uses the maximum complete 10-second rolling RAW fluctuation', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minNoiseRms: 0 });
  const values = [
    [11_100, 0], [12_100, 200], [13_100, 0], [14_100, 200], [15_100, 0],
    [16_100, 200], [17_100, 0], [18_100, 200], [19_100, 0], [20_100, 200],
    [21_100, 0], [22_100, 300], [23_100, 310], [24_100, 320], [25_100, 330],
    [26_100, 340], [27_100, 350], [28_100, 360], [29_100, 370], [30_100, 380],
    [31_100, 390], [32_100, 400],
  ] as const;

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  for (const [timestamp, rawValue] of values) {
    analysis.observeDetectors(detectorState(timestamp, detectorUnit(
      timestamp,
      [{ probe1: 0, probe2: 0, probe3: 0 }],
      [{ probe1: 0, probe2: rawValue, probe3: rawValue }],
    )));
  }
  closeNoiseWindow(analysis, 34_000);

  const noise = analysis.snapshot().units[0]!.noiseTest;
  assert.equal(noise.metrics.probe2.fluctuation, 195);
  assert.equal(noise.metrics.probe3.fluctuation, 195);
  assert.equal(noise.metrics.probe2.absolute, 400);
  assert.equal(noise.currentRolling10s?.probe2, 50);
  assert.equal(noise.maxRolling10s?.probe2, 195);
  assert.equal(noise.fullStageRawFluctuation?.probe2, 200);
  assert.equal(noise.rawAbsoluteMax?.probe2, 400);
});

test('rolling RAW samples expire by timestamp rather than point count', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minNoiseRms: 0 });
  const values = [
    [11_100, 0],
    [11_200, 200],
    [30_900, 10],
    [31_300, 20],
  ] as const;

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  for (const [timestamp, rawValue] of values) {
    analysis.observeDetectors(detectorState(timestamp, detectorUnit(
      timestamp,
      [{ probe1: 0, probe2: 0, probe3: 0 }],
      [{ probe1: 0, probe2: rawValue, probe3: rawValue }],
    )));
  }
  closeNoiseWindow(analysis, 32_000);

  const noise = analysis.snapshot().units[0]!.noiseTest;
  assert.equal(noise.currentRolling10s?.probe2, 5);
  assert.equal(noise.maxRolling10s?.probe2, 5);
  assert.equal(noise.fullStageRawFluctuation?.probe2, 100);
  assert.equal(noise.rawAbsoluteMax?.probe2, 200);
});

test('formal noise fluctuation uses rolling RAW samples while absolute stays RAW', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 4, minNoiseRms: 0 });
  const normalized = [
    { probe1: 0, probe2: -50, probe3: -40 },
    { probe1: 0, probe2: 50, probe3: 40 },
    { probe1: 0, probe2: -50, probe3: -40 },
    { probe1: 0, probe2: 50, probe3: 40 },
  ];
  const rawWithSlowDrift = [
    { probe1: 0, probe2: 100, probe3: 100 },
    { probe1: 0, probe2: 120, probe3: 120 },
    { probe1: 0, probe2: 100, probe3: 100 },
    { probe1: 0, probe2: 120, probe3: 120 },
  ];
  const rawWithSecondBaseline = rawWithSlowDrift.map((sample) => ({
    ...sample,
    probe2: sample.probe2 + 280,
    probe3: sample.probe3 + 280,
  }));

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  analysis.observeDetectors(detectorState(11_100, detectorUnit(11_100, normalized, rawWithSlowDrift)));
  analysis.observeDetectors(detectorState(21_100, detectorUnit(21_100, normalized, rawWithSecondBaseline)));
  closeNoiseWindow(analysis, 22_000);

  const result = analysis.snapshot().units[0];
  assert.equal(result.noiseTest.metrics.probe2.fluctuation, 150);
  assert.equal(result.noiseTest.metrics.probe3.fluctuation, 150);
  assert.equal(result.noiseTest.metrics.probe2.absolute, 400);
  assert.equal(result.noiseTest.metrics.probe3.absolute, 400);
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
    { probe1: 0, probe2: 1_130, probe3: 180 },
    { probe1: 0, probe2: 1_050, probe3: 100 },
    { probe1: 0, probe2: 1_130, probe3: 180 },
  ];

  analysis.observeProcess(status(1_000));
  analysis.observeProcess(status(11_000));
  analysis.observeDetectors(detectorState(11_100, detectorUnit(11_100, normalized, rawHighAbsolute)));
  analysis.observeDetectors(detectorState(21_100, detectorUnit(21_100, normalized, rawHighAbsolute)));
  closeNoiseWindow(analysis, 22_000);

  const result = analysis.snapshot().units[0];
  assert.equal(result.noiseTest.metrics.probe2.fluctuation, 40);
  assert.equal(result.noiseTest.metrics.probe2.absolute, 1_130);
  assert.equal(result.noiseTest.verdict, 'FAIL');
  assert.equal(result.noiseTest.reason, 'NOISE_ABSOLUTE_EXCEEDS_LIMIT');
});

test('noise window diagnostics log boundaries, gaps, and rolling/raw probe summaries', () => {
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
  assert.ok(logs.some((line) => line.includes('Rrolling[') && line.includes('currentRolling10s[') && line.includes('maxRolling10s[')));
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
