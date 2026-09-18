import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { normalizeIndicatorVisionReport } from '../src/indicator-vision.js';
import { LabelPrintQueueStore } from '../src/label-print-queue.js';

function indicator(status: '合格' | '不合格') {
  return { status, source: 'AUTO' as const };
}

function productionRecord(productVerdict: '合格' | '不合格', runningGreen: '合格' | '不合格', fireRed: '合格' | '不合格') {
  const pass = indicator('合格');
  return {
    schemaVersion: 1,
    batchId: `regression-${Date.now()}-${Math.random()}`,
    productModel: 'GHT-1050-02',
    productionDate: Date.now(),
    inspector: '自动检测',
    standard: 'GB15631－2008',
    formNumber: 'WUTOS/IMS-JL836',
    formVersion: 'A/0',
    quantity: 1,
    products: [{
      slot: 1,
      productCode: '410205901010100001',
      productCodeStatus: 'GENERATED',
      workCurrent: pass,
      fireAction: pass,
      faultAction: pass,
      ledDisplay: pass,
      indicatorVision: {
        ...indicator(productVerdict),
        runningGreen: indicator(runningGreen),
        fireRed: indicator(fireRed),
        // Explicitly keep yellow failed to prove it never drives the label verdict.
        faultYellow: indicator('不合格'),
        captureCount: 3,
        phases: ['ALARM_VERIFY'],
      },
      amplitude: { values: [150, 180], status: '合格', source: 'AUTO' },
      softwareVersion: { value: '90.26.08.11', status: '合格', source: 'AUTO' },
      productInfo: { value: { probeCount: 2, sensitivityLevel: 2 }, status: '合格', source: 'AUTO' },
      interferenceResistance: pass,
      powerFluctuation: pass,
      highTemp: pass,
      lowTemp: pass,
      verdict: productVerdict,
    }],
    conclusion: productVerdict,
    generatedAt: Date.now(),
  } as any;
}

function detectorVerdict(grade: 'A_PASS' | 'FAIL', verdict: 'PASS' | 'FAIL', reason?: string) {
  return {
    verdict,
    grade,
    timestamp: Date.now(),
    units: [{ index: 1, address: 1, grade, verdict, reason, sampledAt: Date.now(), metrics: {} }],
  } as any;
}

test('indicator production verdict ignores fault-yellow failure and distrusts caller overall verdict', () => {
  const report = normalizeIndicatorVisionReport({
    batchId: 'batch-led-regression',
    capturedAt: Date.now(),
    captureCount: 4,
    phases: ['ALARM_VERIFY', 'FAULT_VERIFY'],
    verdict: 'FAIL',
    units: [{
      slot: 1,
      runningGreen: 'PASS',
      fireRed: 'PASS',
      faultYellow: 'FAIL',
      verdict: 'FAIL',
    }],
  }, 'batch-led-regression');

  assert.ok(report);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.units[0]?.verdict, 'PASS');
  assert.equal(report.units[0]?.faultYellow, 'FAIL', '黄灯证据仍保留，但不得影响最终判定');
});

test('label queue keeps yellow-only failure as pass and prints a real NG reason when required LED fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-indicator-label-regression-'));
  const store = new LabelPrintQueueStore(join(directory, 'queue.json'));

  const passRecord = productionRecord('合格', '合格', '合格');
  const passJobs = await store.enqueueProductionRecord(passRecord, detectorVerdict('A_PASS', 'PASS'));
  assert.equal(passJobs[0]?.verdict, 'A类合格');
  assert.equal(passJobs[0]?.isolation, false);
  assert.deepEqual(passJobs[0]?.ngReasons, []);
  assert.equal(passJobs[0]?.labelReason, null);

  const ngRecord = productionRecord('不合格', '不合格', '合格');
  const ngJobs = await store.enqueueProductionRecord(ngRecord, detectorVerdict('FAIL', 'FAIL', 'INDICATOR_VISION_FAILED'));
  assert.equal(ngJobs[0]?.verdict, '不合格');
  assert.equal(ngJobs[0]?.isolation, true);
  assert.deepEqual(ngJobs[0]?.ngReasons, ['运行绿灯异常']);
  assert.equal(ngJobs[0]?.labelReason, '运行绿灯异常');
});
