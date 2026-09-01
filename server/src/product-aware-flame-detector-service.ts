import type { FlameConfig } from './config.js';
import { FlameDetectorService } from './modbus/flame-detector-service.js';
import type { FlameDetectorDevice } from './modbus/flame-detector-device.js';
import {
  readLatchedAlarmFaultState,
  resetAlarmFaultSimulation,
  setAlarmFaultSimulation,
} from './modbus/flame-detector-relay-simulation.js';
import { ProductCodeStore, type ProductCodeAllocation } from './product-code-store.js';
import {
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from './product-profile.js';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort, type RelayFeedbackSource } from './relay-functional-test-coordinator.js';
import {
  DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  normalizeRelayFunctionalTestConfig,
  relayDioConfigReady,
  relayFunctionalTestMissingMappings,
  type RelayFunctionalTestConfig,
  type RelayFunctionalTestReport,
  type RelayFunctionalTestUnitResult,
} from './relay-functional-test.js';

const POSITION_ONE_CONTACT_SETTLE_MS = 800;

export interface ProductAwareBatchContext {
  batchId: string;
  productionDate: number;
  productCodeAllocation: ProductCodeAllocation | null;
  relayFunctionalTest: RelayFunctionalTestReport | null;
  sensitivityByDetector: Record<number, number | null>;
  updatedAt: number;
}

function pendingRelayUnit(index: number, reasons: string[]): RelayFunctionalTestUnitResult {
  const action = (prefix: string) => ({
    commandAccepted: false,
    internalStateReached: false,
    physicalStateReached: false,
    oppositeRelayStayedNormal: true,
    responseTimeMs: null,
    resetAccepted: false,
    internalRecovered: false,
    physicalRecovered: false,
    verdict: 'FAIL' as const,
    reasons: reasons.map((reason) => `${prefix}:${reason}`),
  });
  return {
    detectorIndex: index,
    enabled: true,
    baseline: {
      alarmInternal: null,
      faultInternal: null,
      alarmPhysical: null,
      faultPhysical: null,
    },
    alarm: action('ALARM'),
    fault: action('FAULT'),
    verdict: 'FAIL',
  };
}

function infrastructureFailureReport(
  batchId: string | null,
  mode: RelayFunctionalTestConfig['mode'],
  indexes: number[],
  reasons: string[],
): RelayFunctionalTestReport {
  const now = Date.now();
  return {
    batchId,
    mode,
    phase: 'COMPLETE',
    startedAt: now,
    completedAt: now,
    verdict: 'FAIL',
    units: indexes.map((index) => pendingRelayUnit(index, reasons)),
  };
}

