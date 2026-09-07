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
  formatSoftwareVersion,
  selectedProductProfile,
  softwareVersionMatches,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
  type ProductPrecheckUnitResult,
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

interface PositionOneIdentity {
  softwareVersion: string | null;
  probeCount: number | null;
  sensitivity: number | null;
  fireAlarm: boolean | null;
  fault: boolean | null;
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

function uniquePush(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

export class ProductAwareFlameDetectorService extends FlameDetectorService implements RelayDetectorPort {
  private relayConfig: RelayFunctionalTestConfig = DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG;
  private relayFeedback: RelayFeedbackSource = { readInputs: () => undefined };
  private pendingBatchStartedAt: number | null = null;
  private readonly batchContexts = new Map<string, ProductAwareBatchContext>();
  private readonly productCodeReservations = new Map<string, Promise<ProductCodeAllocation>>();

  constructor(
    flameConfig: FlameConfig,
    private readonly productCodeStore = new ProductCodeStore(),
  ) {
    // Formal production must behave like the legacy field runtime: once each TCP
    // transport connects it immediately enters continuous waveform push mode.
    super(flameConfig);
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

  /**
   * FieldStatusRuntime calls this when one batch reaches COMPLETE. Formal production
   * intentionally ignores that request so the six detector sockets keep streaming
   * across stages and into the next batch; disconnect() still closes transports.
   */
  override async stopWaveformStreaming(): Promise<void> {
    return;
  }

  enabledDetectorIndexes(): number[] {
    return this.getConfig().units
      .filter((unit) => unit.enabled)
      .map((unit) => unit.index)
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= 6)
      .sort((a, b) => a - b);
  }

  private detectorDevice(detectorIndex: number): FlameDetectorDevice {
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

  /**
   * Read the complete product identity while the station is intentionally waiting
   * for waveform stabilization. The six TCP detector links are independent, so the
   * six units run in parallel; each individual detector still performs its Modbus
   * requests sequentially through RawTcpModbusClient's request queue.
   *
   * Software-version read is intentionally first. Field testing confirmed that the
   * complete version command works while continuous waveform push is enabled, but
   * the visible waveform can pause for about three seconds. Doing it first leaves
   * the remaining identity/relay checks and the stabilization wait to absorb that
   * display gap before quantitative noise capture begins.
   */
  private async readPositionOneIdentity(indexes: number[]): Promise<Record<number, PositionOneIdentity>> {
    const entries = await Promise.all(indexes.map(async (index) => {
      const result: PositionOneIdentity = {
        softwareVersion: null,
        probeCount: null,
        sensitivity: null,
        fireAlarm: null,
        fault: null,
      };
      try {
        const device = this.detectorDevice(index);
        try { result.softwareVersion = await device.readSoftwareVersion(); } catch { /* explicit reason below */ }
        try { result.probeCount = await device.readProbeCount(); } catch { /* explicit reason below */ }
        try { result.sensitivity = await device.readSensitivity(); } catch { /* explicit reason below */ }
        try {
          const alarm = await device.readAlarmStatus();
          result.fireAlarm = alarm.fireAlarm;
          result.fault = alarm.fault;
        } catch { /* relay functional test still provides independent evidence */ }
      } catch {
        // Device was not ready; individual null fields become explicit precheck reasons.
      }
      return [index, result] as const;
    }));
    return Object.fromEntries(entries) as Record<number, PositionOneIdentity>;
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

  /**
   * Complete product precheck at detection position 1 during the signal-stabilizing
   * wait. Continuous waveform push remains armed throughout. No product-precheck
   * command is deferred to flash/EMC stages.
   */
  override async runProductPrecheck(
    productConfig: ProductDetectionConfig,
    batchId: string | null = null,
  ): Promise<ProductPrecheckReport> {
    await new Promise((resolve) => setTimeout(resolve, POSITION_ONE_CONTACT_SETTLE_MS));

    const startedAt = Date.now();
    const fallbackProductionDate = new Date(this.pendingBatchStartedAt ?? startedAt);
    const profile = selectedProductProfile(productConfig);
    const allocation = await this.ensureProductCodeAllocation(productConfig, batchId, fallbackProductionDate);
    const productionDate = new Date(allocation.productionDate || fallbackProductionDate.getTime());
    const contextKey = batchId ?? `precheck-${productionDate.getTime()}`;
    const indexes = this.enabledDetectorIndexes();

    // All product identity reads run first; relay simulation then reuses the same
    // already-open detector clients. Neither path stops, clears or re-arms waveform.
    const identityByDetector = await this.readPositionOneIdentity(indexes);
    const relayFunctionalTest = await this.runRelayFunctionalTest(productConfig, batchId);
    const currentByIndex = new Map(this.getCurrentState().units.map((unit) => [unit.index, unit]));
    const sensitivityByDetector: Record<number, number | null> = {};

    const units: ProductPrecheckUnitResult[] = indexes.map((index) => {
      const identity = identityByDetector[index] ?? {
        softwareVersion: null,
        probeCount: null,
        sensitivity: null,
        fireAlarm: null,
        fault: null,
      };
      sensitivityByDetector[index] = identity.sensitivity;
      const live = currentByIndex.get(index);
      const reasons: string[] = [];

      if (identity.softwareVersion === null) {
        uniquePush(reasons, 'SOFTWARE_VERSION_READ_FAILED');
      } else if (!profile.expectedSoftwareVersion.trim()) {
        uniquePush(reasons, 'SOFTWARE_VERSION_NOT_CONFIGURED');
      } else if (!softwareVersionMatches(profile.expectedSoftwareVersion, identity.softwareVersion)) {
        uniquePush(reasons, 'SOFTWARE_VERSION_MISMATCH');
      }

      if (identity.probeCount === null) uniquePush(reasons, 'PROBE_COUNT_READ_FAILED');
      else if (identity.probeCount !== profile.expectedProbeCount) uniquePush(reasons, 'PROBE_COUNT_MISMATCH');
      if (identity.sensitivity === null) uniquePush(reasons, 'SENSITIVITY_READ_FAILED');
      if (identity.fault === true || live?.fault === true) uniquePush(reasons, 'DETECTOR_FAULT_AT_PRECHECK');

      const relayUnit = relayFunctionalTest?.units.find((item) => item.detectorIndex === index);
      if (relayUnit && relayUnit.verdict !== 'PASS') {
        uniquePush(reasons, 'RELAY_FUNCTIONAL_TEST_FAILED');
        for (const reason of [...relayUnit.alarm.reasons, ...relayUnit.fault.reasons]) {
          uniquePush(reasons, `RELAY:${reason}`);
        }
      }

      return {
        index,
        address: live?.address ?? index,
        productType: productConfig.selectedType,
        expectedSoftwareVersion: profile.expectedSoftwareVersion,
        actualSoftwareVersion: identity.softwareVersion === null ? null : formatSoftwareVersion(identity.softwareVersion),
        expectedProbeCount: profile.expectedProbeCount,
        actualProbeCount: identity.probeCount,
        fireAlarm: identity.fireAlarm ?? live?.fire ?? null,
        fault: identity.fault ?? live?.fault ?? null,
        sensitivityLevel: identity.sensitivity,
        checkedAt: Date.now(),
        verdict: reasons.length === 0 ? 'PASS' : 'FAIL',
        reasons,
      };
    });

    const completedAt = Date.now();
    const report: ProductPrecheckReport = {
      batchId,
      productType: productConfig.selectedType,
      productLabel: profile.label,
      productModel: profile.productModel,
      expectedSoftwareVersion: profile.expectedSoftwareVersion,
      expectedProbeCount: profile.expectedProbeCount,
      productionDate: productionDate.getTime(),
      productCodeAllocation: allocation,
      relayFunctionalTest,
      startedAt,
      completedAt,
      verdict: units.length > 0 && units.every((unit) => unit.verdict === 'PASS') ? 'PASS' : 'FAIL',
      units,
    };

    this.batchContexts.set(contextKey, {
      batchId: contextKey,
      productionDate: productionDate.getTime(),
      productCodeAllocation: allocation,
      relayFunctionalTest,
      sensitivityByDetector,
      updatedAt: completedAt,
    });
    if (batchId) this.batchContexts.set(batchId, this.batchContexts.get(contextKey)!);
    this.pendingBatchStartedAt = null;
    return report;
  }
}
