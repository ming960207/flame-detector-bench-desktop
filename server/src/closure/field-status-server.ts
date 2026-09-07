import express, { type Express } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { type AddressInfo } from 'net';
import {
  config,
  DEFAULT_FLAME_POLL_INTERVAL_MS,
  MAX_FLAME_POLL_INTERVAL_MS,
  DEFAULT_WAVEFORM_SEND_MODE,
  type FlameConfig,
  type FlameUnitConfig,
  type PLCDeviceConfigLocal,
} from '../config.js';
import { WSServer } from '../websocket/ws-server.js';
import { PLCProcessMonitor } from '../plc-process-monitor.js';
import type { PLCProcessStatus } from '../process-status.js';
import { FlameDetectorService } from '../modbus/flame-detector-service.js';
import { WSMessageType, type FlameDetectorState } from '../types.js';
import type { AutoTestProgress, AutoTestReport, DetectorReadyReport } from '../modbus/flame-detector-service.js';
import { evaluateFieldDetectorBatch, type FieldDetectorBatchVerdict } from './field-detector-verdict.js';
import { evaluateFieldFinalVerdict, type FieldFinalVerdict } from './field-final-verdict.js';
import {
  DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
  FieldWaveformAnalysis,
  normalizeDetectionQualityConfig,
  type ChannelKey,
} from './field-waveform-analysis.js';
import { loadPLCConfigs, mergeWithDefaults } from '../plc-config-store.js';
import { requireDesktopMutation } from '../request-security.js';
import { createDefaultSystemConfig, loadSystemConfig, saveSystemConfig } from '../system-config-store.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
  productAwareWaveformConfig,
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from '../product-profile.js';
import {
  captureInspectionPosition,
  FileFieldTestResultLogger,
  type FieldTestResultLogger,
  type InspectionPositionId,
  type InspectionPositionResult,
} from './field-test-result-log.js';

const POSITION_ONE_PRECHECK_DELAY_MS = 15_000;

export interface PLCProcessStatusSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrent(): PLCProcessStatus | undefined;
  isConnected(): boolean;
  on(event: 'status' | 'error', listener: (value: any) => void): this;
}

export interface FieldStatusSummary {
  process: PLCProcessStatus | undefined;
  plcConnected: boolean;
  detectorConnected: boolean;
  detectorTransportConnected: boolean;
  detectorDataStreamConnected: boolean;
  detectorVerdict: FieldDetectorBatchVerdict;
  waveformAnalysis: ReturnType<FieldWaveformAnalysis['snapshot']>;
  finalVerdict: FieldFinalVerdict;
  productConfig: ProductDetectionConfig;
  productSelectionLocked: boolean;
  productPrecheck: ProductPrecheckReport | null;
  productPrecheckBusy: boolean;
  detectorStartup?: DetectorReadyReport;
}

export interface FieldStatusSnapshot {
  summary: FieldStatusSummary;
  flame: FlameDetectorState;
}

export interface FieldStatusRuntime {
  readonly app: Express;
  readonly wsServer: WSServer;
  snapshot(): FieldStatusSnapshot;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export interface FlameDetectorStatusSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getCurrentState(): FlameDetectorState;
  isConnected(): boolean;
  isTransportConnected?(): boolean;
  isDataStreamConnected?(): boolean;
  clearWaveformHistory?(): void;
  setVerticalDownLimit?(reached: boolean): void;
  prepareWaveformStartup?(batchId?: string): void;
  waitForReady?(options?: { requiredSlots?: number[]; timeoutMs?: number }): Promise<DetectorReadyReport>;
  getReadyReport?(requiredSlots?: number[], timeoutMs?: number): DetectorReadyReport;
  stopWaveformStreaming?(): Promise<void>;
  runProductPrecheck?(productConfig: ProductDetectionConfig, batchId?: string | null): Promise<ProductPrecheckReport>;
  on(event: 'flame_state' | 'error', listener: (value: any) => void): this;
  getConfig?(): FlameConfig;
  updateConfig?(config: FlameConfig): void;
  runAutoTest?(onProgress?: (progress: AutoTestProgress) => void, options?: { enabledStepKeys?: string[] }): Promise<AutoTestReport>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeProbeList(value: unknown, fallback: ChannelKey[]): ChannelKey[] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set<ChannelKey>(['probe1', 'probe2', 'probe3', 'probe4']);
  const result = [...new Set(value.filter((item): item is ChannelKey => typeof item === 'string' && allowed.has(item as ChannelKey)))];
  return result.length > 0 ? result : [...fallback];
}

