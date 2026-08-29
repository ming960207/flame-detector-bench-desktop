import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
  FieldWaveformAnalysis,
} from '../dist/closure/field-waveform-analysis.js';
import { decodePLCProcessStatus } from '../dist/process-status.js';

function processStatus(stageCode, stepCode, timestamp, options = {}) {
  return decodePLCProcessStatus({
    stageCode,
    stepCode,
    autoRunning: options.autoRunning ?? true,
    complete: options.complete ?? false,
    alarm: options.alarm ?? false,
    returningHome: options.returningHome ?? false,
    timestamp,
    io: options.io,
  });
}

function sample(value) {
  return { probe1: value, probe2: value, probe3: value };
}

function detectorState(timestamp, overrides = {}) {
  const unit = {
    index: 1,
    address: 1,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    lastUpdate: timestamp,
    samples: [],
    rawSamples: [],
    ...overrides,
  };
  return { units: [unit], onlineCount: unit.online ? 1 : 0, fireCount: 0, faultCount: 0, timestamp };
}

function noiseOnlyQuality() {
  return {
    acceptanceGrade: 'B',
    a: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0, minSensitivity: 0 },
    b: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0, minSensitivity: 0 },
    ratios: {
      a: { snr21: { min: 0, max: 0 }, snr23: { min: 0, max: 0 }, snr31: { min: 0, max: 0 } },
      b: { snr21: { min: 0, max: 0 }, snr23: { min: 0, max: 0 }, snr31: { min: 0, max: 0 } },
    },
  };
}

