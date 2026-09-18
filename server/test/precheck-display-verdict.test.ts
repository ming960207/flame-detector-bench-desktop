import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldDetectorBatch } from '../src/closure/field-detector-verdict.js';
import type { FieldWaveformAnalysisSnapshot } from '../src/closure/field-waveform-analysis.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
  type ProductPrecheckReport,
} from '../src/product-profile.js';
import type { FlameDetectorState, FlameDetectorUnitState } from '../src/types.js';

function detector(): FlameDetectorUnitState {
  return {
    index: 1,
    address: 1,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 10,
    probe2: 11,
    probe3: 12,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    sensitivity: 1,
    sendMode: 1,
    version: '01.02.03.05',
    address_r: 1,
    runTime: 0,
    probeCount: 2,
    lastUpdate: 1_000,
    protocol: 'standard',
    samples: [],
    rawSamples: [],
    historySamples: [],
    rawHistorySamples: [],
    historySampleTotal: 100,
  };
}

function state(): FlameDetectorState {
  return {
    units: [detector()],
    onlineCount: 1,
    fireCount: 0,
    faultCount: 0,
    timestamp: 1_000,
  };
}

function productConfig() {
  return normalizeProductDetectionConfig({
    selectedType: 'DUAL_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: {
        expectedSoftwareVersion: '01.02.03.04',
        expectedProbeCount: 2,
      },
    },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);
}

function failedPrecheck(): ProductPrecheckReport {
  return {
    batchId: 'batch-1',
    productType: 'DUAL_WAVELENGTH',
    productLabel: '双波长',
    expectedSoftwareVersion: '01.02.03.04',
    expectedProbeCount: 2,
    startedAt: 10,
    completedAt: 20,
    verdict: 'FAIL',
    units: [{
      index: 1,
      address: 1,
      productType: 'DUAL_WAVELENGTH',
      expectedSoftwareVersion: '01.02.03.04',
      actualSoftwareVersion: '01.02.03.05',
      expectedProbeCount: 2,
      actualProbeCount: 2,
      fireAlarm: false,
      fault: false,
      checkedAt: 20,
      verdict: 'FAIL',
      reasons: ['SOFTWARE_VERSION_MISMATCH'],
    }],
  };
}

function analysis(phase: 'NOISE' | 'COMPLETE'): FieldWaveformAnalysisSnapshot {
  return {
    batchId: 'batch-1',
    phase,
    processStage: phase === 'COMPLETE' ? 'COMPLETE' : 'HEAT',
    heatSubstage: phase === 'COMPLETE' ? 'IDLE' : 'NOISE_CAPTURE',
    heatSubstageLabel: phase === 'COMPLETE' ? '非热源阶段' : '噪声采集阶段',
    heatStageTimings: {
      stabilizationStartedAt: 1,
      stabilizationEndedAt: 2,
      noiseStartedAt: 3,
      noiseEndedAt: phase === 'COMPLETE' ? 4 : null,
      interferenceStartedAt: phase === 'COMPLETE' ? 5 : null,
      interferenceEndedAt: phase === 'COMPLETE' ? 6 : null,
    },
    verdict: phase === 'COMPLETE' ? 'PASS' : 'PENDING',
    startedAt: 1,
    noiseCaptureActive: phase !== 'COMPLETE',
    noiseStartedAt: 3,
    noiseEndedAt: phase === 'COMPLETE' ? 4 : null,
    updatedAt: 1_000,
    thresholds: {
      minNoiseSamples: 400,
      minInterferenceSamples: 80,
      minNoiseRms: 50,
      maxNoiseRms: 200,
      maxNoiseAbsolute: 1000,
      maxInterferenceRatio: 1.5,
      noiseProbes: ['probe1', 'probe2'],
      interferenceRatio: { numerator: 'probe2', denominator: 'probe1' },
      consistencyProbes: ['probe1', 'probe2'],
      minConsistencyTrend: 0.75,
    },
    units: [],
  };
}

test('failed precheck is recorded but does not expose NG while process is running', () => {
  const verdict = evaluateFieldDetectorBatch(state(), analysis('NOISE'), failedPrecheck(), productConfig());
  assert.equal(verdict.verdict, 'PENDING');
  assert.equal(verdict.grade, 'PENDING');
  assert.equal(verdict.units[0]?.verdict, 'PENDING');
  assert.equal(verdict.units[0]?.grade, 'PENDING');
  assert.equal(verdict.units[0]?.reason, 'PRODUCT_PRECHECK_RECORDED');
  assert.deepEqual(verdict.units[0]?.precheck?.reasons, ['SOFTWARE_VERSION_MISMATCH']);
  assert.equal(verdict.productPrecheckVerdict, 'FAIL');
});

test('the same recorded precheck failure becomes NG after process completion', () => {
  const verdict = evaluateFieldDetectorBatch(state(), analysis('COMPLETE'), failedPrecheck(), productConfig());
  assert.equal(verdict.verdict, 'FAIL');
  assert.equal(verdict.grade, 'FAIL');
  assert.equal(verdict.units[0]?.verdict, 'FAIL');
  assert.equal(verdict.units[0]?.reason, 'SOFTWARE_VERSION_MISMATCH');
});
