import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionInspectionRecord, productionInspectionRecordHtml } from '../src/production-inspection-record-store.js';
import { DEFAULT_PRODUCT_DETECTION_CONFIG, normalizeProductDetectionConfig } from '../src/product-profile.js';
import { DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG } from '../src/production-inspection-record.js';

function analysis() {
  return {
    batchId: 'batch-1',
    phase: 'COMPLETE',
    processStage: 'COMPLETE',
    heatSubstage: 'IDLE',
    heatSubstageLabel: '',
    heatStageTimings: {},
    verdict: 'PASS',
    startedAt: 1,
    noiseCaptureActive: false,
    noiseStartedAt: 1,
    noiseEndedAt: 2,
    updatedAt: 3,
    thresholds: {},
    units: Array.from({ length: 6 }, (_, offset) => ({
      index: offset + 1,
      address: 1,
      phase: 'COMPLETE',
      verdict: 'PASS',
      noiseRms: 100,
      noisePeakToPeak: 100,
      noiseAbsolute: 180,
      interferenceRms: 100,
      interferenceRatio: 1,
      consistencyTrend: 0.9,
      snr21: 1,
      snr23: 1,
      snr31: 1,
      noiseSampleCount: 400,
      noiseTest: {
        verdict: 'PASS',
        reason: 'OK',
        sampleCount: 400,
        metrics: {
          probe1: { fluctuation: 100, absolute: 150 },
          probe2: { fluctuation: 110, absolute: 180 },
          probe3: { fluctuation: 105, absolute: 170 },
          probe4: { fluctuation: 0, absolute: 0 },
        },
      },
      interferenceSampleCount: 100,
      stages: {
        heat: { completed: true, verdict: 'PASS' },
        flash: { completed: true, verdict: 'PASS' },
        emc: { completed: true, verdict: 'PASS' },
      },
      sampledAt: 3,
    })),
  } as any;
}

function detectorVerdict() {
  return {
    verdict: 'PASS',
    grade: 'A_PASS',
    timestamp: 3,
    units: Array.from({ length: 6 }, (_, offset) => ({
      index: offset + 1,
      address: 1,
      verdict: 'PASS',
      grade: 'A_PASS',
      sampledAt: 3,
      metrics: { noiseRms: 100, noisePeakToPeak: 100, noiseAbsolute: 180, interferenceRatio: 1, consistencyTrend: 0.9, snr21: 1, snr23: 1, snr31: 1, sensitivity: 2 },
    })),
  } as any;
}

function precheck(relayEnabled = false) {
  return {
    batchId: 'batch-1',
    productType: 'THREE_WAVELENGTH',
    productLabel: '三波长',
    productModel: 'GHT-1050-03',
    expectedSoftwareVersion: '90.26.08.11',
    expectedProbeCount: 3,
    productionDate: new Date(2026, 7, 31).getTime(),
    productCodeAllocation: {
      batchId: 'batch-1',
      status: 'RULE_MISSING',
      productModel: 'GHT-1050-03',
      monthKey: null,
      productionDate: new Date(2026, 7, 31).getTime(),
      items: [],
      reason: 'missing',
    },
    relayFunctionalTest: relayEnabled ? {
      batchId: 'batch-1', mode: 'FAST_BATCH', phase: 'COMPLETE', startedAt: 1, completedAt: 2, verdict: 'PASS',
      units: Array.from({ length: 6 }, (_, offset) => ({
        detectorIndex: offset + 1,
        enabled: true,
        baseline: { alarmInternal: false, faultInternal: false, alarmPhysical: false, faultPhysical: false },
        alarm: { commandAccepted: true, internalStateReached: true, physicalStateReached: true, oppositeRelayStayedNormal: true, responseTimeMs: 10, resetAccepted: true, internalRecovered: true, physicalRecovered: true, verdict: 'PASS', reasons: [] },
        fault: { commandAccepted: true, internalStateReached: true, physicalStateReached: true, oppositeRelayStayedNormal: true, responseTimeMs: 10, resetAccepted: true, internalRecovered: true, physicalRecovered: true, verdict: 'PASS', reasons: [] },
        verdict: 'PASS',
      })),
    } : null,
    startedAt: 1,
    completedAt: 2,
    verdict: 'PASS',
    units: Array.from({ length: 6 }, (_, offset) => ({
      index: offset + 1,
      address: 1,
      productType: 'THREE_WAVELENGTH',
      expectedSoftwareVersion: '90.26.08.11',
      actualSoftwareVersion: '90.26.08.11',
      expectedProbeCount: 3,
      actualProbeCount: 3,
      sensitivityLevel: 2,
      fireAlarm: false,
      fault: false,
      checkedAt: 1,
      verdict: 'PASS',
      reasons: [],
    })),
  } as any;
}

test('record keeps code status separate from detector verdict and defaults five non-measured items to pass', () => {
  const productConfig = normalizeProductDetectionConfig({ selectedType: 'THREE_WAVELENGTH' }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const record = buildProductionInspectionRecord({
    batchId: 'batch-1',
    productConfig,
    precheck: precheck(false),
    detectorVerdict: detectorVerdict(),
    waveformAnalysis: analysis(),
    recordConfig: { ...DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG, inspector: '测试员' },
    productionDate: new Date(2026, 7, 31).getTime(),
  });
  assert.equal(record.products.length, 6);
  assert.equal(record.products[0]?.productCode, null);
  assert.equal(record.products[0]?.productCodeStatus, 'RULE_MISSING');
  assert.equal(record.products[0]?.verdict, '合格');
  assert.equal(record.products[0]?.workCurrent.source, 'DEFAULT_PASS');
  assert.equal(record.products[0]?.fireAction.source, 'DEFAULT_PASS');
  assert.deepEqual(record.products[0]?.amplitude.values, [150, 180, 170]);
  assert.equal(record.conclusion, '合格');
  const html = productionInspectionRecordHtml(record);
  assert.match(html, /未生成/);
  assert.match(html, /150，180，170/);
});

test('enabled relay test gates the slot verdict independently', () => {
  const productConfig = normalizeProductDetectionConfig({
      ...DEFAULT_PRODUCT_DETECTION_CONFIG,
      selectedType: 'THREE_WAVELENGTH',
    profiles: {
      ...DEFAULT_PRODUCT_DETECTION_CONFIG.profiles,
      THREE_WAVELENGTH: { ...DEFAULT_PRODUCT_DETECTION_CONFIG.profiles.THREE_WAVELENGTH, relayFunctionalTestEnabled: true },
    },
  });
  const checked = precheck(true);
  checked.relayFunctionalTest.units[1].fault.verdict = 'FAIL';
  checked.relayFunctionalTest.units[1].fault.reasons = ['FAULT_RELAY_NOT_ACTUATED'];
  checked.relayFunctionalTest.units[1].verdict = 'FAIL';
  checked.relayFunctionalTest.verdict = 'FAIL';

  const record = buildProductionInspectionRecord({
    batchId: 'batch-1', productConfig, precheck: checked, detectorVerdict: detectorVerdict(), waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG, productionDate: Date.now(),
  });
  assert.equal(record.products[0]?.verdict, '合格');
  assert.equal(record.products[1]?.faultAction.status, '不合格');
  assert.equal(record.products[1]?.verdict, '不合格');
  assert.equal(record.conclusion, '不合格');
});