function completeInterferenceStages(analysis, timestamp = 20) {
  analysis.observeProcess(processStatus(2, 2, timestamp, { io: { steps: { stepM10_4: true } } }));
  analysis.observeDetectors(detectorState(timestamp + 1, { rawSamples: [sample(100)] }));
  analysis.observeProcess(processStatus(3, 3, timestamp + 2, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(timestamp + 3, { rawSamples: [sample(100)] }));
  analysis.observeProcess(processStatus(4, 3, timestamp + 4, { io: { steps: { stepM11_2: true } } }));
  analysis.observeDetectors(detectorState(timestamp + 5, { rawSamples: [sample(100)] }));
  analysis.observeProcess(processStatus(0, 0, timestamp + 6, { autoRunning: false, complete: true }));
}

test('PLC stage code mapping covers every capture window and keeps alarm processStage', () => {
  const cases = [
    [1, 1, {}, 'INIT'],
    [2, 2, {}, 'HEAT'],
    [2, 3, {}, 'HEAT'],
    [3, 3, {}, 'FLASH'],
    [4, 3, {}, 'EMC'],
    [1, 1, { returningHome: true }, 'RETURN_HOME'],
    [0, 0, { complete: true }, 'COMPLETE'],
  ];

  for (const [stageCode, stepCode, options, expected] of cases) {
    const decoded = processStatus(stageCode, stepCode, 1, options);
    assert.equal(decoded.processStage, expected);
    assert.equal(decoded.valid, true);
  }

  const alarm = processStatus(4, 3, 2, { alarm: true });
  assert.equal(alarm.stage, 'FAULT');
  assert.equal(alarm.processStage, 'EMC');
});

test('heat process exposes independent PLC substages and protects return-home decoding', () => {
  const stabilization = processStatus(2, 3, 10, {
    io: { internal: { signalStabilizing: true, noiseCaptureWindow: false }, steps: { stepM10_4: false } },
  });
  assert.equal(stabilization.processStage, 'HEAT');
  assert.equal(stabilization.heatSubstage, 'SIGNAL_STABILIZATION');
  assert.equal(stabilization.heatSubstageLabel, '信号稳定阶段');

  const noise = processStatus(2, 3, 20, {
    io: { internal: { signalStabilizing: true, noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  });
  assert.equal(noise.heatSubstage, 'NOISE_CAPTURE');
  assert.equal(noise.heatSubstageLabel, '噪声采集阶段');

  const interference = processStatus(2, 2, 30, {
    io: { internal: { signalStabilizing: false, noiseCaptureWindow: false }, steps: { stepM10_4: true } },
  });
  assert.equal(interference.heatSubstage, 'HEAT_INTERFERENCE');
  assert.equal(interference.heatSubstageLabel, '热源干扰采集阶段');

  const returnHome = processStatus(2, 2, 40, { returningHome: true });
  assert.equal(returnHome.processStage, 'RETURN_HOME');
  assert.equal(returnHome.heatSubstage, 'IDLE');
});

test('heat substage timing keeps stabilization, noise, and interference windows separate', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minInterferenceSamples: 1, minNoiseRms: 0 });
  analysis.observeProcess(processStatus(1, 1, 1));

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { signalStabilizing: true, noiseCaptureWindow: false }, steps: { stepM10_4: false } },
  }));
  assert.equal(analysis.snapshot().heatSubstage, 'SIGNAL_STABILIZATION');

  analysis.observeProcess(processStatus(2, 3, 20, {
    io: { internal: { signalStabilizing: true, noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  assert.equal(analysis.snapshot().heatSubstage, 'SIGNAL_STABILIZATION');

  analysis.observeProcess(processStatus(2, 3, 5_020, {
    io: { internal: { signalStabilizing: true, noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  assert.equal(analysis.snapshot().heatSubstage, 'NOISE_CAPTURE');

  analysis.observeProcess(processStatus(2, 2, 5_050, {
    io: { internal: { signalStabilizing: false, noiseCaptureWindow: false }, steps: { stepM10_4: true } },
  }));
  assert.equal(analysis.snapshot().heatSubstage, 'HEAT_INTERFERENCE');

  analysis.observeProcess(processStatus(3, 3, 5_060, { io: { steps: { stepM11_0: true } } }));
  analysis.observeProcess(processStatus(0, 0, 5_070, { autoRunning: false, complete: true }));
  assert.deepEqual(analysis.snapshot().heatStageTimings, {
    stabilizationStartedAt: 10,
    stabilizationEndedAt: 5_020,
    noiseStartedAt: 5_020,
    noiseEndedAt: 5_050,
    interferenceStartedAt: 5_050,
    interferenceEndedAt: 5_060,
  });
});

test('upper computer waits an extra 5 seconds after the PLC noise window opens', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minInterferenceSamples: 1, minNoiseRms: 0 });
  const noiseWindow = (timestamp) => processStatus(2, 3, timestamp, {
    io: { internal: { signalStabilizing: true, noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  });

  analysis.observeProcess(noiseWindow(1_000));
  assert.equal(analysis.snapshot().heatSubstage, 'SIGNAL_STABILIZATION');
  assert.equal(analysis.snapshot().noiseCaptureActive, false);
  assert.equal(analysis.snapshot().noiseStartedAt, null);

  analysis.observeDetectors(detectorState(2_000, { rawSamples: [sample(10)] }));
  analysis.observeProcess(noiseWindow(5_999));
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 0);

  analysis.observeProcess(noiseWindow(6_000));
  assert.equal(analysis.snapshot().heatSubstage, 'NOISE_CAPTURE');
  assert.equal(analysis.snapshot().noiseCaptureActive, true);
  assert.equal(analysis.snapshot().noiseStartedAt, 6_000);
  analysis.observeDetectors(detectorState(6_001, { rawSamples: [sample(10)] }));
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 1);
  assert.deepEqual(analysis.snapshot().heatStageTimings, {
    stabilizationStartedAt: 1_000,
    stabilizationEndedAt: 6_000,
    noiseStartedAt: 6_000,
    noiseEndedAt: null,
    interferenceStartedAt: null,
    interferenceEndedAt: null,
  });
});

test('runtime detection thresholds can be updated without discarding captured samples', () => {
  assert.deepEqual({
    minNoiseSamples: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minNoiseSamples,
    minInterferenceSamples: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minInterferenceSamples,
    minNoiseRms: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minNoiseRms,
    maxNoiseRms: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxNoiseRms,
    maxNoiseAbsolute: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxNoiseAbsolute,
    maxInterferenceRatio: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxInterferenceRatio,
    minConsistencyTrend: DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minConsistencyTrend,
  }, {
    minNoiseSamples: 400,
    minInterferenceSamples: 80,
    minNoiseRms: 50,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    minConsistencyTrend: 0.75,
  });
  assert.deepEqual(DEFAULT_WAVEFORM_ANALYSIS_CONFIG.noiseProbes, ['probe2', 'probe3']);
  assert.deepEqual(DEFAULT_WAVEFORM_ANALYSIS_CONFIG.consistencyProbes, ['probe2', 'probe3']);
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, maxNoiseRms: 200 });
  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, { rawSamples: [sample(120)] }));

  analysis.updateConfig({ minNoiseSamples: 2, maxNoiseRms: 80 });

  const snapshot = analysis.snapshot();
  assert.equal(snapshot.thresholds.maxNoiseRms, 80);
  assert.equal(snapshot.thresholds.minNoiseSamples, 2);
  assert.equal(snapshot.units[0].noiseSampleCount, 1, 'saving thresholds must not discard the active batch');
  assert.equal(snapshot.units[0].reason, 'WAITING_FOR_NOISE_SAMPLES');
});

test('default field sampling rejects a sub-second interference fragment', () => {
  const analysis = new FieldWaveformAnalysis();
  analysis.observeProcess(processStatus(1, 1, 10, {
    io: { internal: { noiseCaptureWindow: true } },
  }));
  analysis.observeProcess(processStatus(1, 1, 5_010, {
    io: { internal: { noiseCaptureWindow: true } },
  }));
  analysis.observeDetectors(detectorState(5_011, { samples: Array.from({ length: 400 }, (_, index) => sample(index % 120)) }));
  analysis.observeProcess(processStatus(2, 2, 5_020, { io: { steps: { stepM10_4: true } } }));
  analysis.observeDetectors(detectorState(5_021, { samples: Array.from({ length: 79 }, (_, index) => sample(index)) }));
  analysis.observeProcess(processStatus(3, 3, 5_030, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(5_031, { samples: Array.from({ length: 80 }, (_, index) => sample(index)) }));
  analysis.observeProcess(processStatus(4, 3, 5_040, { io: { steps: { stepM11_2: true } } }));
  analysis.observeDetectors(detectorState(5_041, { samples: Array.from({ length: 80 }, (_, index) => sample(index)) }));
  analysis.observeProcess(processStatus(0, 0, 5_050, { autoRunning: false, complete: true }));

  const unit = analysis.snapshot().units[0];
  assert.equal(unit.verdict, 'FAIL');
  assert.equal(unit.reason, 'HEAT_SAMPLES_MISSING');
});

test('a PLC run without the explicit M25.2 window completes as missing noise instead of sampling clamp movement', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minInterferenceSamples: 1 });

  analysis.observeProcess(processStatus(1, 1, 10));
  assert.ok(analysis.snapshot().batchId, 'automatic PLC run must create a result batch');

  analysis.observeProcess(processStatus(2, 3, 20, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_3: true, stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(21, { rawSamples: [sample(100)] }));
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 0, 'clamp movement must not be treated as stable baseline noise');

  analysis.observeProcess(processStatus(0, 0, 30, { autoRunning: false, complete: true }));
  const completed = analysis.snapshot();
  assert.equal(completed.phase, 'COMPLETE');
  assert.equal(completed.verdict, 'FAIL');
  assert.equal(completed.units[0].verdict, 'FAIL');
  assert.equal(completed.units[0].reason, 'NOISE_SAMPLES_MISSING');
});

