import assert from 'node:assert/strict';
import test from 'node:test';
import { TestProgramTracker } from '../dist/test-program/test-program-tracker.js';

function processStatus(timestamp, stage, heatSubstage = 'IDLE', options = {}) {
  const stageMap = {
    INIT: [1, 1],
    HEAT: [2, 3],
    FLASH: [3, 3],
    EMC: [4, 3],
    RETURN_HOME: [1, 1],
    COMPLETE: [0, 0],
    IDLE: [0, 0],
  };
  const [stageCode, stepCode] = stageMap[stage] ?? [99, 99];
  return {
    stageCode,
    stepCode,
    autoRunning: options.autoRunning ?? !['IDLE', 'COMPLETE'].includes(stage),
    complete: options.complete ?? stage === 'COMPLETE',
    alarm: options.alarm ?? false,
    returningHome: options.returningHome ?? stage === 'RETURN_HOME',
    stage,
    label: stage === 'HEAT' ? '移动热源' : stage,
    processStage: stage,
    processLabel: stage === 'HEAT' ? '移动热源' : stage,
    heatSubstage,
    heatSubstageLabel: heatSubstage,
    valid: true,
    timestamp,
    io: {
      inputs: {},
      outputs: options.outputs ?? {},
      internal: {},
      steps: {},
      syncedAt: timestamp,
    },
  };
}

function detectorState(timestamp, samples) {
  const unit = {
    index: 1,
    address: 1,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 10,
    probe2: 20,
    probe3: 30,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    sensitivity: 1,
    sendMode: 1,
    version: 'test',
    address_r: 1,
    runTime: 0,
    probeCount: 3,
    lastUpdate: timestamp,
    historySampleTotal: samples.length,
    historySamples: samples,
    rawHistorySamples: samples,
  };
  return { units: [unit], onlineCount: 1, fireCount: 0, faultCount: 0, timestamp };
}

function sample(value) {
  return { probe1: value, probe2: value + 1, probe3: value + 2 };
}

test('test observer splits heat substages and records relay/waveform evidence', () => {
  const finalized = [];
  const tracker = new TestProgramTracker({
    formalBackendUrl: 'http://127.0.0.1:3003',
    runIdFactory: () => 'run-test-001',
    onRunFinalized: (run) => finalized.push(run),
  });

  tracker.observeProcess(processStatus(1_000, 'INIT', 'IDLE', { outputs: { heatSource: false } }));
  tracker.observeProcess(processStatus(2_000, 'HEAT', 'SIGNAL_STABILIZATION', { outputs: { heatSource: true } }));
  tracker.observeFlameState(detectorState(2_100, [sample(10), sample(11)]));
  tracker.observeProcess(processStatus(3_000, 'HEAT', 'NOISE_CAPTURE', { outputs: { heatSource: true } }));
  tracker.observeFlameState(detectorState(3_100, [sample(10), sample(11), sample(12)]));
  const updatedNoiseState = detectorState(3_200, [sample(10), sample(11), sample(12)]);
  updatedNoiseState.units[0].probe2 = 26;
  updatedNoiseState.units[0].probe2Absolute = 126;
  updatedNoiseState.units[0].probe2Fluctuation = 2.5;
  updatedNoiseState.units[0].snr23 = 1.5;
  tracker.observeFlameState(updatedNoiseState);
  tracker.observeProcess(processStatus(4_000, 'HEAT', 'HEAT_INTERFERENCE', { outputs: { heatSource: true } }));
  tracker.observeFlameState(detectorState(4_100, [sample(10), sample(11), sample(12), sample(20)]));
  tracker.observeProcess(processStatus(5_000, 'FLASH', 'IDLE', { outputs: { heatSource: false, flashLamp1: true } }));
  tracker.observeProcess(processStatus(6_000, 'COMPLETE', 'IDLE', {
    complete: true,
    autoRunning: false,
    outputs: { heatSource: false, flashLamp1: false },
  }));
  tracker.observeSummary({
    process: processStatus(6_000, 'COMPLETE', 'IDLE', { complete: true, autoRunning: false }),
    finalVerdict: { verdict: 'FAIL', grade: 'FAIL' },
    detectorVerdict: {
      verdict: 'FAIL',
      grade: 'FAIL',
      timestamp: 6_000,
      units: [{ index: 1, address: 1, verdict: 'FAIL', grade: 'FAIL', reason: 'NOISE_RMS_EXCEEDS_LIMIT', sampledAt: 6_000, metrics: { noiseRms: 250 } }],
    },
    waveformAnalysis: {
      phase: 'COMPLETE',
      verdict: 'FAIL',
      units: [{ index: 1, noiseSampleCount: 1, noiseTest: { reason: 'NOISE_RMS_EXCEEDS_LIMIT' } }],
    },
  });
  tracker.completePending(6_000);

  assert.equal(finalized.length, 1);
  const run = finalized[0];
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.durationMs, 5_000);
  assert.deepEqual(run.stages.map((stage) => stage.stageId), [
    'INIT',
    'HEAT_SIGNAL_STABILIZATION',
    'HEAT_NOISE_CAPTURE',
    'HEAT_INTERFERENCE',
    'FLASH',
    'COMPLETE',
  ]);

  const noise = run.stages.find((stage) => stage.stageId === 'HEAT_NOISE_CAPTURE');
  const heatInterference = run.stages.find((stage) => stage.stageId === 'HEAT_INTERFERENCE');
  assert.equal(noise.durationMs, 1_000);
  assert.equal(noise.waveforms[0].sampleCount, 1);
  assert.equal(heatInterference.waveforms[0].sampleCount, 1);
  assert.equal(noise.detectorObservations.length, 2);
  assert.equal(noise.detectorObservations[0].stageId, 'HEAT_NOISE_CAPTURE');
  assert.equal(noise.detectors.length, 1);
  assert.equal(noise.detectors[0].observationCount, 2);
  assert.equal(noise.detectors[0].retainedObservationCount, 2);
  assert.equal(noise.detectors[0].latest.probe2, 26);
  assert.deepEqual(noise.detectors[0].stats.probe2, {
    count: 2,
    min: 20,
    max: 26,
    mean: 23,
    last: 26,
  });
  assert.equal(noise.detectors[0].stats.probe2Absolute.min, 126);
  assert.equal(noise.detectors[0].stats.probe2Fluctuation.last, 2.5);
  assert.equal(noise.detectors[0].stats.snr23.last, 1.5);
  assert.equal(heatInterference.detectors[0].latest.probe3, 30);
  assert.equal(run.relayEvents.some((event) => event.address === 'Q0.1' && event.value === true), true);
  assert.equal(run.relayEvents.some((event) => event.address === 'Q1.2' && event.value === true), true);
  assert.equal(run.decision.verdict, 'FAIL');
  assert.match(run.decision.reasons.join(' '), /NOISE_RMS_EXCEEDS_LIMIT/);

  tracker.observeProcess(processStatus(6_100, 'COMPLETE', 'IDLE', { complete: true, autoRunning: false }));
  tracker.completePending(6_100);
  assert.equal(finalized.length, 1, 'repeated COMPLETE must not duplicate a run');
});
