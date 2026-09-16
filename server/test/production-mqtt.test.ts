import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionInspectionPayload } from '../src/mqtt-publisher.js';
import type { ProductionRunArchive } from '../src/production-run-coordinator.js';

function passItem(reason = 'TEST'): { status: '合格'; source: 'AUTO'; reason: string } {
  return { status: '合格', source: 'AUTO', reason };
}

test('formal production MQTT payload keeps product identity and inspection evidence', () => {
  const archive = {
    schemaVersion: 1,
    batchId: 'field-waveform-20260831-1',
    archivedAt: 1_788_160_000_500,
    productionDate: 1_788_160_000_000,
    summary: {
      process: { valid: true },
      finalVerdict: { verdict: 'PASS', grade: 'A_PASS' },
      productPrecheck: {
        verdict: 'PASS',
        productCodeAllocation: { status: 'GENERATED' },
        relayFunctionalTest: { verdict: 'PASS' },
      },
    },
    flame: { units: [] },
    productContext: null,
    inspectionRecord: {
      schemaVersion: 1,
      batchId: 'field-waveform-20260831-1',
      productModel: 'GHT-1050-03',
      productionDate: 1_788_160_000_000,
      inspector: 'Inspector A',
      standard: 'GB15631－2008',
      formNumber: 'WUTOS/IMS-JL836',
      formVersion: 'A/0',
      quantity: 1,
      conclusion: '合格',
      generatedAt: 1_788_160_000_500,
      products: [{
        slot: 1,
        productCode: '410305901010100001',
        productCodeStatus: 'GENERATED',
        verdict: '合格',
        workCurrent: passItem('DEFAULT'),
        fireAction: passItem('RELAY'),
        faultAction: passItem('RELAY'),
        ledDisplay: passItem('DEFAULT'),
        amplitude: { values: [150, 180, 165], status: '合格', source: 'AUTO' },
        softwareVersion: { value: '90.26.08.11', ...passItem('VERSION') },
        productInfo: { value: { probeCount: 3, sensitivityLevel: 2 }, ...passItem('INFO') },
        interferenceResistance: passItem('WAVEFORM'),
        powerFluctuation: passItem('DEFAULT'),
        highTemp: passItem('DEFAULT'),
        lowTemp: passItem('DEFAULT'),
      }],
    },
  } as unknown as ProductionRunArchive;

  const result = buildProductionInspectionPayload(archive, 'bench-01', archive.archivedAt);
  assert.equal(result.header.data_type, 'PRODUCTION_INSPECTION_RECORD');
  assert.equal(result.header.device_id, 'bench-01');
  assert.equal(result.payload.source, 'FORMAL_PRODUCTION');
  assert.equal(result.payload.batch_id, archive.batchId);
  assert.equal(result.payload.product_model, 'GHT-1050-03');
  assert.equal(result.payload.verdict, 'PASS');
  assert.equal(result.payload.product_precheck_verdict, 'PASS');
  assert.equal(result.payload.relay_functional_test_verdict, 'PASS');
  assert.equal(result.payload.detector_results[0]?.product_code, '410305901010100001');
  assert.deepEqual(result.payload.detector_results[0]?.amplitude_values, [150, 180, 165]);
  assert.equal(result.payload.detector_results[0]?.inspection_items.fire_action.status, '合格');
});