function allocationError(
  productModel: string,
  productionDate: Date,
  batchId: string | null,
  error: unknown,
): ProductCodeAllocation {
  return {
    batchId,
    status: 'ERROR',
    productModel,
    monthKey: null,
    productionDate: productionDate.getTime(),
    items: Array.from({ length: 6 }, (_, offset) => ({ slot: offset + 1, serial: null, productCode: null })),
    reason: `PRODUCT_CODE_ALLOCATION_FAILED:${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * Formal detector service extension.
 *
 * The base service owns the single detector connection pool. This adapter reuses
 * those already-created FlameDetectorDevice instances after product precheck;
 * it never opens a second Modbus backend/connection.
 */
export class ProductAwareFlameDetectorService extends FlameDetectorService implements RelayDetectorPort {
  private productWaveformStarted = false;
  private holdWaveformStart = false;
  private relayConfig: RelayFunctionalTestConfig = DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG;
  private relayFeedback: RelayFeedbackSource = { readInputs: () => undefined };
  private pendingBatchStartedAt: number | null = null;
  private readonly batchContexts = new Map<string, ProductAwareBatchContext>();
  /** batchId -> atomic six-slot reservation. The Promise itself is cached so a near-immediate precheck cannot allocate twice. */
  private readonly productCodeReservations = new Map<string, Promise<ProductCodeAllocation>>();

  constructor(
    flameConfig: FlameConfig,
    private readonly productCodeStore = new ProductCodeStore(),
  ) {
    super(flameConfig, { deferWaveformUntilInspection: true });
  }

  setRelayFunctionalTestConfig(config: RelayFunctionalTestConfig): void {
    this.relayConfig = normalizeRelayFunctionalTestConfig(config, this.relayConfig);
  }

  getRelayFunctionalTestConfig(): RelayFunctionalTestConfig {
    return JSON.parse(JSON.stringify(this.relayConfig)) as RelayFunctionalTestConfig;
  }

  setRelayFeedbackSource(source: RelayFeedbackSource): void {
    this.relayFeedback = source;
  }

  noteFormalBatchStartedAt(timestamp: number): void {
    if (Number.isFinite(timestamp) && timestamp > 0) this.pendingBatchStartedAt = timestamp;
  }

  /**
   * Called on the PLC formal-run rising edge, after FieldWaveformAnalysis has created the real batchId.
   * The six serials are therefore consumed at formal batch start, not later when position-1 precheck begins.
   * Any numbering/storage problem is converted into status=ERROR and never blocks the physical inspection.
   */
  reserveFormalBatch(
    productConfig: ProductDetectionConfig,
    batchId: string,
    startedAt: number,
  ): Promise<ProductCodeAllocation> {
    const normalizedBatchId = batchId.trim();
    const existing = this.productCodeReservations.get(normalizedBatchId);
    if (existing) return existing;

    const profile = selectedProductProfile(productConfig);
    const productionDate = new Date(startedAt);
    this.noteFormalBatchStartedAt(startedAt);
    const reservation = this.productCodeStore.allocateBatch(
      profile.productModel,
      profile.productCodeRule,
      productionDate,
      6,
      normalizedBatchId,
    ).catch((error) => allocationError(profile.productModel, productionDate, normalizedBatchId, error));
    this.productCodeReservations.set(normalizedBatchId, reservation);
    return reservation;
  }

  getBatchContext(batchId: string | null | undefined): ProductAwareBatchContext | null {
    if (!batchId) return null;
    const context = this.batchContexts.get(batchId);
    return context ? JSON.parse(JSON.stringify(context)) as ProductAwareBatchContext : null;
  }

  override async stopWaveformStreaming(): Promise<void> {
    if (!this.productWaveformStarted && !this.isDataStreamConnected()) return;
    await super.stopWaveformStreaming();
    this.productWaveformStarted = false;
  }

  override async startWaveformStreaming(): Promise<void> {
    if (this.holdWaveformStart) return;
    await super.startWaveformStreaming();
    this.productWaveformStarted = true;
  }

  enabledDetectorIndexes(): number[] {
    return this.getConfig().units
      .filter((unit) => unit.enabled)
      .map((unit) => unit.index)
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= 6)
      .sort((a, b) => a - b);
  }

  private detectorDevice(detectorIndex: number): FlameDetectorDevice {
    // TypeScript private on FlameDetectorService is compile-time private, while
    // the runtime Map is intentionally reused here to avoid a duplicate transport.
    const internal = this as unknown as { devices: Map<number, FlameDetectorDevice> };
    const device = internal.devices.get(detectorIndex);
    if (!device) throw new Error(`DETECTOR_DEVICE_NOT_READY:D${detectorIndex}`);
    return device;
  }

  async simulate(detectorIndex: number, state: { fire: boolean; fault: boolean }): Promise<void> {
    await setAlarmFaultSimulation(this.detectorDevice(detectorIndex), state.fire, state.fault);
  }

  async reset(detectorIndex: number): Promise<void> {
    await resetAlarmFaultSimulation(this.detectorDevice(detectorIndex));
  }

  async readLatched(detectorIndex: number): Promise<{ fire: boolean; fault: boolean }> {
    const state = await readLatchedAlarmFaultState(this.detectorDevice(detectorIndex));
    return { fire: state.fire, fault: state.fault };
  }

  private stopBackgroundPolling(): boolean {
    const internal = this as unknown as { pollTimer: NodeJS.Timeout | null; stopPolling(): void };
    const wasPolling = internal.pollTimer !== null;
    internal.stopPolling();
    return wasPolling;
  }

  private resumeBackgroundPolling(wasPolling: boolean): void {
    if (!wasPolling || !this.isTransportConnected()) return;
    const internal = this as unknown as { startPolling(): void };
    internal.startPolling();
  }

  private async readSensitivityLevels(indexes: number[]): Promise<Record<number, number | null>> {
    const result: Record<number, number | null> = {};
    // Sequential by design: remains safe if a future product uses a shared half-duplex RTU bus.
    for (const index of indexes) {
      try {
        result[index] = await this.detectorDevice(index).readSensitivity();
      } catch {
        result[index] = null;
      }
    }
    return result;
  }

  private async ensureProductCodeAllocation(
    productConfig: ProductDetectionConfig,
    batchId: string | null,
    fallbackProductionDate: Date,
  ): Promise<ProductCodeAllocation> {
    const profile = selectedProductProfile(productConfig);
    if (batchId) {
      const existing = this.productCodeReservations.get(batchId);
      if (existing) return existing;
      return this.reserveFormalBatch(productConfig, batchId, fallbackProductionDate.getTime());
    }
    try {
      return await this.productCodeStore.allocateBatch(
        profile.productModel,
        profile.productCodeRule,
        fallbackProductionDate,
        6,
        null,
      );
    } catch (error) {
      return allocationError(profile.productModel, fallbackProductionDate, null, error);
    }
  }

  private async runRelayFunctionalTest(
    productConfig: ProductDetectionConfig,
    batchId: string | null,
  ): Promise<RelayFunctionalTestReport | null> {
    const profile = selectedProductProfile(productConfig);
    if (!profile.relayFunctionalTestEnabled) return null;

    const indexes = this.enabledDetectorIndexes();
    const missingMappings = relayFunctionalTestMissingMappings(this.relayConfig, indexes);
    const infraReasons: string[] = [];
    if (!this.relayConfig.enabled) infraReasons.push('RELAY_TEST_GLOBAL_DISABLED');
    if (!relayDioConfigReady(this.relayConfig.dio)) infraReasons.push('DIO_NOT_CONFIGURED');
    if (missingMappings.length > 0) infraReasons.push(`RELAY_FEEDBACK_MAPPING_MISSING:${missingMappings.join(',')}`);
    if (infraReasons.length > 0) {
      return infrastructureFailureReport(batchId, this.relayConfig.mode, indexes, infraReasons);
    }

    const coordinator = new RelayFunctionalTestCoordinator(this, this.relayFeedback, this.relayConfig);
    return coordinator.run(batchId);
  }

  override async runProductPrecheck(
    productConfig: ProductDetectionConfig,
    batchId: string | null = null,
  ): Promise<ProductPrecheckReport> {
    await new Promise((resolve) => setTimeout(resolve, POSITION_ONE_CONTACT_SETTLE_MS));

    const fallbackProductionDate = new Date(this.pendingBatchStartedAt ?? Date.now());
    const profile = selectedProductProfile(productConfig);
    const allocation = await this.ensureProductCodeAllocation(productConfig, batchId, fallbackProductionDate);
    const productionDate = new Date(allocation.productionDate || fallbackProductionDate.getTime());
    const contextKey = batchId ?? `precheck-${productionDate.getTime()}`;

    // Base runProductPrecheck normally starts waveform immediately at the end.
    // Hold that polymorphic call so relay commands are guaranteed to run first.
    this.holdWaveformStart = true;
    let report: ProductPrecheckReport | null = null;
    let wasPolling = false;
    try {
      report = await super.runProductPrecheck(productConfig, batchId);
      wasPolling = this.stopBackgroundPolling();

      const indexes = this.enabledDetectorIndexes();
      const sensitivityByDetector = await this.readSensitivityLevels(indexes);
      for (const unit of report.units) {
        unit.sensitivityLevel = sensitivityByDetector[unit.index] ?? null;
        if (unit.sensitivityLevel === null) {
          if (!unit.reasons.includes('SENSITIVITY_READ_FAILED')) unit.reasons.push('SENSITIVITY_READ_FAILED');
          unit.verdict = 'FAIL';
        }
      }

      const relayFunctionalTest = await this.runRelayFunctionalTest(productConfig, batchId);
      if (relayFunctionalTest?.verdict === 'FAIL') {
        for (const unit of report.units) {
          const relayUnit = relayFunctionalTest.units.find((item) => item.detectorIndex === unit.index);
          if (!relayUnit || relayUnit.verdict === 'PASS') continue;
          if (!unit.reasons.includes('RELAY_FUNCTIONAL_TEST_FAILED')) unit.reasons.push('RELAY_FUNCTIONAL_TEST_FAILED');
          for (const reason of [...relayUnit.alarm.reasons, ...relayUnit.fault.reasons]) {
            const code = `RELAY:${reason}`;
            if (!unit.reasons.includes(code)) unit.reasons.push(code);
          }
          unit.verdict = 'FAIL';
        }
      }

      report = {
        ...report,
        productModel: profile.productModel,
        productionDate: productionDate.getTime(),
        productCodeAllocation: allocation,
        relayFunctionalTest,
        completedAt: Date.now(),
        verdict: report.units.length > 0 && report.units.every((unit) => unit.verdict === 'PASS') ? 'PASS' : 'FAIL',
      };

      this.batchContexts.set(contextKey, {
        batchId: contextKey,
        productionDate: productionDate.getTime(),
        productCodeAllocation: allocation,
        relayFunctionalTest,
        sensitivityByDetector,
        updatedAt: Date.now(),
      });
      if (batchId) this.batchContexts.set(batchId, this.batchContexts.get(contextKey)!);
      this.pendingBatchStartedAt = null;
      return report;
    } finally {
      this.holdWaveformStart = false;
      // Even when precheck/relay fails, continue waveform testing so the batch keeps evidence.
      try {
        if (this.isTransportConnected()) await this.startWaveformStreaming();
      } finally {
        this.resumeBackgroundPolling(wasPolling);
      }
    }
  }
}
