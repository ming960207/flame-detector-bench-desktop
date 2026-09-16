import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateFieldDetectorBatch } from '../src/closure/field-detector-verdict.js';
import { evaluateFieldFinalVerdict } from '../src/closure/field-final-verdict.js';
import { FileFieldTestResultLogger } from '../src/closure/field-test-result-log.js';
import type { FieldWaveformAnalysisSnapshot, WaveformAnalysisUnitResult } from '../src/closure/field-waveform-analysis.js';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig } from '../src/relay-functional-test.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
  type ProductPrecheckReport,
} from '../src/product-profile.js';
import type { FlameDetectorState, FlameDetectorUnitState } from '../src/types.js';

function detector(index: number): FlameDetectorUnitState {
  return {
    index,
    address: 1,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 0,
    probe2: 100,
    probe3: 110,
    snr21: 0,
    snr23: 1,
    snr31: 0,
    sensitivity: 1,
    sendMode: 1,
    version: '90.22.09.15',
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

function detectorState(): FlameDetectorState {
  return {
    units: Array.from({ length: 6 }, (_, index) => detector(index + 1)),
    onlineCount: 6,
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
        expectedSoftwareVersion: '90.22.09.15',
        expectedProbeCount: 2,
      },
    },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);
}

function analysisUnit(index: number): WaveformAnalysisUnitResult {
  const channelMetrics = {
    probe1: { fluctuation: 0, absolute: 0 },
    probe2: { fluctuation: 160, absolute: 400 },
    probe3: { fluctuation: 160, absolute: 400 },
    probe4: { fluctuation: 0, absolute: 0 },
  };
  const stage = {
    completed: true,
    verdict: 'PASS' as const,
    reason: 'STAGE_WITHIN_LIMIT',
    sampleCount: 100,
    interferenceRatio: 1,
    consistencyTrend: 0.95,
    snr21: 0,
    snr23: 1,
    snr31: 0,
  };
  return {
    index,
    address: 1,
    phase: 'COMPLETE',
    verdict: 'PASS',
    noiseRms: 60,
    noisePeakToPeak: 160,
    noiseAbsolute: 400,
    interferenceRms: 10,
    interferenceRatio: 1,
    consistencyTrend: 0.95,
    snr21: 0,
    snr23: 1,
    snr31: 0,
    noiseSampleCount: 800,
    noiseTest: {
      verdict: 'PASS',
      reason: 'NOISE_WITHIN_LIMIT',
      sampleCount: 800,
      metrics: channelMetrics,
    },
    interferenceSampleCount: 300,
    stages: { heat: { ...stage }, flash: { ...stage }, emc: { ...stage } },
    sampledAt: 1_000,
    reason: 'WAVEFORM_WITHIN_LIMIT',
  };
}

function analysisSnapshot(): FieldWaveformAnalysisSnapshot {
  return {
    batchId: 'same-batch-retest',
    phase: 'COMPLETE',
    processStage: 'COMPLETE',
    heatSubstage: 'IDLE',
    heatSubstageLabel: '非热源阶段',
    heatStageTimings: {
      stabilizationStartedAt: 1,
      stabilizationEndedAt: 2,
      noiseStartedAt: 3,
      noiseEndedAt: 4,
      interferenceStartedAt: 5,
      interferenceEndedAt: 6,
    },
    verdict: 'PASS',
    startedAt: 1,
    noiseCaptureActive: false,
    noiseStartedAt: 3,
    noiseEndedAt: 4,
    updatedAt: 1_000,
    thresholds: {
      minNoiseSamples: 400,
      minInterferenceSamples: 80,
      minNoiseRms: 50,
      maxNoiseRms: 250,
      maxNoiseAbsolute: 1000,
      maxInterferenceRatio: 0,
      noiseProbes: ['probe2', 'probe3'],
      interferenceRatio: { numerator: 'probe3', denominator: 'probe2' },
      consistencyProbes: ['probe2', 'probe3'],
      minConsistencyTrend: 0.75,
      quality: {
        acceptanceGrade: 'B',
        a: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0.8, minSensitivity: 0 },
        // Intentionally stale legacy B values. New grading must ignore them and
        // derive B from A (200 -> 220) instead.
        b: { maxNoiseRms: 250, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0.75, minSensitivity: 0 },
        ratios: {
          a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } },
          b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.48, max: 1.5 }, snr31: { min: 0, max: 0 } },
        },
      },
    },
    units: Array.from({ length: 6 }, (_, index) => analysisUnit(index + 1)),
  };
}

