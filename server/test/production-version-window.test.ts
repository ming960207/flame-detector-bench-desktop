import assert from 'node:assert/strict';
import test from 'node:test';
import type { FieldStatusSnapshot } from '../src/closure/field-status-server.js';
import type { FlameConfig } from '../src/config.js';
import type { PLCProcessStatus } from '../src/process-status.js';
import { DEFAULT_PRODUCT_DETECTION_CONFIG } from '../src/product-profile.js';
import { ProductAwareFlameDetectorService } from '../src/product-aware-flame-detector-service.js';
import {
  EMC_SOFTWARE_VERSION_READ_OFFSET_MS,
  ProductionRunCoordinator,
} from '../src/production-run-coordinator.js';

function emcStatus(timestamp: number): PLCProcessStatus {
  return {
    stageCode: 4,
    stepCode: 3,
    autoRunning: true,
    complete: false,
    alarm: false,
    returningHome: false,
    timestamp,
    stage: 'EMC',
    label: '电磁干扰',
    processStage: 'EMC',
    processLabel: '电磁干扰',
    heatSubstage: 'IDLE',
    heatSubstageLabel: '非热源阶段',
    valid: true,
    io: {
      inputs: {},
      outputs: {},
      internal: {},
      steps: { stepM11_2: true },
      syncedAt: timestamp,
    },
  };
}

test('formal product service keeps waveform streaming armed from construction through batch completion', async () => {
  const flameConfig: FlameConfig = {
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    units: [],
  };
  const service = new ProductAwareFlameDetectorService(flameConfig);
  assert.equal(service.isWaveformStreamingArmed(), true);
  await service.stopWaveformStreaming();
  assert.equal(service.isWaveformStreamingArmed(), true);
});

test('software version read starts at EMC +8s and runs only once inside the final two-second window', () => {
  let versionReads = 0;
  let reservations = 0;
  const fakeDetectors = {
    reserveFormalBatch: async () => {
      reservations += 1;
      return {};
    },
    noteFormalBatchStartedAt: () => undefined,
    finalizeProductPrecheckVersions: async () => {
      versionReads += 1;
      return { verdict: 'PASS', units: [] };
    },
    getBatchContext: () => null,
  } as unknown as ProductAwareFlameDetectorService;

  const snapshot = (): FieldStatusSnapshot => ({
    summary: {
      waveformAnalysis: {
        batchId: 'batch-emc-1',
        phase: 'INTERFERENCE',
      },
      productConfig: DEFAULT_PRODUCT_DETECTION_CONFIG,
    },
    flame: {
      units: [],
      onlineCount: 0,
      fireCount: 0,
      faultCount: 0,
      timestamp: 0,
    },
  } as unknown as FieldStatusSnapshot);

  const coordinator = new ProductionRunCoordinator(snapshot, fakeDetectors);
  const startedAt = 10_000;

  coordinator.observeStatus(emcStatus(startedAt));
  assert.equal(reservations, 1);
  assert.equal(versionReads, 0);

  coordinator.observeStatus(emcStatus(startedAt + EMC_SOFTWARE_VERSION_READ_OFFSET_MS - 1));
  assert.equal(versionReads, 0);

  coordinator.observeStatus(emcStatus(startedAt + EMC_SOFTWARE_VERSION_READ_OFFSET_MS));
  assert.equal(versionReads, 1);

  coordinator.observeStatus(emcStatus(startedAt + EMC_SOFTWARE_VERSION_READ_OFFSET_MS + 1_000));
  assert.equal(versionReads, 1);
});
