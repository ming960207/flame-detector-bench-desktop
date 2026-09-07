import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlameConfig } from '../src/config.js';
import type { FlameDetectorDevice } from '../src/modbus/flame-detector-device.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
} from '../src/product-profile.js';
import type { ProductCodeStore } from '../src/product-code-store.js';
import { ProductAwareFlameDetectorService } from '../src/product-aware-flame-detector-service.js';

test('complete product precheck reads software version at position one and returns a final verdict', async () => {
  const flameConfig: FlameConfig = {
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31001 }],
  };
  const productConfig = normalizeProductDetectionConfig({
    selectedType: 'DUAL_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: {
        expectedSoftwareVersion: '01.02.03.04',
        expectedProbeCount: 2,
        relayFunctionalTestEnabled: false,
      },
    },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);

  const codeStore = {
    allocateBatch: async (_model: string, _rule: unknown, productionDate: Date, _count: number, batchId: string | null) => ({
      batchId,
      status: 'DISABLED' as const,
      productModel: 'GHT-1050-02',
      monthKey: null,
      productionDate: productionDate.getTime(),
      items: [],
      reason: 'TEST_DISABLED',
    }),
  } as unknown as ProductCodeStore;

  const calls: string[] = [];
  const fakeDevice = {
    readSoftwareVersion: async () => {
      calls.push('software-version');
      return '01020304';
    },
    readProbeCount: async () => {
      calls.push('probe-count');
      return 2;
    },
    readSensitivity: async () => {
      calls.push('sensitivity');
      return 1;
    },
    readAlarmStatus: async () => {
      calls.push('alarm-status');
      return { fireAlarm: false, fault: false, rawFire: 0, rawFault: 0 };
    },
  } as unknown as FlameDetectorDevice;

  const service = new ProductAwareFlameDetectorService(flameConfig, codeStore);
  const internal = service as unknown as { devices: Map<number, FlameDetectorDevice> };
  internal.devices.set(1, fakeDevice);

  const report = await service.runProductPrecheck(productConfig, 'batch-stabilization-1');

  assert.equal(calls[0], 'software-version');
  assert.deepEqual(calls, ['software-version', 'probe-count', 'sensitivity', 'alarm-status']);
  assert.equal(report.verdict, 'PASS');
  assert.ok(report.completedAt >= report.startedAt);
  assert.equal(report.units[0]?.actualSoftwareVersion, '01.02.03.04');
  assert.equal(report.units[0]?.verdict, 'PASS');
  assert.deepEqual(report.units[0]?.reasons, []);
});

test('software version mismatch is finalized during position-one precheck instead of remaining pending', async () => {
  const flameConfig: FlameConfig = {
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31001 }],
  };
  const productConfig = normalizeProductDetectionConfig({
    selectedType: 'DUAL_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: {
        expectedSoftwareVersion: '01.02.03.04',
        expectedProbeCount: 2,
        relayFunctionalTestEnabled: false,
      },
    },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const codeStore = {
    allocateBatch: async (_model: string, _rule: unknown, productionDate: Date, _count: number, batchId: string | null) => ({
      batchId,
      status: 'DISABLED' as const,
      productModel: 'GHT-1050-02',
      monthKey: null,
      productionDate: productionDate.getTime(),
      items: [],
      reason: 'TEST_DISABLED',
    }),
  } as unknown as ProductCodeStore;
  const service = new ProductAwareFlameDetectorService(flameConfig, codeStore);
  const internal = service as unknown as { devices: Map<number, FlameDetectorDevice> };
  internal.devices.set(1, {
    readSoftwareVersion: async () => '01020305',
    readProbeCount: async () => 2,
    readSensitivity: async () => 1,
    readAlarmStatus: async () => ({ fireAlarm: false, fault: false, rawFire: 0, rawFault: 0 }),
  } as unknown as FlameDetectorDevice);

  const report = await service.runProductPrecheck(productConfig, 'batch-stabilization-2');

  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.units[0]?.verdict, 'FAIL');
  assert.ok(report.units[0]?.reasons.includes('SOFTWARE_VERSION_MISMATCH'));
  assert.ok(!report.units[0]?.reasons.includes('SOFTWARE_VERSION_PENDING'));
});
