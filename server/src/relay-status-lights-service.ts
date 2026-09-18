import type { ProductAwareFieldStatusRuntime } from './product-aware-field-runtime.js';
import {
  DioModbusTcpInputSource,
  RelayFeedbackDioError,
  getPrimaryRelayFeedbackInputSource,
} from './relay-feedback-dio.js';
import {
  DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  normalizeRelayFunctionalTestConfig,
  relayDioConfigReady,
  relayFeedbackMappingFor,
  relayFunctionalTestMissingMappings,
  relayInputIsActive,
  type RelayFunctionalTestConfig,
} from './relay-functional-test.js';
import { loadSystemConfig } from './system-config-store.js';

export interface RelayStatusLightDetectorState {
  index: number;
  online?: boolean;
  fire?: boolean;
  fault?: boolean;
}

export interface RelayStatusLightUnit {
  index: number;
  online: boolean;
  fire: boolean;
  fault: boolean;
  alarmRelay: boolean;
  faultRelay: boolean;
  relayObserved: boolean;
}

export interface RelayStatusLightsRuntime {
  close(): Promise<void>;
}

const CONFIG_REFRESH_INTERVAL_MS = 1_000;
const ERROR_LOG_INTERVAL_MS = 5_000;
const DETECTOR_INDEXES = [1, 2, 3, 4, 5, 6] as const;

/**
 * Convert the physical DIO levels to detector relay action states.
 *
 * A missing DIO sample is deliberately represented with relayObserved=false.
 * The UI must never interpret a communications failure as a physically-normal
 * relay state.
 */
export function buildLiveRelayStatusUnits(
  detectors: readonly RelayStatusLightDetectorState[],
  inputs: Record<string, boolean> | null,
  relayConfig: RelayFunctionalTestConfig,
): RelayStatusLightUnit[] {
  const byIndex = new Map(detectors.map((detector) => [detector.index, detector]));

  return DETECTOR_INDEXES.map((index) => {
    const detector = byIndex.get(index);
    const mapping = relayFeedbackMappingFor(relayConfig, index);
    const alarmActive = mapping && inputs
      ? relayInputIsActive(inputs[mapping.alarmInputAddress], mapping.alarmNormalLevel)
      : null;
    const faultActive = mapping && inputs
      ? relayInputIsActive(inputs[mapping.faultInputAddress], mapping.faultNormalLevel)
      : null;
    const relayObserved = alarmActive !== null && faultActive !== null;

    return {
      index,
      online: Boolean(detector?.online),
      fire: Boolean(detector?.fire),
      fault: Boolean(detector?.fault),
      alarmRelay: relayObserved ? Boolean(alarmActive) : false,
      faultRelay: relayObserved ? Boolean(faultActive) : false,
      relayObserved,
    };
  });
}

function relayConfigReady(config: RelayFunctionalTestConfig): boolean {
  // The production relay-test enable switch must not disable the read-only live
  // status lamps. Live indication only depends on a valid DIO connection and
  // complete D1-D6 input mappings.
  return relayDioConfigReady(config.dio)
    && relayFunctionalTestMissingMappings(config, [...DETECTOR_INDEXES]).length === 0;
}

/**
 * Adds a live physical-relay endpoint without changing the formal relay-test
 * coordinator. The browser status-light runtime consumes this endpoint while
 * keeping its existing batch latch / vision evidence behaviour.
 */
export function startRelayStatusLightsService(
  runtime: ProductAwareFieldStatusRuntime,
): RelayStatusLightsRuntime {
  let relayConfig = DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG;
  const sharedInputSource = getPrimaryRelayFeedbackInputSource();
  const inputSource = sharedInputSource ?? new DioModbusTcpInputSource(relayConfig.dio);
  const ownsInputSource = sharedInputSource === null;
  let lastConfigLoadedAt = 0;
  let lastErrorLoggedAt = 0;
  let closed = false;

  const refreshConfig = async (): Promise<RelayFunctionalTestConfig> => {
    const now = Date.now();
    if (now - lastConfigLoadedAt < CONFIG_REFRESH_INTERVAL_MS) return relayConfig;
    const systemConfig = await loadSystemConfig();
    const next = normalizeRelayFunctionalTestConfig(
      systemConfig?.relayFunctionalTestConfig,
      DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
    );
    relayConfig = next;
    lastConfigLoadedAt = now;
    await inputSource.updateConfig(next.dio);
    return next;
  };

  runtime.app.get('/api/detector-status-lights/live', async (_req, res) => {
    const snapshot = runtime.snapshot();
    const summary = snapshot.summary;
    const flame = snapshot.flame;
    let inputs: Record<string, boolean> | null = null;
    let relayError: string | null = null;

    try {
      const currentConfig = await refreshConfig();
      if (!relayConfigReady(currentConfig)) {
        relayError = 'DIO_MAPPING_NOT_READY';
      } else {
        inputs = await inputSource.readInputs();
      }
    } catch (error) {
      relayError = error instanceof RelayFeedbackDioError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
      const now = Date.now();
      if (now - lastErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
        lastErrorLoggedAt = now;
        console.warn(`[继电器状态灯] DIO实时读取失败：${relayError}`);
      }
    }

    res.json({
      active: summary.productSelectionLocked,
      batchId: summary.waveformAnalysis.batchId,
      updatedAt: Date.now(),
      relayAvailable: inputs !== null,
      relayError,
      units: buildLiveRelayStatusUnits(flame.units, inputs, relayConfig),
    });
  });

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (ownsInputSource) await inputSource.disconnect();
    },
  };
}
