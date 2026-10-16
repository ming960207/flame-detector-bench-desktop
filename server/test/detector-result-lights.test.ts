import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { detectorResultLights } from '../src/detector-result-lights.js';
import { DEFAULT_PRODUCTION_TEST_SKIP_CONFIG as defaults } from '../src/production-test-skip-config.js';
import type { ProductPrecheckReport } from '../src/product-profile.js';
const report = {
  batchId: 'batch-1',
  indicatorVision: { batchId: 'batch-1', units: [{ slot: 1, runningGreen: 'PASS', fireRed: 'FAIL', faultYellow: 'PENDING' }] },
  relayFunctionalTest: { batchId: 'batch-1', verdict: 'FAIL', units: [{ detectorIndex: 1, alarm: { verdict: 'PASS' }, fault: { verdict: 'FAIL' } }] },
} as ProductPrecheckReport;
test('relay skip retains both pass-style results despite failed/missing physical feedback', () => {
  for (const evidence of [report, null]) {
    const lights = detectorResultLights(1, 'batch-1', evidence, { ...defaults, relayFunctionalTest: true });
    assert.equal(lights.alarmRelay, 'SKIPPED');
    assert.equal(lights.faultRelay, 'SKIPPED');
  }
});
test('camera and relay verdicts remain available independently of reset/DIO', () => {
  assert.deepEqual(detectorResultLights(1, 'batch-1', report, defaults), {
    runningGreen: 'PASS', fireRed: 'FAIL', faultYellow: 'PENDING', alarmRelay: 'PASS', faultRelay: 'FAIL',
  });
});
test('new batch and missing slot cannot inherit previous inspection evidence', () => {
  for (const [slot, batch] of [[1, 'batch-2'], [2, 'batch-1'], [1, null]] as const) {
    assert.ok(Object.values(detectorResultLights(slot, batch, report, defaults)).every((value) => value === 'PENDING'));
  }
  const staleVision = { ...report, indicatorVision: { ...report.indicatorVision!, batchId: 'old' } };
  assert.equal(detectorResultLights(1, 'batch-1', staleVision, defaults).runningGreen, 'PENDING');
});
test('indicator skip is explicit; missing non-skipped camera evidence stays pending', () => {
  const lights = detectorResultLights(1, 'batch-1', null, { ...defaults, indicatorVision: true });
  assert.equal(lights.runningGreen, 'SKIPPED');
  assert.equal(lights.fireRed, 'SKIPPED');
  assert.equal(lights.faultYellow, 'PENDING');
  assert.equal(detectorResultLights(1, 'batch-1', null, defaults).fireRed, 'PENDING');
});
test('result wiring uses batch results and submits vision independently of relay progress', () => {
  const runtime = readFileSync(new URL('../../components/detector-status-lights-runtime.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../../components/detector-status-lights-live-runtime.ts', import.meta.url), 'utf8');
  const camera = readFileSync(new URL('../../components/indicator-camera.tsx', import.meta.url), 'utf8');
  assert.match(runtime, /unit.resultLights/);
  assert.match(runtime, /is-result-pass/);
  assert.match(runtime, /已跳过检测/);
  assert.doesNotMatch(entry, /window.fetch\s*=/);
  const submit = camera.slice(camera.indexOf('const submitCompletedEvidence'), camera.indexOf('const updateLayoutGeometry'));
  assert.match(submit, /!precheckComplete/);
  assert.doesNotMatch(submit, /!relayFunctionalTest|relayTest\?\.phase !==/);
  assert.match(camera, /setInterval\(\(\) => \{ void submitCompletedEvidence\(\); \}, 1000\)/);
});