test('waveform capture is limited to PLC process phases and ignores stale samples while offline', () => {
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 1,
    minInterferenceSamples: 1,
    minNoiseRms: 0,
    maxInterferenceRatio: 1_000_000,
  });

  analysis.observeDetectors(detectorState(1, { rawSamples: [sample(99)] }));
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 0, 'idle data must not start a capture batch');

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  const batchId = analysis.snapshot().batchId;
  analysis.observeDetectors(detectorState(5_011, { rawSamples: [sample(10)] }));
  assert.equal(analysis.snapshot().phase, 'NOISE');
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 1);

  analysis.observeProcess(processStatus(2, 3, 5_020, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_021, {
    online: false,
    sourceReady: false,
    syncOk: false,
    rawSamples: [sample(10)],
    samples: [sample(10)],
  }));
  assert.equal(analysis.snapshot().batchId, batchId, 'reconnect must not reset the active PLC batch');
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 1, 'offline cached samples are not realtime samples');

  analysis.observeProcess(processStatus(2, 2, 5_030, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: true } },
  }));
  assert.equal(analysis.snapshot().phase, 'INTERFERENCE');
  assert.equal(analysis.snapshot().units[0].interferenceSampleCount, 0);
  analysis.observeDetectors(detectorState(5_031, {
    online: false,
    sourceReady: false,
    syncOk: false,
    rawSamples: [sample(20)],
    samples: [sample(20)],
  }));
  assert.equal(analysis.snapshot().units[0].interferenceSampleCount, 0);
  analysis.observeDetectors(detectorState(5_032, { rawSamples: [sample(20)] }));
  assert.equal(analysis.snapshot().units[0].interferenceSampleCount, 1);

  analysis.observeProcess(processStatus(3, 3, 5_033, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(5_034, { rawSamples: [sample(20)] }));
  analysis.observeProcess(processStatus(4, 3, 5_035, { io: { steps: { stepM11_2: true } } }));
  analysis.observeDetectors(detectorState(5_036, { rawSamples: [sample(20)] }));

  analysis.observeProcess(processStatus(0, 0, 5_040, { autoRunning: false, complete: true }));
  const completed = analysis.snapshot();
  assert.equal(completed.phase, 'COMPLETE');
  assert.equal(completed.processStage, 'COMPLETE');
  assert.equal(completed.units[0].verdict, 'PASS');
  analysis.observeDetectors(detectorState(41, { rawSamples: [sample(30)] }));
  assert.equal(analysis.snapshot().units[0].interferenceSampleCount, 3, 'post-process data must not extend the capture window');
});

