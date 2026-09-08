import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  generateProductCode,
  normalizeProductCodeRule,
  productMonthlySerialKey,
  productionPeriodCode,
} from '../src/product-code.js';
import { ProductCodeStore } from '../src/product-code-store.js';
import {
  readAlarmFaultSimulation,
  readLatchedAlarmFaultState,
  resetAlarmFaultSimulation,
  setAlarmFaultSimulation,
} from '../src/modbus/flame-detector-relay-simulation.js';
import type { FlameDetectorDevice } from '../src/modbus/flame-detector-device.js';

test('production period follows verified year/month coding rules', () => {
  assert.equal(productionPeriodCode(new Date(2026, 7, 31, 8, 0, 0)), '058');
  assert.equal(productionPeriodCode(new Date(2026, 9, 1, 8, 0, 0)), '05A');
  assert.equal(productionPeriodCode(new Date(2026, 10, 1, 8, 0, 0)), '05B');
  assert.equal(productionPeriodCode(new Date(2026, 11, 1, 8, 0, 0)), '05C');
});

test('product code uses 18 digits/characters and independent monthly key', () => {
  const rule = normalizeProductCodeRule({ productNameCode: '4102' });
  const date = new Date(2026, 7, 31, 8, 0, 0);
  const result = generateProductCode(rule, date, 1);
  assert.equal(result.status, 'GENERATED');
  assert.equal(result.code, '410205801010100001');
  assert.equal(result.code?.length, 18);
  assert.equal(productMonthlySerialKey('GHT-1050-02', date), 'GHT-1050-02@202608');
});

test('missing product name code does not block flow and does not invent a code', () => {
  const rule = normalizeProductCodeRule({ productNameCode: '' });
  const result = generateProductCode(rule, new Date(2026, 7, 31), 1);
  assert.equal(result.status, 'RULE_MISSING');
  assert.equal(result.code, null);
});

test('monthly serial store allocates atomically by product model and resets by month key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flame-code-'));
  const file = join(dir, 'state.json');
  const store = new ProductCodeStore(file);
  const rule = normalizeProductCodeRule({ productNameCode: '4102' });

  const august1 = await store.allocateBatch('GHT-1050-02', rule, new Date(2026, 7, 31, 8), 6);
  const august2 = await store.allocateBatch('GHT-1050-02', rule, new Date(2026, 7, 31, 9), 2);
  const otherModel = await store.allocateBatch('GHT-1050-03', normalizeProductCodeRule({ productNameCode: '4103' }), new Date(2026, 7, 31, 9), 1);
  const september = await store.allocateBatch('GHT-1050-02', rule, new Date(2026, 8, 1, 8), 1);

  assert.deepEqual(august1.items.map((item) => item.serial), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(august2.items.map((item) => item.serial), [7, 8]);
  assert.equal(otherModel.items[0]?.serial, 1);
  assert.equal(september.items[0]?.serial, 1);

  const persisted = JSON.parse(await readFile(file, 'utf8')) as { counters: Record<string, number> };
  assert.equal(persisted.counters['GHT-1050-02@202608'], 8);
  assert.equal(persisted.counters['GHT-1050-03@202608'], 1);
  assert.equal(persisted.counters['GHT-1050-02@202609'], 1);
});

test('formal batch allocation reserves six serials once and never reuses them after an abandoned batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flame-code-batch-'));
  const store = new ProductCodeStore(join(dir, 'state.json'));
  const rule = normalizeProductCodeRule({ productNameCode: '4102' });
  const date = new Date(2026, 7, 31, 14, 0, 0);

  const first = await store.allocateBatch('GHT-1050-02', rule, date, 6, 'formal-batch-1');
  const duplicateEvent = await store.allocateBatch('GHT-1050-02', rule, date, 6, 'formal-batch-1');
  const nextBatch = await store.allocateBatch('GHT-1050-02', rule, date, 6, 'formal-batch-2');

  assert.deepEqual(first.items.map((item) => item.serial), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(duplicateEvent.items, first.items);
  assert.deepEqual(nextBatch.items.map((item) => item.serial), [7, 8, 9, 10, 11, 12]);
});

test('relay simulation always writes A000/A001 as one FC10 two-register operation', async () => {
  const writes: Array<{ address: number; values: number[] }> = [];
  const fake = {
    async writeRegisters(address: number, values: number[]) { writes.push({ address, values }); },
    async readRegisters(address: number, quantity: number) {
      if (address === 0xA000 && quantity === 2) return [0x0000, 0x0001];
      if (address === 0xB000 && quantity === 2) return [0x0001, 0x0001];
      return [];
    },
    async systemReset() { writes.push({ address: 0xF000, values: [0x1234] }); },
  } as unknown as FlameDetectorDevice;

  await setAlarmFaultSimulation(fake, true, false);
  await setAlarmFaultSimulation(fake, false, true);
  // The combined state remains available only as a protocol/register diagnostic helper.
  // Real hardware testing proved that its physical Fault relay does not actuate with Alarm.
  await setAlarmFaultSimulation(fake, true, true);
  assert.deepEqual(writes.slice(0, 3), [
    { address: 0xA000, values: [0x0000, 0x0000] },
    { address: 0xA000, values: [0xFFFF, 0x0001] },
    { address: 0xA000, values: [0x0000, 0x0001] },
  ]);

  assert.deepEqual(await readAlarmFaultSimulation(fake), {
    fire: true,
    fault: true,
    rawFire: 0,
    rawFault: 1,
  });
  assert.deepEqual(await readLatchedAlarmFaultState(fake), {
    fire: true,
    fault: true,
    rawFire: 1,
    rawFault: 1,
  });
  await resetAlarmFaultSimulation(fake);
  assert.deepEqual(writes.at(-1), { address: 0xF000, values: [0x1234] });
});