export function normalizeFlameConfig(input: unknown, current: FlameConfig): FlameConfig {
  const source = isRecord(input) ? input : {};
  const inputUnits = Array.isArray(source.units) ? source.units : [];
  const currentByIndex = new Map(current.units.map((unit) => [unit.index, unit]));
  const currentAnalysis = isRecord(current.waveformAnalysis) ? current.waveformAnalysis : {};
  const inputAnalysis = isRecord(source.waveformAnalysis) ? source.waveformAnalysis : {};
  const currentMinNoiseSamples = boundedInteger(currentAnalysis.minNoiseSamples, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minNoiseSamples, 1, 2000);
  const currentMinInterferenceSamples = boundedInteger(currentAnalysis.minInterferenceSamples, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minInterferenceSamples, 1, 2000);
  const currentMinNoiseRms = boundedNumber(currentAnalysis.minNoiseRms, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minNoiseRms, 0, 1_000_000);
  const currentMaxNoiseRms = boundedNumber(currentAnalysis.maxNoiseRms, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxNoiseRms, 0, 1_000_000);
  const currentMaxInterferenceRatio = boundedNumber(currentAnalysis.maxInterferenceRatio, 1.5, 0, 1_000_000);
  const currentMaxNoiseAbsolute = boundedNumber(currentAnalysis.maxNoiseAbsolute, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.maxNoiseAbsolute ?? 800, 0, 1_000_000);
  const currentMinConsistencyTrend = boundedNumber(currentAnalysis.minConsistencyTrend, DEFAULT_WAVEFORM_ANALYSIS_CONFIG.minConsistencyTrend ?? 0.75, 0, 1);
  const validProbe = (value: unknown, fallback: ChannelKey): ChannelKey => ['probe1', 'probe2', 'probe3', 'probe4'].includes(String(value)) ? String(value) as ChannelKey : fallback;
  const currentRatio: Record<string, unknown> = isRecord(currentAnalysis.interferenceRatio) ? currentAnalysis.interferenceRatio : {};
  const inputRatio: Record<string, unknown> = isRecord(inputAnalysis.interferenceRatio) ? inputAnalysis.interferenceRatio : {};
  const currentPollIntervalMs = boundedInteger(current.pollIntervalMs, DEFAULT_FLAME_POLL_INTERVAL_MS, 100, MAX_FLAME_POLL_INTERVAL_MS);
  const currentQuality = normalizeDetectionQualityConfig(currentAnalysis.quality);
  const quality = normalizeDetectionQualityConfig(inputAnalysis.quality, currentQuality);
  const currentNoiseProbes = normalizeProbeList(currentAnalysis.noiseProbes, ['probe2', 'probe3']);
  const currentConsistencyProbes = normalizeProbeList(currentAnalysis.consistencyProbes, ['probe2', 'probe3']);
  const units: FlameUnitConfig[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const existing = currentByIndex.get(index) ?? { index, address: index, enabled: false };
    const candidate = inputUnits.find((item) => isRecord(item) && Number(item.index) === index);
    const item = isRecord(candidate) ? candidate : {};
    const protocol = item.protocol === 'four-wavelength' || item.protocol === 'standard' ? item.protocol : existing.protocol;
    units.push({
      index,
      address: boundedInteger(item.address, existing.address, 1, 247),
      enabled: typeof item.enabled === 'boolean' ? item.enabled : existing.enabled,
      connMode: item.connMode === 'TCP' || item.connMode === 'RTU' ? item.connMode : existing.connMode,
      serialPath: typeof item.serialPath === 'string' ? item.serialPath.trim() || undefined : existing.serialPath,
      baudRate: boundedInteger(item.baudRate, existing.baudRate ?? current.baudRate ?? 115200, 300, 2_000_000),
      dataBits: boundedInteger(item.dataBits, existing.dataBits ?? 8, 5, 8),
      stopBits: boundedInteger(item.stopBits, existing.stopBits ?? 1, 1, 2),
      parity: item.parity === 'none' || item.parity === 'even' || item.parity === 'odd' ? item.parity : existing.parity,
      tcpHost: typeof item.tcpHost === 'string' ? item.tcpHost.trim() || undefined : existing.tcpHost,
      tcpPort: boundedInteger(item.tcpPort, existing.tcpPort ?? 502, 1, 65535),
      protocol,
      imageAlarmEnabled: typeof item.imageAlarmEnabled === 'boolean' ? item.imageAlarmEnabled : existing.imageAlarmEnabled,
      imageAlarmZone: boundedInteger(item.imageAlarmZone, existing.imageAlarmZone ?? 0, 0, 255),
    });
  }
  return {
    mode: source.mode === 'TCP' || source.mode === 'RTU' ? source.mode : current.mode,
    ip: typeof source.ip === 'string' ? source.ip.trim() || current.ip : current.ip,
    port: boundedInteger(source.port, current.port, 1, 65535),
    serialPath: typeof source.serialPath === 'string' ? source.serialPath.trim() || undefined : current.serialPath,
    baudRate: boundedInteger(source.baudRate, current.baudRate ?? 115200, 300, 2_000_000),
    dataBits: boundedInteger(source.dataBits, current.dataBits ?? 8, 5, 8),
    stopBits: boundedInteger(source.stopBits, current.stopBits ?? 1, 1, 2),
    parity: source.parity === 'none' || source.parity === 'even' || source.parity === 'odd' ? source.parity : current.parity,
    units,
    pollIntervalMs: boundedInteger(source.pollIntervalMs, currentPollIntervalMs, 100, MAX_FLAME_POLL_INTERVAL_MS),
    protocol: source.protocol === 'four-wavelength' || source.protocol === 'standard' ? source.protocol : current.protocol,
    waveformSendMode: source.waveformSendMode === 'active' || source.waveformSendMode === 'filtered'
      ? source.waveformSendMode
      : (current.waveformSendMode ?? DEFAULT_WAVEFORM_SEND_MODE),
    waveformDisplayMode: source.waveformDisplayMode === 'raw' || source.waveformDisplayMode === 'normalized'
      ? source.waveformDisplayMode
      : (current.waveformDisplayMode ?? 'normalized'),
    waveformMaxSamples: boundedInteger(source.waveformMaxSamples, current.waveformMaxSamples ?? 1000, 10, 1000),
    waveformAnalysis: {
      minNoiseSamples: boundedInteger(inputAnalysis.minNoiseSamples, currentMinNoiseSamples, 1, 2000),
      minInterferenceSamples: boundedInteger(inputAnalysis.minInterferenceSamples, currentMinInterferenceSamples, 1, 2000),
      minNoiseRms: boundedNumber(inputAnalysis.minNoiseRms, currentMinNoiseRms, 0, 1_000_000),
      maxNoiseRms: boundedNumber(inputAnalysis.maxNoiseRms, currentMaxNoiseRms, 0, 1_000_000),
      maxNoiseAbsolute: boundedNumber(inputAnalysis.maxNoiseAbsolute, currentMaxNoiseAbsolute, 0, 1_000_000),
      maxInterferenceRatio: boundedNumber(inputAnalysis.maxInterferenceRatio, currentMaxInterferenceRatio, 0, 1_000_000),
      minConsistencyTrend: boundedNumber(inputAnalysis.minConsistencyTrend, currentMinConsistencyTrend, 0, 1),
      noiseProbes: normalizeProbeList(inputAnalysis.noiseProbes, currentNoiseProbes),
      consistencyProbes: normalizeProbeList(inputAnalysis.consistencyProbes, currentConsistencyProbes),
      interferenceRatio: {
        numerator: validProbe(inputRatio.numerator, validProbe(currentRatio.numerator, 'probe2')),
        denominator: validProbe(inputRatio.denominator, validProbe(currentRatio.denominator, 'probe3')),
      },
      quality,
    },
  };
}