test('interference verdict uses new samples, P2/P3 ratio, and same-trend threshold', () => {
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 2,
    minInterferenceSamples: 2,
    minNoiseRms: 0,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    minConsistencyTrend: 0.7,
    interferenceRatio: { numerator: 'probe2', denominator: 'probe3' },
  });

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, { rawSamples: [sample(100), sample(110)] }));
  analysis.observeProcess(processStatus(2, 2, 5_020, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: true } },
  }));
  analysis.observeDetectors(detectorState(5_021, { rawSamples: [
    { probe1: 10, probe2: 10, probe3: 10 },
    { probe1: 20, probe2: 20, probe3: 20 },
  ] }));
  analysis.observeProcess(processStatus(3, 3, 5_022, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(5_023, { rawSamples: [
    { probe1: 10, probe2: 10, probe3: 10 },
    { probe1: 20, probe2: 20, probe3: 20 },
  ] }));
  analysis.observeProcess(processStatus(4, 3, 5_024, { io: { steps: { stepM11_2: true } } }));
  analysis.observeDetectors(detectorState(5_025, { rawSamples: [
    { probe1: 10, probe2: 10, probe3: 10 },
    { probe1: 20, probe2: 20, probe3: 20 },
  ] }));
  analysis.observeProcess(processStatus(0, 0, 5_030, { autoRunning: false, complete: true }));

  const unit = analysis.snapshot().units[0];
  assert.equal(unit.noisePeakToPeak, 5);
  assert.equal(unit.noiseAbsolute, 110);
  assert.equal(unit.interferenceRatio, 1);
  assert.equal(unit.consistencyTrend, 1);
  assert.equal(unit.verdict, 'PASS');
});

test('quality metrics use baseline-normalized samples instead of signed raw carrier values', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 2, minInterferenceSamples: 1 });
  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, {
    rawSamples: [sample(-32767), sample(-32751)],
    samples: [sample(-8), sample(8)],
  }));

  const unit = analysis.snapshot().units[0];
  assert.equal(unit.noiseAbsolute, 8);
  assert.equal(unit.noiseRms, 8);
  assert.equal(unit.noiseSampleCount, 2);
});

