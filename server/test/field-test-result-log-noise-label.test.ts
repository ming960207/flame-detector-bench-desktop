import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileFieldTestResultLogger, type CompletedFieldTest } from '../src/closure/field-test-result-log.js';

const stage = {
  completed: true,
  verdict: 'PASS',
  reason: 'STAGE_WITHIN_LIMIT',
  sampleCount: 100,
  interferenceRatio: 1,
  consistencyTrend: 0.95,
  snr21: 0,
  snr23: 1,
  snr31: 0,
};

test('result log reports RAW fluctuation as the formal noise metric and RMS as diagnostic only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flame-result-log-'));
  try {
    const logger = new FileFieldTestResultLogger(directory);
    const completedAt = Date.now();
    const fixture = {
      batchId: 'noise-label-regression',
      startedAt: completedAt - 120_000,
      completedAt,
      finalVerdict: { verdict: 'FAIL', grade: 'FAIL' },
      detectorVerdict: {
        verdict: 'FAIL',
        grade: 'FAIL',
        timestamp: completedAt,
        productType: 'DUAL_WAVELENGTH',
        expectedSoftwareVersion: '90.22.09.15',
        expectedProbeCount: 2,
        units: [{
          index: 1,
          address: 1,
          verdict: 'FAIL',
          grade: 'FAIL',
          reason: 'PROBE2_NOISE_RMS_EXCEEDS_LIMIT',
          sampledAt: completedAt,
          metrics: {
            noiseRms: 103.036,
            noisePeakToPeak: 149.5,
            noiseAbsolute: 483,
            interferenceRatio: 1,
            consistencyTrend: 0.95,
            snr21: 0,
            snr23: 1,
            snr31: 0,
            sensitivity: 0,
          },
        }],
      },
      thresholds: {
        minNoiseSamples: 400,
        minInterferenceSamples: 80,
        minNoiseRms: 50,
        maxNoiseRms: 200,
        maxNoiseAbsolute: 1000,
        maxInterferenceRatio: 0,
        noiseProbes: ['probe2', 'probe3'],
        consistencyProbes: ['probe2', 'probe3'],
        minConsistencyTrend: 0.75,
        quality: {
          acceptanceGrade: 'B',
          a: { maxNoiseRms: 180, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0.8, minSensitivity: 0 },
          b: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 0, minConsistencyTrend: 0.75, minSensitivity: 0 },
          ratios: {
            a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } },
            b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.48, max: 1.5 }, snr31: { min: 0, max: 0 } },
          },
        },
      },
      waveformAnalysis: {
        batchId: 'noise-label-regression',
        phase: 'COMPLETE',
        processStage: 'COMPLETE',
        heatSubstage: 'IDLE',
        heatSubstageLabel: '待机',
        heatStageTimings: {
          stabilizationStartedAt: completedAt - 50_000,
          stabilizationEndedAt: completedAt - 40_000,
          noiseStartedAt: completedAt - 40_000,
          noiseEndedAt: completedAt - 20_000,
          interferenceStartedAt: completedAt - 20_000,
          interferenceEndedAt: completedAt - 10_000,
        },
        verdict: 'FAIL',
        startedAt: completedAt - 120_000,
        noiseCaptureActive: false,
        noiseStartedAt: completedAt - 40_000,
        noiseEndedAt: completedAt - 20_000,
        updatedAt: completedAt,
        thresholds: {},
        units: [{
          index: 1,
          address: 1,
          phase: 'COMPLETE',
          verdict: 'FAIL',
          noiseRms: 103.036,
          noisePeakToPeak: 149.5,
          noiseAbsolute: 483,
          interferenceRms: 10,
          interferenceRatio: 1,
          consistencyTrend: 0.95,
          snr21: 0,
          snr23: 1,
          snr31: 0,
          noiseSampleCount: 600,
          noiseTest: {
            verdict: 'FAIL',
            reason: 'NOISE_RMS_EXCEEDS_LIMIT',
            sampleCount: 600,
            metrics: {
              probe1: { fluctuation: 5, absolute: 10 },
              probe2: { fluctuation: 215, absolute: 480 },
              probe3: { fluctuation: 180, absolute: 450 },
              probe4: { fluctuation: 0, absolute: 0 },
            },
          },
          interferenceSampleCount: 300,
          stages: { heat: stage, flash: stage, emc: stage },
          sampledAt: completedAt,
        }],
      },
      inspectionPositions: [],
    } as unknown as CompletedFieldTest;

    const output = logger.record(fixture);
    assert.ok(output);
    const content = readFileSync(output, 'utf8');
    assert.match(content, /噪声波动值\(RAW\)/);
    assert.match(content, /P2 RAW波动/);
    assert.match(content, /P2波动 215 > B上限 200/);
    assert.match(content, /RMS\(辅助\)/);
    assert.match(content, /真实 RMS 仅作为分析辅助参数，不参与合格判定/);
    assert.doesNotMatch(content, /噪声 RMS 超过上限/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