export function selectFieldPLCProcessObserver(plcs: PLCDeviceConfigLocal[]): PLCDeviceConfigLocal {
  const configured = plcs.find((plc) => plc.enabled && plc.mode === 'S7') ?? plcs.find((plc) => plc.enabled) ?? plcs[0];
  if (!configured) throw new Error('PLC_PROCESS_STATUS_CONFIG_MISSING');
  return { ...configured, mode: 'S7', port: 102 };
}

function processLocksProductSelection(status: PLCProcessStatus | undefined): boolean {
  const stage = status?.processStage;
  return Boolean(stage && stage !== 'IDLE' && stage !== 'COMPLETE' && stage !== 'UNKNOWN');
}

function isPositionOneSignalStabilization(status: PLCProcessStatus | undefined): boolean {
  if (!status || status.stage === 'FAULT' || status.processStage !== 'HEAT') return false;
  if (status.io?.steps?.stepM10_4 === true) return false;
  return status.io?.internal?.signalStabilizing === true
    && status.io?.internal?.noiseCaptureWindow !== true;
}

export function createFieldStatusRuntime(
  source: PLCProcessStatusSource = new PLCProcessMonitor(config.plcs[0]!),
  detectors: FlameDetectorStatusSource = new FlameDetectorService(config.flame, { deferWaveformUntilInspection: true }),
  resultLogger: FieldTestResultLogger = new FileFieldTestResultLogger(),
  initialProductConfig: ProductDetectionConfig = DEFAULT_PRODUCT_DETECTION_CONFIG,
): FieldStatusRuntime {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cors({
    origin: [
      'null',
      'file://',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://127.0.0.1:3002',
      'http://localhost:3002',
      'http://127.0.0.1:3005',
      'http://localhost:3005',
    ],
  }));
  const server = createServer(app);
  const wsServer = new WSServer();
  wsServer.init(server);
  let currentStatus = source.getCurrent();
  let productConfig = normalizeProductDetectionConfig(initialProductConfig);
  const initialProfile = selectedProductProfile(productConfig);
  const waveformAnalysis = new FieldWaveformAnalysis(productAwareWaveformConfig(config.flame.waveformAnalysis, initialProfile.expectedProbeCount));
  if (currentStatus) waveformAnalysis.observeProcess(currentStatus);
  let waveformAnalysisState = waveformAnalysis.snapshot();
  let productPrecheck: ProductPrecheckReport | null = null;
  let productPrecheckBusy = false;
  let productPrecheckBatchId: string | null = null;
  let productPrecheckDelayTimer: NodeJS.Timeout | null = null;
  let productPrecheckDelayBatchId: string | null = null;
  let streamingStoppedBatchId: string | null = null;
  let detectorVerdict: FieldDetectorBatchVerdict = evaluateFieldDetectorBatch(detectors.getCurrentState(), waveformAnalysisState, productPrecheck, productConfig);
  let finalVerdict: FieldFinalVerdict = evaluateFieldFinalVerdict(currentStatus, detectorVerdict, waveformAnalysisState);
  let loggedBatchId: string | null = null;
  let positionBatchId: string | null = null;
  let detectorMutationBusy = false;
  let detectorStartupBatchId: string | null = null;
  let detectorStartupReport: DetectorReadyReport | undefined = detectors.getReadyReport?.();
  let detectorStartupWaitGeneration = 0;
  let inspectionPositions = new Map<InspectionPositionId, InspectionPositionResult>();
  const positionStartedAt = new Map<InspectionPositionId, number>();

  const resetInspectionPositions = (batchId: string) => {
    positionBatchId = batchId;
    positionStartedAt.clear();
    inspectionPositions = new Map([
      ['DETECTION_POSITION_1_HEAT', { id: 'DETECTION_POSITION_1_HEAT', label: '第一次检测位/热源检测', status: 'NOT_OBSERVED', startedAt: null, completedAt: null, devices: [] }],
      ['DETECTION_POSITION_2_FLASH', { id: 'DETECTION_POSITION_2_FLASH', label: '第二次检测位/爆闪检测', status: 'NOT_OBSERVED', startedAt: null, completedAt: null, devices: [] }],
    ]);
  };

  const applyProductWaveformProfile = () => {
    const profile = selectedProductProfile(productConfig);
    waveformAnalysis.updateConfig(productAwareWaveformConfig(config.flame.waveformAnalysis, profile.expectedProbeCount));
    waveformAnalysisState = waveformAnalysis.snapshot();
  };
  const detectorDataStreamConnected = () => detectors.isDataStreamConnected?.() ?? detectors.isConnected();
  const detectorTransportConnected = () => detectors.isTransportConnected?.() ?? detectors.isConnected();
  const recomputeVerdicts = (state = detectors.getCurrentState()) => {
    detectorVerdict = evaluateFieldDetectorBatch(state, waveformAnalysisState, productPrecheck, productConfig);
    finalVerdict = evaluateFieldFinalVerdict(currentStatus, detectorVerdict, waveformAnalysisState);
  };
  const summary = (): FieldStatusSummary => ({
    process: source.isConnected() ? currentStatus : undefined,
    plcConnected: source.isConnected(),
    detectorConnected: detectorDataStreamConnected(),
    detectorTransportConnected: detectorTransportConnected(),
    detectorDataStreamConnected: detectorDataStreamConnected(),
    detectorVerdict,
    waveformAnalysis: waveformAnalysisState,
    finalVerdict,
    productConfig,
    productSelectionLocked: processLocksProductSelection(currentStatus),
    productPrecheck,
    productPrecheckBusy,
    ...(detectorStartupReport ? { detectorStartup: detectorStartupReport } : {}),
  });
  const broadcastSummary = () => wsServer.broadcastFieldSummary(summary());

  const beginDetectorStartupBarrier = (): void => {
    if (!detectors.waitForReady || !waveformAnalysisState.batchId) return;
    const startupBatchId = waveformAnalysisState.batchId;
    const generation = ++detectorStartupWaitGeneration;
    const requiredSlots = detectors.getConfig?.().units.filter((unit) => unit.enabled).map((unit) => unit.index);
    detectorStartupReport = detectors.getReadyReport?.(requiredSlots) ?? detectorStartupReport;
    void detectors.waitForReady({ requiredSlots, timeoutMs: 15_000 }).then((report) => {
      if (generation !== detectorStartupWaitGeneration || detectorStartupBatchId !== startupBatchId || waveformAnalysisState.batchId !== startupBatchId) return;
      detectorStartupReport = report;
      const failed = report.units.find((unit) => !unit.ready);
      const waitingForLimit = failed?.startup.state === 'WAITING_FOR_VERTICAL_LOWER_LIMIT';
      waveformAnalysis.setDetectorStartupBarrier(
        report.ready,
        report.ready ? undefined : failed?.startup.failureReason || (waitingForLimit ? 'WAITING_FOR_VERTICAL_LOWER_LIMIT' : 'DETECTOR_STARTUP_TIMEOUT'),
      );
      recomputeVerdicts();
      broadcastSummary();
    }).catch((error) => {
      if (generation !== detectorStartupWaitGeneration || detectorStartupBatchId !== startupBatchId || waveformAnalysisState.batchId !== startupBatchId) return;
      const reason = error instanceof Error ? error.message : String(error);
      waveformAnalysis.setDetectorStartupBarrier(false, reason);
      broadcastSummary();
    });
  };

  const runProductPrecheck = async (batchId: string | null): Promise<void> => {
    if (productPrecheckBusy || !detectors.runProductPrecheck) return;
    const effectiveBatchId = batchId ?? `plc-${currentStatus?.timestamp ?? Date.now()}`;
    if (productPrecheckBatchId === effectiveBatchId && productPrecheck) return;
    productPrecheckBusy = true;
    productPrecheckBatchId = effectiveBatchId;
    const profile = selectedProductProfile(productConfig);
    productPrecheck = {
      batchId: effectiveBatchId,
      productType: productConfig.selectedType,
      productLabel: profile.label,
      expectedSoftwareVersion: profile.expectedSoftwareVersion,
      expectedProbeCount: profile.expectedProbeCount,
      startedAt: Date.now(),
      completedAt: 0,
      verdict: 'PENDING',
      units: [],
    };
    recomputeVerdicts();
    broadcastSummary();
    try {
      productPrecheck = await detectors.runProductPrecheck(productConfig, effectiveBatchId);
    } catch (error) {
      productPrecheck = {
        ...productPrecheck,
        completedAt: Date.now(),
        verdict: 'FAIL',
      };
      wsServer.broadcastError(error instanceof Error ? `PRODUCT_PRECHECK_FAILED: ${error.message}` : 'PRODUCT_PRECHECK_FAILED');
    } finally {
      productPrecheckBusy = false;
      recomputeVerdicts();
      broadcastSummary();
    }
  };

  const cancelDelayedProductPrecheck = (reason: string) => {
    if (!productPrecheckDelayTimer) return;
    clearTimeout(productPrecheckDelayTimer);
    productPrecheckDelayTimer = null;
    console.log(`[产品预检] 已取消延迟触发 batch=${productPrecheckDelayBatchId ?? '-'} reason=${reason}`);
    productPrecheckDelayBatchId = null;
  };

  const scheduleDelayedProductPrecheck = (batchId: string | null) => {
    if (productPrecheckDelayTimer || productPrecheckBusy || productPrecheck || !detectors.runProductPrecheck) return;
    const scheduledBatchId = batchId;
    productPrecheckDelayBatchId = batchId ?? `plc-${currentStatus?.timestamp ?? Date.now()}`;
    console.log(`[产品预检] 信号稳定阶段开始，前 ${POSITION_ONE_PRECHECK_DELAY_MS}ms 仅保持波形稳定，随后在稳定阶段后段执行预检 batch=${productPrecheckDelayBatchId}`);
    productPrecheckDelayTimer = setTimeout(() => {
      productPrecheckDelayTimer = null;
      const delayedBatchId = productPrecheckDelayBatchId;
      productPrecheckDelayBatchId = null;
      if (!isPositionOneSignalStabilization(currentStatus)) {
        console.warn(`[产品预检] 延迟到点但已不在信号稳定阶段，禁止在正式噪声窗口插入预检 batch=${delayedBatchId ?? '-'}`);
        return;
      }
      if (scheduledBatchId && waveformAnalysisState.batchId !== scheduledBatchId) {
        console.warn(`[产品预检] 延迟到点但批次已切换，跳过旧批次预检 scheduled=${scheduledBatchId} current=${waveformAnalysisState.batchId ?? '-'}`);
        return;
      }
      console.log(`[产品预检] 已进入信号稳定后段，开始读取版本/探头/灵敏度/状态并执行继电器功能检测 batch=${delayedBatchId ?? '-'}`);
      void runProductPrecheck(waveformAnalysisState.batchId);
    }, POSITION_ONE_PRECHECK_DELAY_MS);
  };

  source.on('status', (status: PLCProcessStatus) => {
    const previousStatus = currentStatus;
    const previousStage = previousStatus?.processStage;
    const previousBatchId = waveformAnalysisState.batchId;
    const signalStabilizationStarted = isPositionOneSignalStabilization(status) && !isPositionOneSignalStabilization(previousStatus);
    const signalStabilizationEnded = !isPositionOneSignalStabilization(status) && isPositionOneSignalStabilization(previousStatus);
    const heatInterferenceStarted = status.io?.steps?.stepM10_4 === true && previousStatus?.io?.steps?.stepM10_4 !== true;
    const heatInterferenceCompleted = status.io?.steps?.stepM10_4 !== true && previousStatus?.io?.steps?.stepM10_4 === true;
    const flashStarted = status.io?.steps?.stepM11_0 === true && previousStatus?.io?.steps?.stepM11_0 !== true;
    const flashCompleted = status.io?.steps?.stepM11_0 !== true && previousStatus?.io?.steps?.stepM11_0 === true;
    const verticalLowerLimitSignal = status.io?.inputs?.verticalDownFeedback;
    const verticalLowerLimit = verticalLowerLimitSignal === true;
    const verticalLowerLimitKnown = typeof verticalLowerLimitSignal === 'boolean';
    const verticalLowerLimitStarted = verticalLowerLimitKnown && verticalLowerLimit && previousStatus?.io?.inputs?.verticalDownFeedback !== true;
    currentStatus = status;
    if (verticalLowerLimitKnown) detectors.setVerticalDownLimit?.(verticalLowerLimit);
    const interferenceWindowStarted = (status.processStage === 'FLASH' || status.processStage === 'EMC')
      && previousStage !== 'FLASH' && previousStage !== 'EMC';
    waveformAnalysis.observeProcess(status);
    waveformAnalysisState = waveformAnalysis.snapshot();
    const batchStarted = waveformAnalysisState.batchId !== previousBatchId;
    if (batchStarted) {
      cancelDelayedProductPrecheck('BATCH_CHANGED');
      productPrecheck = null;
      productPrecheckBatchId = null;
      streamingStoppedBatchId = null;
      applyProductWaveformProfile();
      detectorStartupBatchId = waveformAnalysisState.batchId;
      if (detectors.waitForReady && waveformAnalysisState.batchId) {
        waveformAnalysis.setDetectorStartupBarrier(false);
        detectors.prepareWaveformStartup?.(waveformAnalysisState.batchId ?? undefined);
        beginDetectorStartupBarrier();
      }
    }
    if (verticalLowerLimitStarted && !batchStarted) beginDetectorStartupBarrier();
    if (batchStarted || heatInterferenceStarted || interferenceWindowStarted) detectors.clearWaveformHistory?.();
    if (waveformAnalysisState.batchId && positionBatchId !== waveformAnalysisState.batchId) resetInspectionPositions(waveformAnalysisState.batchId);
    if (signalStabilizationStarted) scheduleDelayedProductPrecheck(waveformAnalysisState.batchId);
    if (signalStabilizationEnded && productPrecheckDelayTimer) cancelDelayedProductPrecheck('LEFT_SIGNAL_STABILIZATION');
    if (heatInterferenceStarted) positionStartedAt.set('DETECTION_POSITION_1_HEAT', status.timestamp);
    if (flashStarted) positionStartedAt.set('DETECTION_POSITION_2_FLASH', status.timestamp);
    if (heatInterferenceCompleted) {
      inspectionPositions.set('DETECTION_POSITION_1_HEAT', captureInspectionPosition(
        'DETECTION_POSITION_1_HEAT', '第一次检测位/热源检测',
        positionStartedAt.get('DETECTION_POSITION_1_HEAT') ?? null, status.timestamp, detectors.getCurrentState(),
      ));
    }
    if (flashCompleted) {
      inspectionPositions.set('DETECTION_POSITION_2_FLASH', captureInspectionPosition(
        'DETECTION_POSITION_2_FLASH', '第二次检测位/爆闪检测',
        positionStartedAt.get('DETECTION_POSITION_2_FLASH') ?? null, status.timestamp, detectors.getCurrentState(),
      ));
    }
    recomputeVerdicts();
    if (waveformAnalysisState.phase === 'COMPLETE' && waveformAnalysisState.batchId && streamingStoppedBatchId !== waveformAnalysisState.batchId) {
      streamingStoppedBatchId = waveformAnalysisState.batchId;
      void detectors.stopWaveformStreaming?.().catch((error) => {
        wsServer.broadcastError(error instanceof Error ? `FLAME_STREAM_STOP_FAILED: ${error.message}` : 'FLAME_STREAM_STOP_FAILED');
      });
    }
    if (waveformAnalysisState.phase === 'COMPLETE' && waveformAnalysisState.batchId && loggedBatchId !== waveformAnalysisState.batchId) {
      try {
        resultLogger.record({
          batchId: waveformAnalysisState.batchId,
          startedAt: waveformAnalysisState.startedAt,
          completedAt: status.timestamp,
          finalVerdict,
          detectorVerdict,
          thresholds: waveformAnalysisState.thresholds,
          waveformAnalysis: waveformAnalysisState,
          inspectionPositions: Array.from(inspectionPositions.values()),
        });
        loggedBatchId = waveformAnalysisState.batchId;
      } catch (error) {
        wsServer.broadcastError(error instanceof Error ? `TEST_RESULT_LOG_WRITE_FAILED: ${error.message}` : 'TEST_RESULT_LOG_WRITE_FAILED');
      }
    }
    wsServer.broadcastPLCProcessStatus(status);
    broadcastSummary();
  });
  source.on('error', (error: unknown) => {
    cancelDelayedProductPrecheck('PLC_STATUS_ERROR');
    currentStatus = undefined;
    finalVerdict = evaluateFieldFinalVerdict(undefined, detectorVerdict, waveformAnalysisState);
    wsServer.broadcastError(error instanceof Error ? error.message : 'PLC_PROCESS_STATUS_READ_FAILED');
    broadcastSummary();
  });
  detectors.on('flame_state', (state: FlameDetectorState) => {
    detectorStartupReport = detectors.getReadyReport?.() ?? detectorStartupReport;
    waveformAnalysis.observeDetectors(state);
    waveformAnalysisState = waveformAnalysis.snapshot();
    recomputeVerdicts(state);
    wsServer.broadcastFlameState(state);
    broadcastSummary();
  });
  detectors.on('error', (error: unknown) => wsServer.broadcastError(error instanceof Error ? error.message : 'FLAME_DETECTOR_READ_FAILED'));
  wsServer.on('client_connected', () => {
    if (currentStatus) wsServer.broadcastPLCProcessStatus(currentStatus);
    wsServer.broadcastFlameState(detectors.getCurrentState());
    broadcastSummary();
  });

  app.get('/api/health', (_req, res) => res.json({
    status: 'ok',
    mode: 'field-plc-readonly',
    capabilities: {
      plcWrite: false,
      detectorConfig: true,
      detectorReadonlyAutoTest: true,
      productPrecheck: true,
      testObserver: true,
      mqttUpload: true,
    },
    plcConnected: source.isConnected(),
    detectorConnected: detectorDataStreamConnected(),
    detectorTransportConnected: detectorTransportConnected(),
    detectorDataStreamConnected: detectorDataStreamConnected(),
    detectorMutationBusy,
    productPrecheckBusy,
    timestamp: Date.now(),
  }));
  app.get('/api/plc/process-status', (_req, res) => {
    const current = source.isConnected() ? source.getCurrent() : undefined;
    if (!current) return res.status(503).json({ code: 'PLC_PROCESS_STATUS_UNAVAILABLE' });
    return res.json(current);
  });
  app.get('/api/product-config', (_req, res) => {
    res.json({ config: productConfig, locked: processLocksProductSelection(currentStatus), precheck: productPrecheck });
  });
  app.put('/api/product-config', requireDesktopMutation, async (req, res) => {
    if (processLocksProductSelection(currentStatus)) return res.status(409).json({ code: 'PRODUCT_CONFIG_LOCKED_DURING_PROCESS' });
    const previous = productConfig;
    try {
      const next = normalizeProductDetectionConfig(req.body, previous);
      productConfig = next;
      productPrecheck = null;
      productPrecheckBatchId = null;
      applyProductWaveformProfile();
      recomputeVerdicts();
      const store = await loadSystemConfig() ?? createDefaultSystemConfig();
      await saveSystemConfig({ ...store, productDetectionConfig: next, lastUpdated: Date.now() });
      broadcastSummary();
      return res.json({ success: true, config: next, locked: false });
    } catch (error) {
      productConfig = previous;
      applyProductWaveformProfile();
      recomputeVerdicts();
      return res.status(500).json({ code: 'PRODUCT_CONFIG_UPDATE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api/flame/devices', (_req, res) => res.json(detectors.getCurrentState()));
  app.get('/api/flame/startup', (_req, res) => res.json(detectors.getReadyReport?.() ?? {
    ready: false,
    verticalDownLimitKnown: false,
    verticalDownLimitReached: false,
    timeoutMs: 15_000,
    startedAt: null,
    completedAt: Date.now(),
    requiredSlots: [],
    units: [],
  }));
  app.get('/api/flame/config', (_req, res) => {
    const current = detectors.getConfig?.() ?? config.flame;
    res.json({ success: true, config: current });
  });
  app.put('/api/flame/config', requireDesktopMutation, async (req, res) => {
    if (detectorMutationBusy) return res.status(409).json({ code: 'FLAME_OPERATION_BUSY' });
    if (processLocksProductSelection(currentStatus)) return res.status(409).json({ code: 'FLAME_CONFIG_LOCKED_DURING_PROCESS' });
    if (!detectors.updateConfig || !detectors.getConfig) return res.status(501).json({ code: 'FLAME_CONFIG_UNSUPPORTED' });
    detectorMutationBusy = true;
    const previous = detectors.getConfig();
    const next = normalizeFlameConfig(req.body, previous);
    try {
      await detectors.disconnect();
      detectors.updateConfig(next);
      config.flame = next;
      waveformAnalysis.updateConfig(productAwareWaveformConfig(next.waveformAnalysis, selectedProductProfile(productConfig).expectedProbeCount));
      waveformAnalysisState = waveformAnalysis.snapshot();
      await detectors.connect();
      const requiresTransport = next.units.some((unit) => unit.enabled);
      if (requiresTransport && !detectorTransportConnected()) throw new Error('FLAME_CONFIG_NEW_CONNECTION_UNAVAILABLE');
      recomputeVerdicts();
      const store = await loadSystemConfig() ?? createDefaultSystemConfig();
      await saveSystemConfig({ ...store, flameConfig: next, lastUpdated: Date.now() });
      broadcastSummary();
      return res.json({ success: true, config: next });
    } catch (error: any) {
      let rollbackError: string | null = null;
      try {
        await detectors.disconnect();
        detectors.updateConfig(previous);
        config.flame = previous;
        waveformAnalysis.updateConfig(productAwareWaveformConfig(previous.waveformAnalysis, selectedProductProfile(productConfig).expectedProbeCount));
        waveformAnalysisState = waveformAnalysis.snapshot();
        await detectors.connect();
        recomputeVerdicts();
        broadcastSummary();
      } catch (rollback) {
        rollbackError = rollback instanceof Error ? rollback.message : String(rollback);
      }
      return res.status(500).json({
        code: 'FLAME_CONFIG_UPDATE_FAILED',
        error: error?.message || String(error),
        rolledBack: rollbackError === null,
        rollbackError,
      });
    } finally {
      detectorMutationBusy = false;
    }
  });
  app.post('/api/flame/auto-test', requireDesktopMutation, async (req, res) => {
    if (detectorMutationBusy || productPrecheckBusy) return res.status(409).json({ code: 'FLAME_OPERATION_BUSY' });
    if (processLocksProductSelection(currentStatus)) return res.status(409).json({ code: 'FLAME_AUTO_TEST_LOCKED_DURING_PROCESS' });
    if (!detectors.runAutoTest) return res.status(501).json({ code: 'FLAME_AUTO_TEST_UNSUPPORTED' });
    detectorMutationBusy = true;
    try {
      const report = await detectors.runAutoTest((progress) => {
        wsServer.broadcast({ type: WSMessageType.FLAME_TEST_PROGRESS, payload: progress, timestamp: Date.now() });
      }, { enabledStepKeys: Array.isArray(req.body?.enabledStepKeys) ? req.body.enabledStepKeys : undefined });
      return res.json({ success: true, report });
    } catch (error: any) {
      return res.status(409).json({ code: 'FLAME_AUTO_TEST_FAILED', error: error?.message || String(error) });
    } finally {
      detectorMutationBusy = false;
    }
  });
  app.get('/api/field/summary', (_req, res) => res.json(summary()));
  app.all(['/api/do', '/api/do/*', '/api/relays/:relayId/do/:channel', '/api/closure/*'], (_req, res) => {
    res.status(409).json({ code: 'FIELD_STATUS_READONLY' });
  });

  return {
    app,
    wsServer,
    snapshot: () => ({ summary: summary(), flame: detectors.getCurrentState() }),
    async listen(port = config.serverPort): Promise<number> {
      await source.start();
      const actualPort = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
      void detectors.connect().catch((error: unknown) => {
        wsServer.broadcastError(error instanceof Error ? error.message : 'FLAME_DETECTOR_CONNECT_FAILED');
      });
      return actualPort;
    },
    async close(): Promise<void> {
      cancelDelayedProductPrecheck('RUNTIME_CLOSING');
      await source.stop();
      await detectors.disconnect();
      wsServer.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function startFieldStatusServer(): Promise<FieldStatusRuntime> {
  const savedPLCs = await loadPLCConfigs();
  const mergedPLCs = mergeWithDefaults(savedPLCs.length > 0 ? savedPLCs : config.plcs);
  config.plcs = [selectFieldPLCProcessObserver(mergedPLCs)];
  const systemConfig = await loadSystemConfig();
  const savedFlameConfig = systemConfig?.flameConfig
    ? { ...config.flame, ...systemConfig.flameConfig }
    : config.flame;
  config.flame = normalizeFlameConfig(savedFlameConfig, config.flame);
  const productConfig = normalizeProductDetectionConfig(systemConfig?.productDetectionConfig, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const runtime = createFieldStatusRuntime(
    new PLCProcessMonitor(config.plcs[0]!),
    new FlameDetectorService(config.flame, { deferWaveformUntilInspection: true }),
    new FileFieldTestResultLogger(),
    productConfig,
  );
  const port = await runtime.listen();
  console.log(`[现场状态] 已启动 PLC 只读工序监测、产品预检与探测器服务：http://127.0.0.1:${port}`);
  return runtime;
}