test('noise verdict applies the fluctuation limit to every selected probe, not the combined RMS', () => {
  const quality = noiseOnlyQuality();
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 2,
    minInterferenceSamples: 1,
    minNoiseRms: 0,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    noiseProbes: ['probe1', 'probe2', 'probe3'],
    quality,
  });

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, {
    rawSamples: [
      { probe1: 0, probe2: 0, probe3: 0 },
      { probe1: 0, probe2: 500, probe3: 0 },
    ],
  }));
  analysis.observeProcess(processStatus(2, 2, 5_020, { io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: true } } }));
  analysis.observeDetectors(detectorState(5_021, { rawSamples: [sample(1)] }));
  analysis.observeProcess(processStatus(3, 3, 5_030, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(5_031, { rawSamples: [sample(1)] }));
  analysis.observeProcess(processStatus(4, 3, 5_040, { io: { steps: { stepM11_2: true } } }));
  analysis.observeDetectors(detectorState(5_041, { rawSamples: [sample(1)] }));
  analysis.observeProcess(processStatus(0, 0, 5_050, { autoRunning: false, complete: true }));

  const unit = analysis.snapshot().units[0];
  assert.ok(unit.noiseRms < 200, 'the combined RMS is below the configured limit in this regression case');
  assert.equal(unit.noiseTest.metrics.probe2.fluctuation, 250);
  assert.equal(unit.noiseTest.verdict, 'FAIL');
  assert.equal(unit.noiseTest.reason, 'NOISE_RMS_EXCEEDS_LIMIT');
  assert.equal(unit.verdict, 'FAIL');
  assert.equal(unit.reason, 'NOISE_RMS_EXCEEDS_LIMIT');
});

test('noise verdict uses each selected probe absolute value for the upper limit', () => {
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 2,
    minInterferenceSamples: 1,
    minNoiseRms: 0,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    noiseProbes: ['probe1', 'probe2', 'probe3'],
    quality: noiseOnlyQuality(),
  });

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, {
    samples: [sample(0), sample(0)],
    rawSamples: [
      { probe1: 10, probe2: 1500, probe3: 10 },
      { probe1: 10, probe2: 1500, probe3: 10 },
    ],
  }));
  completeInterferenceStages(analysis, 5_020);

  const unit = analysis.snapshot().units[0];
  assert.equal(unit.noiseAbsolute, 0, 'normalized noise telemetry remains separate from raw absolute noise');
  assert.equal(unit.noiseTest.metrics.probe2.absolute, 1500);
  assert.equal(unit.noiseTest.verdict, 'FAIL');
  assert.equal(unit.noiseTest.reason, 'NOISE_ABSOLUTE_EXCEEDS_LIMIT');
  assert.equal(unit.verdict, 'FAIL');
  assert.equal(unit.reason, 'NOISE_ABSOLUTE_EXCEEDS_LIMIT');
});

test('noise verdict rejects selected probes whose fluctuation stays below the lower limit', () => {
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 2,
    minInterferenceSamples: 1,
    minNoiseRms: 50,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    noiseProbes: ['probe1', 'probe2', 'probe3'],
    quality: noiseOnlyQuality(),
  });

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, {
    samples: [sample(10), sample(20)],
    rawSamples: [sample(10), sample(20)],
  }));
  completeInterferenceStages(analysis, 5_020);

  const unit = analysis.snapshot().units[0];
  assert.equal(unit.noiseTest.metrics.probe1.fluctuation, 5);
  assert.equal(unit.noiseTest.verdict, 'FAIL');
  assert.equal(unit.noiseTest.reason, 'NOISE_RMS_BELOW_LIMIT');
  assert.equal(unit.verdict, 'FAIL');
  assert.equal(unit.reason, 'NOISE_RMS_BELOW_LIMIT');
});