function precheckReport(): ProductPrecheckReport {
  return {
    batchId: 'same-batch-retest',
    productType: 'DUAL_WAVELENGTH',
    productLabel: '双波长',
    expectedSoftwareVersion: '90.22.09.15',
    expectedProbeCount: 2,
    startedAt: 10,
    completedAt: 20,
    verdict: 'FAIL',
    units: Array.from({ length: 6 }, (_, index) => index === 0 ? {
      index: 1,
      address: 1,
      productType: 'DUAL_WAVELENGTH',
      expectedSoftwareVersion: '90.22.09.15',
      actualSoftwareVersion: null,
      expectedProbeCount: 2,
      actualProbeCount: 2,
      sensitivityLevel: 1,
      fireAlarm: false,
      fault: false,
      checkedAt: 20,
      verdict: 'FAIL' as const,
      reasons: ['TEST_INFRASTRUCTURE_INVALID', 'SOFTWARE_VERSION_READ_FAILED'],
    } : {
      index: index + 1,
      address: 1,
      productType: 'DUAL_WAVELENGTH',
      expectedSoftwareVersion: '90.22.09.15',
      actualSoftwareVersion: '90.22.09.15',
      expectedProbeCount: 2,
      actualProbeCount: 2,
      sensitivityLevel: 1,
      fireAlarm: false,
      fault: false,
      checkedAt: 20,
      verdict: 'PASS' as const,
      reasons: [],
    }),
  };
}

function passingPrecheckReport(): ProductPrecheckReport {
  const report = precheckReport();
  report.verdict = 'PASS';
  report.units = report.units.map((unit) => ({
    ...unit,
    actualSoftwareVersion: '90.22.09.15',
    verdict: 'PASS' as const,
    reasons: [],
  }));
  return report;
}

test('transient relay simulate/reset transport failures recover within bounded retries', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let simulateFailuresRemaining = 1;
  let resetFailuresRemaining = 1;
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      if (simulateFailuresRemaining > 0) {
        simulateFailuresRemaining -= 1;
        throw new Error('transient simulate transport error');
      }
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      if (resetFailuresRemaining > 0) {
        resetFailuresRemaining -= 1;
        throw new Error('transient reset transport error');
      }
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1',
      faultInputAddress: 'X2',
      alarmNormalLevel: false,
      faultNormalLevel: false,
    }],
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('transient-retry');

  assert.equal(report.verdict, 'PASS');
  assert.equal(report.units[0]?.verdict, 'PASS');
  assert.equal(report.units[0]?.alarm.reasons.includes('ALARM_COMMAND_FAILED'), false);
  assert.equal(report.units[0]?.alarm.reasons.includes('ALARM_RESET_COMMAND_FAILED'), false);
});

test('infrastructure-only completed precheck failure is blocking but classified as retest instead of product NG', () => {
  const waveform = analysisSnapshot();
  const verdict = evaluateFieldDetectorBatch(detectorState(), waveform, precheckReport(), productConfig());

  assert.equal(verdict.verdict, 'FAIL');
  assert.equal(verdict.units[0]?.classification, 'TEST_INVALID');
  assert.equal(verdict.units[0]?.reason, 'TEST_INVALID_RETEST_REQUIRED');
  assert.equal(verdict.testInvalidCount, 1);
  assert.equal(verdict.productFailCount, 0);
  assert.equal(verdict.units.slice(1).every((unit) => unit.grade === 'A_PASS'), true);

  const final = evaluateFieldFinalVerdict({ stage: 'COMPLETE', processStage: 'COMPLETE', complete: true, valid: true }, verdict, waveform);
  assert.equal(final.verdict, 'FAIL');
  assert.equal(final.reason, 'TEST_INVALID_RETEST_REQUIRED');
});

test('RAW fluctuation above A limit but within automatic 10 percent B tolerance is graded B', () => {
  const waveform = analysisSnapshot();
  const d4 = waveform.units[3]!;
  d4.noiseTest.metrics.probe2 = { fluctuation: 208, absolute: 271 };
  d4.noiseTest.metrics.probe3 = { fluctuation: 200, absolute: 241 };

  const verdict = evaluateFieldDetectorBatch(detectorState(), waveform, passingPrecheckReport(), productConfig());
  assert.equal(verdict.units[3]?.verdict, 'PASS');
  assert.equal(verdict.units[3]?.grade, 'B_PASS');
  assert.match(verdict.units[3]?.reason ?? '', /^A_GRADE_/);
  assert.equal(verdict.units.filter((unit) => unit.grade === 'FAIL').length, 0);
});

test('field result logs use Asia/Shanghai date and label regardless host timezone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flame-result-shanghai-'));
  try {
    const waveform = analysisSnapshot();
    const detectorVerdict = evaluateFieldDetectorBatch(detectorState(), waveform, precheckReport(), productConfig());
    const completedAt = Date.parse('2026-09-09T16:30:00Z'); // 2026-09-10 00:30:00 in Shanghai.
    const logger = new FileFieldTestResultLogger(directory);
    const file = logger.record({
      batchId: 'timezone-check',
      startedAt: completedAt - 150_000,
      completedAt,
      finalVerdict: { verdict: 'FAIL', grade: 'FAIL', reason: 'TEST_INVALID_RETEST_REQUIRED' },
      detectorVerdict,
      thresholds: waveform.thresholds,
      waveformAnalysis: waveform,
      inspectionPositions: [],
      productConfig: productConfig(),
      productPrecheck: precheckReport(),
    });

    assert.equal(file.endsWith('test-results-2026-09-10.log'), true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /完成时间：2026-09-10 00:30:00（Asia\/Shanghai \(UTC\+8\)）/);
    assert.match(text, /结果：需复测/);
    assert.match(text, /NG 0 \/ 复测 1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
