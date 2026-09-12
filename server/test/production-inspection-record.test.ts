import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProductionInspectionRecord,
  productionInspectionRecordDocument,
  ProductionInspectionRecordStore,
} from '../src/production-inspection-record-store.js';
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

test('record keeps code status separate and reports P2/P3 noise fluctuations as amplitude', () => {
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
  assert.equal(record.products[0]?.workCurrent.source, 'AUTO');
  assert.equal(record.products[0]?.workCurrent.status, '合格');
  assert.equal(record.products[0]?.fireAction.source, 'NOT_APPLICABLE');
  assert.equal(record.products[0]?.fireAction.status, '不适用');
  assert.deepEqual(record.products[0]?.amplitude.values, [110, 105]);
  assert.equal(record.conclusion, '合格');
  const document = productionInspectionRecordDocument(record);
  assert.match(document, /未生成/);
  assert.match(document, /110，105/);
  assert.match(document, /不适用/);
});

test('indicator vision evidence is included in the production report template', () => {
  const productConfig = normalizeProductDetectionConfig({ selectedType: 'THREE_WAVELENGTH' }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const checked = precheck(false) as any;
  checked.indicatorVision = {
    batchId: 'batch-1',
    capturedAt: 4,
    source: 'UVC_HSV',
    captureCount: 3,
    phases: ['ALARM_VERIFY', 'FAULT_VERIFY'],
    verdict: 'PASS',
    units: Array.from({ length: 6 }, (_, offset) => ({
      slot: offset + 1,
      runningGreen: 'PASS',
      fireRed: 'PASS',
      faultYellow: 'PASS',
      verdict: 'PASS',
    })),
  };
  const record = buildProductionInspectionRecord({
    batchId: 'batch-1',
    productConfig,
    precheck: checked,
    detectorVerdict: detectorVerdict(),
    waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
    productionDate: Date.now(),
  });
  assert.equal(record.products[0]?.indicatorVision?.status, '合格');
  assert.equal(record.products[0]?.indicatorVision?.captureCount, 3);
  const document = productionInspectionRecordDocument(record);
  assert.match(document, /LED 显示检验/);
  const ledRow = document.match(/<td class="index">4<\/td><td class="item">LED 显示检验<\/td>([\s\S]*?)<\/tr>/)?.[1];
  if (!ledRow) throw new Error('LED 显示检验行缺失');
  assert.match(ledRow, /<span class="pass">合格<\/span>/);
  assert.doesNotMatch(ledRow, /绿灯|红灯|黄灯|抓拍|vision-detail/);
});

test('production report follows the official inspection item order', () => {
  const productConfig = normalizeProductDetectionConfig({ selectedType: 'THREE_WAVELENGTH' }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const record = buildProductionInspectionRecord({
    batchId: 'batch-1',
    productConfig,
    precheck: precheck(false),
    detectorVerdict: detectorVerdict(),
    waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
    productionDate: Date.now(),
  });
  const document = productionInspectionRecordDocument(record);
  const labels = [...document.matchAll(/<td class="item">([^<]+)<\/td>/g)].map((match) => match[1]);
  assert.deepEqual(labels, [
    '工作电流检验',
    '火警动作检验',
    '故障动作检验',
    'LED 显示检验',
    '幅值测试',
    '产品默认设置',
    '抗干扰测试',
    '电源波动试验',
    '高温运行试验',
    '低温运行试验',
  ]);
  assert.equal(record.products[0]?.workCurrent.status, '合格');
  assert.equal(record.products[0]?.powerFluctuation.status, '合格');
  assert.equal(record.products[0]?.highTemp.status, '合格');
  assert.equal(record.products[0]?.lowTemp.status, '合格');
  assert.match(document, /产品默认设置/);
  assert.match(document, /90\.26\.08\.11/);
});

test('production report is a Word-compatible table document saved with a .doc extension', async () => {
  const productConfig = normalizeProductDetectionConfig({ selectedType: 'THREE_WAVELENGTH' }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const record = buildProductionInspectionRecord({
    batchId: 'batch-document',
    productConfig,
    precheck: precheck(false),
    detectorVerdict: detectorVerdict(),
    waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
    productionDate: new Date(2026, 7, 31).getTime(),
  });
  const document = productionInspectionRecordDocument(record);
  assert.match(document, /xmlns:w="urn:schemas-microsoft-com:office:word"/);
  assert.match(document, /mso-page-orientation: landscape/);
  assert.match(document, /<table class="w-table">/);
  assert.match(document, /检验数量：6 台/);
  assert.match(document, /<td class="sample-code">/);
  assert.match(document, /\.sample-code \{[^}]*white-space: nowrap/);
  assert.doesNotMatch(document, /不合格现象记录/);
  assert.equal([...document.matchAll(/<td class="item">/g)].length, 10);

  const directory = await mkdtemp(join(tmpdir(), 'flame-production-record-test-'));
  try {
    const store = new ProductionInspectionRecordStore(directory);
    const saved = await store.save(record);
    assert.match(saved.documentPath, /\.doc$/);
    assert.equal(await readFile(saved.documentPath, 'utf8'), document);
    assert.equal(await store.loadDocument(record.batchId), document);
    assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.html')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test('required relay test cannot pass when real relay evidence is missing', () => {
  const productConfig = normalizeProductDetectionConfig({
    ...DEFAULT_PRODUCT_DETECTION_CONFIG,
    selectedType: 'THREE_WAVELENGTH',
    profiles: {
      ...DEFAULT_PRODUCT_DETECTION_CONFIG.profiles,
      THREE_WAVELENGTH: { ...DEFAULT_PRODUCT_DETECTION_CONFIG.profiles.THREE_WAVELENGTH, relayFunctionalTestEnabled: true },
    },
  });
  const record = buildProductionInspectionRecord({
    batchId: 'batch-1', productConfig, precheck: precheck(false), detectorVerdict: detectorVerdict(), waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG, productionDate: Date.now(),
  });
  assert.equal(record.products[0]?.fireAction.status, '不合格');
  assert.equal(record.products[0]?.faultAction.status, '不合格');
  assert.equal(record.products[0]?.verdict, '不合格');
  assert.equal(record.conclusion, '不合格');
});