test('captures noise only in the PLC noise window and ratios only during heat-source movement', () => {
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 1,
    minInterferenceSamples: 1,
    minNoiseRms: 0,
  });

  analysis.observeProcess(processStatus(1, 1, 10));
  analysis.observeDetectors(detectorState(11, { rawSamples: [sample(999)] }));
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 0, 'positioning data is not baseline noise');

  analysis.observeProcess(processStatus(2, 3, 20, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(21, { rawSamples: [sample(888)] }));
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 0, 'stabilization data is not baseline noise');

  analysis.observeProcess(processStatus(2, 3, 30, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_030, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_031, { rawSamples: [sample(100)] }));
  assert.equal(analysis.snapshot().phase, 'NOISE');
  assert.equal(analysis.snapshot().units[0].noiseSampleCount, 1);

  analysis.observeProcess(processStatus(2, 2, 5_040, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: true } },
  }));
  analysis.observeDetectors(detectorState(5_041, { rawSamples: [sample(200)], snr21: 1.1, snr23: 1.2, snr31: 1.3 }));
  assert.equal(analysis.snapshot().phase, 'INTERFERENCE');
  assert.equal(analysis.snapshot().units[0].interferenceSampleCount, 1);
  assert.deepEqual(
    [analysis.snapshot().units[0].snr21, analysis.snapshot().units[0].snr23, analysis.snapshot().units[0].snr31],
    [1.1, 1.2, 1.3],
  );

  analysis.observeProcess(processStatus(3, 3, 5_050, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(5_051, { rawSamples: [sample(300)] }));
  assert.equal(analysis.snapshot().units[0].interferenceSampleCount, 2);
  assert.equal(analysis.snapshot().units[0].stages.heat.sampleCount, 1);
  assert.equal(analysis.snapshot().units[0].stages.flash.sampleCount, 1);
});

test('freezes noise metrics and completes each interference stage as the PLC advances', () => {
  const analysis = new FieldWaveformAnalysis({
    minNoiseSamples: 2,
    minInterferenceSamples: 2,
    minNoiseRms: 0,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 2,
    minConsistencyTrend: 0,
    quality: {
      acceptanceGrade: 'B',
      a: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 2, minConsistencyTrend: 0, minSensitivity: 0 },
      b: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 2, minConsistencyTrend: 0, minSensitivity: 0 },
      ratios: {
        a: { snr21: { min: 0, max: 0 }, snr23: { min: 0, max: 1.5 }, snr31: { min: 0, max: 0 } },
        b: { snr21: { min: 0, max: 0 }, snr23: { min: 0, max: 1.5 }, snr31: { min: 0, max: 0 } },
      },
    },
  });
  const stageSamples = [
    { probe1: 10, probe2: 10, probe3: 10 },
    { probe1: 20, probe2: 20, probe3: 20 },
  ];

  analysis.observeProcess(processStatus(2, 3, 10, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_010, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_011, {
    samples: [
      { probe1: 1, probe2: 2, probe3: 3 },
      { probe1: 2, probe2: 3, probe3: 4 },
    ],
    rawSamples: [
      { probe1: 100, probe2: 110, probe3: 120 },
      { probe1: 105, probe2: 115, probe3: 125 },
    ],
  }));
  assert.equal(analysis.snapshot().units[0].noiseTest.verdict, 'PENDING');

  analysis.observeProcess(processStatus(2, 2, 5_020, {
    io: { internal: { noiseCaptureWindow: false }, steps: { stepM10_4: true } },
  }));
  const noiseSnapshot = analysis.snapshot().units[0].noiseTest;
  assert.equal(noiseSnapshot.verdict, 'PASS', 'noise must be judged as soon as its capture window closes');
  assert.equal(noiseSnapshot.metrics.probe2.fluctuation, 2.5);
  assert.equal(noiseSnapshot.metrics.probe2.absolute, 115);

  analysis.observeDetectors(detectorState(5_021, { samples: stageSamples, rawSamples: stageSamples, snr21: 1, snr23: 1, snr31: 1 }));
  assert.equal(analysis.snapshot().units[0].noiseTest.metrics.probe2.absolute, 115, 'later stages must not overwrite noise metrics');
  assert.equal(analysis.snapshot().units[0].stages.heat.verdict, 'PENDING');

  analysis.observeProcess(processStatus(3, 3, 5_030, { io: { steps: { stepM11_0: true } } }));
  assert.equal(analysis.snapshot().units[0].stages.heat.verdict, 'PASS', 'heat must complete before flash starts');
  analysis.observeDetectors(detectorState(5_031, { samples: stageSamples, rawSamples: stageSamples, snr21: 1, snr23: 2, snr31: 1 }));
  assert.equal(analysis.snapshot().units[0].stages.flash.verdict, 'PENDING');

  analysis.observeProcess(processStatus(4, 3, 5_040, { io: { steps: { stepM11_2: true } } }));
  assert.equal(analysis.snapshot().units[0].stages.flash.verdict, 'FAIL', 'flash must expose its failure before EMC starts');
  analysis.observeDetectors(detectorState(5_041, { samples: stageSamples, rawSamples: stageSamples, snr21: 1, snr23: 1, snr31: 1 }));
  analysis.observeProcess(processStatus(0, 0, 5_050, { autoRunning: false, complete: true }));
  assert.equal(analysis.snapshot().units[0].stages.emc.verdict, 'PASS', 'EMC must complete at PLC completion');
});

