import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LabelPrintQueueStore } from '../src/label-print-queue.js';
import type { ProductionInspectionRecord, ProductionInspectionProductResult } from '../src/production-inspection-record.js';

function product(slot: number, code: string | null, verdict: '合格' | '不合格', noiseValues = [150, 180]): ProductionInspectionProductResult {
  const pass = { status: '合格' as const, source: 'AUTO' as const };
  const defaultPass = { status: '合格' as const, source: 'DEFAULT_PASS' as const, reason: 'TEST' };
  return {
    slot,
    productCode: code,
    productCodeStatus: code ? 'GENERATED' : 'RULE_MISSING',
    workCurrent: defaultPass,
    fireAction: pass,
    faultAction: pass,
    ledDisplay: defaultPass,
    amplitude: { values: noiseValues, status: '合格', source: 'AUTO' },
    softwareVersion: { value: '90.26.08.11', status: '合格', source: 'AUTO' },
    productInfo: { value: { probeCount: 2, sensitivityLevel: 2 }, status: '合格', source: 'AUTO' },
    interferenceResistance: pass,
    powerFluctuation: defaultPass,
    highTemp: defaultPass,
    lowTemp: defaultPass,
    verdict,
  };
}

function record(products: ProductionInspectionProductResult[], batchId = 'batch-label-1'): ProductionInspectionRecord {
  return {
    schemaVersion: 1,
    batchId,
    productModel: 'GHT-1050-02',
    productionDate: new Date(2026, 8, 1, 13, 0, 0).getTime(),
    inspector: '测试员',
    standard: 'GB15631－2008',
    formNumber: 'WUTOS/IMS-JL836',
    formVersion: 'A/0',
    quantity: 6,
    products,
    conclusion: products.some((item) => item.verdict === '不合格') ? '不合格' : '合格',
    generatedAt: Date.now(),
  };
}

function detectorVerdict() {
  return {
    verdict: 'FAIL',
    grade: 'FAIL',
    timestamp: Date.now(),
    units: [
      { index: 1, grade: 'A_PASS', verdict: 'PASS' },
      { index: 2, grade: 'B_PASS', verdict: 'PASS' },
      { index: 3, grade: 'A_PASS', verdict: 'PASS' },
      { index: 4, grade: 'FAIL', verdict: 'FAIL' },
      { index: 5, grade: 'A_PASS', verdict: 'PASS' },
      { index: 6, grade: 'A_PASS', verdict: 'PASS' },
    ],
  } as any;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'flame-label-queue-'));
  const file = join(directory, 'queue.json');
  return { file, store: new LabelPrintQueueStore(file) };
}

test('completed batch creates D1-D6 jobs in slot order with A/B/NG and keeps NG product identity', async () => {
  const { store } = await fixture();
  const products = Array.from({ length: 6 }, (_, offset) => {
    const slot = offset + 1;
    const code = `4102059010101${String(slot).padStart(5, '0')}`;
    return product(slot, code, slot === 4 ? '不合格' : '合格', [150 + slot, 180 + slot]);
  });
  const created = await store.enqueueProductionRecord(record(products), detectorVerdict());
  assert.deepEqual(created.map((job) => job.slot), [1, 2, 3, 4, 5, 6]);
  assert.equal(created[0]?.verdict, 'A类合格');
  assert.equal(created[1]?.verdict, 'B类合格');
  assert.equal(created[3]?.verdict, '不合格');
  assert.equal(created[3]?.isolation, true);
  assert.equal(created[3]?.productCode, products[3]?.productCode);
  assert.equal(created[3]?.qrContent, products[3]?.productCode);
  assert.deepEqual(created[0]?.noiseValues, [151, 181]);

  const duplicate = await store.enqueueProductionRecord(record(products), detectorVerdict());
  assert.equal(duplicate.length, 0, '同一批次归档不得重复生成标签任务');
});

test('missing product code becomes BLOCKED without consuming the printable queue', async () => {
  const { store } = await fixture();
  const products = Array.from({ length: 6 }, (_, offset) => product(offset + 1, offset === 1 ? null : `CODE-${offset + 1}`, '合格'));
  const created = await store.enqueueProductionRecord(record(products), detectorVerdict());
  assert.equal(created[1]?.status, 'BLOCKED');
  assert.equal(created[1]?.lastError, 'PRODUCT_CODE_NOT_GENERATED');

  const first = await store.claimNext('worker-a');
  assert.equal(first?.slot, 1);
  await store.markPrinted(first!.id, 'worker-a');
  const secondPrintable = await store.claimNext('worker-a');
  assert.equal(secondPrintable?.slot, 3, '编号缺失 D2 必须被跳过且不能阻塞后续槽位');
});

test('automatic claim can start from the time auto print was enabled', async () => {
  const { store } = await fixture();
  const products = Array.from({ length: 6 }, (_, offset) => product(offset + 1, `OLD-${offset + 1}`, '合格'));
  await store.enqueueProductionRecord(record(products), detectorVerdict());

  const enabledAt = Date.now() + 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const nextProducts = Array.from({ length: 6 }, (_, offset) => product(offset + 1, `NEW-${offset + 1}`, '合格'));
  await store.enqueueProductionRecord(record(nextProducts, 'batch-label-2'), detectorVerdict());

  const claimed = await store.claimNext('worker-a', undefined, enabledAt);
  assert.equal(claimed?.productCode, 'NEW-1', '开启自动打印前生成的标签不得被自动打印');
});

test('physical print failure pauses queue until explicit retry and printed label can be reprinted', async () => {
  const { file, store } = await fixture();
  const products = Array.from({ length: 6 }, (_, offset) => product(offset + 1, `CODE-${offset + 1}`, '合格'));
  await store.enqueueProductionRecord(record(products), detectorVerdict());

  const claimed = await store.claimNext('worker-a');
  assert.equal(claimed?.slot, 1);
  await store.markFailed(claimed!.id, 'worker-a', 'PAPER_OUT');
  let view = await store.list();
  assert.equal(view.jobs.find((job) => job.id === claimed!.id)?.status, 'FAILED');
  assert.equal(await store.claimNext('worker-a'), null, 'D1 失败未处理时必须暂停 D2-D6，避免标签顺序错位');

  await store.retry(claimed!.id);
  const retried = await store.claimNext('worker-a');
  assert.equal(retried?.slot, 1);
  await store.markPrinted(retried!.id, 'worker-a');
  const next = await store.claimNext('worker-a');
  assert.equal(next?.slot, 2, 'D1 恢复后必须继续 D2');
  await store.markPrinted(next!.id, 'worker-a');

  await store.retry(retried!.id);
  view = await store.list();
  const reprint = view.jobs.find((job) => job.id === retried!.id);
  assert.equal(reprint?.status, 'WAITING');
  assert.equal(reprint?.reprintCount, 1);

  const persisted = JSON.parse(await readFile(file, 'utf8')) as { jobs: Array<{ id: string }> };
  assert.ok(persisted.jobs.some((job) => job.id === retried!.id), '标签队列必须持久化到磁盘');
});