test('return-home polling preserves one batch until the PLC reports actual completion', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minInterferenceSamples: 1, minNoiseRms: 0 });

  analysis.observeProcess(processStatus(1, 1, 10));
  const batchId = analysis.snapshot().batchId;
  analysis.observeProcess(processStatus(2, 3, 20, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeProcess(processStatus(2, 3, 5_020, {
    io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } },
  }));
  analysis.observeDetectors(detectorState(5_021, { rawSamples: [sample(100)] }));
  analysis.observeProcess(processStatus(2, 2, 5_030, { io: { steps: { stepM10_4: true } } }));
  analysis.observeDetectors(detectorState(5_031, { rawSamples: [sample(110)] }));

  analysis.observeProcess(processStatus(1, 1, 5_040, { returningHome: true }));
  assert.equal(analysis.snapshot().batchId, batchId);
  assert.notEqual(analysis.snapshot().phase, 'COMPLETE', 'return-home is not the final PLC completion signal');
  analysis.observeProcess(processStatus(1, 1, 5_041, { returningHome: true }));
  assert.equal(analysis.snapshot().batchId, batchId, 'repeated return-home polls must not create empty batches');

  analysis.observeProcess(processStatus(0, 0, 5_050, { autoRunning: false, complete: true }));
  assert.equal(analysis.snapshot().phase, 'COMPLETE');
  assert.equal(analysis.snapshot().batchId, batchId);
  analysis.observeProcess(processStatus(0, 0, 5_051, { autoRunning: false, complete: true }));
  assert.equal(analysis.snapshot().batchId, batchId, 'repeated COMPLETE polls must keep the completed batch');

  analysis.observeProcess(processStatus(1, 1, 5_060));
  assert.notEqual(analysis.snapshot().batchId, batchId, 'the next automatic-run edge starts exactly one new batch');
});

test('power-off after complete stage capture does not overwrite the captured waveform verdict', () => {
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minInterferenceSamples: 1, minNoiseRms: 0 });
  analysis.observeProcess(processStatus(1, 1, 10, {
    io: { internal: { noiseCaptureWindow: true } },
  }));
  analysis.observeProcess(processStatus(1, 1, 5_010, {
    io: { internal: { noiseCaptureWindow: true } },
  }));
  analysis.observeDetectors(detectorState(5_011, { samples: [sample(1)] }));
  analysis.observeProcess(processStatus(2, 2, 5_020, { io: { steps: { stepM10_4: true } } }));
  analysis.observeDetectors(detectorState(5_021, { samples: [sample(2)] }));
  analysis.observeProcess(processStatus(3, 3, 5_030, { io: { steps: { stepM11_0: true } } }));
  analysis.observeDetectors(detectorState(5_031, { samples: [sample(3)] }));
  analysis.observeProcess(processStatus(4, 3, 5_040, { io: { steps: { stepM11_2: true } } }));
  analysis.observeDetectors(detectorState(5_041, { samples: [sample(4)] }));
  analysis.observeProcess(processStatus(1, 1, 5_050, { returningHome: true }));
  analysis.observeDetectors(detectorState(5_051, {
    online: false, sourceReady: false, syncOk: false, samples: [], rawSamples: [],
  }));
  analysis.observeProcess(processStatus(0, 0, 5_060, { autoRunning: false, complete: true }));

  const unit = analysis.snapshot().units[0];
  assert.equal(unit.verdict, 'PASS');
  assert.equal(unit.reason, 'WAVEFORM_WITHIN_LIMIT');
});
