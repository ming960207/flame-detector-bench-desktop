import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'http';
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
import type { AutoTestProgress, AutoTestReport } from '../modbus/flame-detector-service.js';
import { evaluateFieldDetectorBatch, type FieldDetectorBatchVerdict } from './field-detector-verdict.js';
import { evaluateFieldFinalVerdict, type FieldFinalVerdict } from './field-final-verdict.js';
import {
  DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
  FieldWaveformAnalysis,
  normalizeDetectionQualityConfig,
} from './field-waveform-analysis.js';
import { loadPLCConfigs, mergeWithDefaults } from '../plc-config-store.js';
import { createDefaultSystemConfig, loadSystemConfig, saveSystemConfig } from '../system-config-store.js';
import {
  captureInspectionPosition,
  FileFieldTestResultLogger,
  type FieldTestResultLogger,
  type InspectionPositionId,
  type InspectionPositionResult,
} from './field-test-result-log.js';

export interface PLCProcessStatusSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrent(): PLCProcessStatus | undefined;
  isConnected(): boolean;
  on(event: 'status' | 'error', listener: (value: any) => void): this;
}

export interface FieldStatusRuntime {
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

/** 只接收设备配置字段，避免配置接口成为任意对象写入入口。 */
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
  const validProbe = (value: unknown, fallback: 'probe1' | 'probe2' | 'probe3' | 'probe4') => ['probe1', 'probe2', 'probe3', 'probe4'].includes(String(value)) ? String(value) as typeof fallback : fallback;
  const currentRatio: Record<string, unknown> = isRecord(currentAnalysis.interferenceRatio) ? currentAnalysis.interferenceRatio : {};
  const inputRatio: Record<string, unknown> = isRecord(inputAnalysis.interferenceRatio) ? inputAnalysis.interferenceRatio : {};
  const currentPollIntervalMs = boundedInteger(current.pollIntervalMs, DEFAULT_FLAME_POLL_INTERVAL_MS, 100, MAX_FLAME_POLL_INTERVAL_MS);
  const currentQuality = normalizeDetectionQualityConfig(currentAnalysis.quality);
  const quality = normalizeDetectionQualityConfig(inputAnalysis.quality, currentQuality);
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
      noiseProbes: Array.isArray(inputAnalysis.noiseProbes) ? inputAnalysis.noiseProbes : (Array.isArray(currentAnalysis.noiseProbes) ? currentAnalysis.noiseProbes : ['probe1', 'probe2', 'probe3']),
      consistencyProbes: Array.isArray(inputAnalysis.consistencyProbes) ? inputAnalysis.consistencyProbes : (Array.isArray(currentAnalysis.consistencyProbes) ? currentAnalysis.consistencyProbes : ['probe1', 'probe2', 'probe3']),
      interferenceRatio: {
        numerator: validProbe(inputRatio.numerator, validProbe(currentRatio.numerator, 'probe2')),
        denominator: validProbe(inputRatio.denominator, validProbe(currentRatio.denominator, 'probe3')),
      },
      quality,
    },
  };
}

/**
 * The stored configuration is also used by the legacy Modbus control screen.
 * Field monitoring must always observe the S7 process registers over port 102,
 * without rewriting that operator-maintained configuration on disk.
 */
export function selectFieldPLCProcessObserver(plcs: PLCDeviceConfigLocal[]): PLCDeviceConfigLocal {
  const configured = plcs.find((plc) => plc.enabled && plc.mode === 'S7') ?? plcs.find((plc) => plc.enabled) ?? plcs[0];
  if (!configured) throw new Error('PLC_PROCESS_STATUS_CONFIG_MISSING');
  return {
    ...configured,
    mode: 'S7',
    port: 102,
  };
}

export function createFieldStatusRuntime(
  source: PLCProcessStatusSource = new PLCProcessMonitor(config.plcs[0]!),
  detectors: FlameDetectorStatusSource = new FlameDetectorService(config.flame),
  resultLogger: FieldTestResultLogger = new FileFieldTestResultLogger(),
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
    ],
  }));
  const server = createServer(app);
  const wsServer = new WSServer();
  wsServer.init(server);
  let currentStatus = source.getCurrent();
  const waveformAnalysis = new FieldWaveformAnalysis(config.flame.waveformAnalysis);
  if (currentStatus) waveformAnalysis.observeProcess(currentStatus);
  let waveformAnalysisState = waveformAnalysis.snapshot();
  let detectorVerdict: FieldDetectorBatchVerdict = evaluateFieldDetectorBatch(detectors.getCurrentState(), waveformAnalysisState);
  let finalVerdict: FieldFinalVerdict = evaluateFieldFinalVerdict(currentStatus, detectorVerdict, waveformAnalysisState);
  let loggedBatchId: string | null = null;
  let positionBatchId: string | null = null;
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

  const detectorDataStreamConnected = () => detectors.isDataStreamConnected?.() ?? detectors.isConnected();
  const detectorTransportConnected = () => detectors.isTransportConnected?.() ?? detectors.isConnected();
  const summary = () => ({
    process: source.isConnected() ? currentStatus : undefined,
    plcConnected: source.isConnected(),
    detectorConnected: detectorDataStreamConnected(),
    detectorTransportConnected: detectorTransportConnected(),
    detectorDataStreamConnected: detectorDataStreamConnected(),
    detectorVerdict,
    waveformAnalysis: waveformAnalysisState,
    finalVerdict,
  });
  const broadcastSummary = () => wsServer.broadcastFieldSummary(summary());

  source.on('status', (status: PLCProcessStatus) => {
    const previousStage = currentStatus?.processStage;
    const previousBatchId = waveformAnalysisState.batchId;
    const heatInterferenceStarted = status.io?.steps?.stepM10_4 === true
      && currentStatus?.io?.steps?.stepM10_4 !== true;
    const heatInterferenceCompleted = status.io?.steps?.stepM10_4 !== true
      && currentStatus?.io?.steps?.stepM10_4 === true;
    const flashStarted = status.io?.steps?.stepM11_0 === true
      && currentStatus?.io?.steps?.stepM11_0 !== true;
    const flashCompleted = status.io?.steps?.stepM11_0 !== true
      && currentStatus?.io?.steps?.stepM11_0 === true;
    currentStatus = status;
    const interferenceWindowStarted = (status.processStage === 'FLASH' || status.processStage === 'EMC')
      && previousStage !== 'FLASH'
      && previousStage !== 'EMC';
    waveformAnalysis.observeProcess(status);
    waveformAnalysisState = waveformAnalysis.snapshot();
    const batchStarted = waveformAnalysisState.batchId !== previousBatchId;
    if (batchStarted || heatInterferenceStarted || interferenceWindowStarted) {
      detectors.clearWaveformHistory?.();
    }
    if (waveformAnalysisState.batchId && positionBatchId !== waveformAnalysisState.batchId) {
      resetInspectionPositions(waveformAnalysisState.batchId);
    }
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
    detectorVerdict = evaluateFieldDetectorBatch(detectors.getCurrentState(), waveformAnalysisState);
    finalVerdict = evaluateFieldFinalVerdict(currentStatus, detectorVerdict, waveformAnalysisState);
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
    currentStatus = undefined;
    finalVerdict = evaluateFieldFinalVerdict(undefined, detectorVerdict, waveformAnalysisState);
    wsServer.broadcastError(error instanceof Error ? error.message : 'PLC_PROCESS_STATUS_READ_FAILED');
    broadcastSummary();
  });
  detectors.on('flame_state', (state: FlameDetectorState) => {
    waveformAnalysis.observeDetectors(state);
    waveformAnalysisState = waveformAnalysis.snapshot();
    detectorVerdict = evaluateFieldDetectorBatch(state, waveformAnalysisState);
    finalVerdict = evaluateFieldFinalVerdict(currentStatus, detectorVerdict, waveformAnalysisState);
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
    mode: 'field-status-readonly',
    plcConnected: source.isConnected(),
    detectorConnected: detectorDataStreamConnected(),
    detectorTransportConnected: detectorTransportConnected(),
    detectorDataStreamConnected: detectorDataStreamConnected(),
    timestamp: Date.now(),
  }));
  app.get('/api/plc/process-status', (_req, res) => {
    const current = source.isConnected() ? source.getCurrent() : undefined;
    if (!current) return res.status(503).json({ code: 'PLC_PROCESS_STATUS_UNAVAILABLE' });
    res.json(current);
  });
  app.get('/api/flame/devices', (_req, res) => res.json(detectors.getCurrentState()));
  app.get('/api/flame/config', (_req, res) => {
    const current = detectors.getConfig?.() ?? config.flame;
    res.json({ success: true, config: current });
  });
  app.put('/api/flame/config', async (req, res) => {
    if (!detectors.updateConfig || !detectors.getConfig) {
      return res.status(501).json({ code: 'FLAME_CONFIG_UNSUPPORTED' });
    }
    const next = normalizeFlameConfig(req.body, detectors.getConfig());
    try {
      await detectors.disconnect();
      detectors.updateConfig(next);
      config.flame = next;
      waveformAnalysis.updateConfig(next.waveformAnalysis);
      waveformAnalysisState = waveformAnalysis.snapshot();
      detectorVerdict = evaluateFieldDetectorBatch(detectors.getCurrentState(), waveformAnalysisState);
      finalVerdict = evaluateFieldFinalVerdict(currentStatus, detectorVerdict, waveformAnalysisState);
      await detectors.connect();
      const store = await loadSystemConfig() ?? createDefaultSystemConfig();
      await saveSystemConfig({ ...store, flameConfig: next, lastUpdated: Date.now() });
      broadcastSummary();
      res.json({ success: true, config: next });
    } catch (error: any) {
      res.status(500).json({ code: 'FLAME_CONFIG_UPDATE_FAILED', error: error?.message || String(error) });
    }
  });
  app.post('/api/flame/auto-test', async (req, res) => {
    if (!detectors.runAutoTest) return res.status(501).json({ code: 'FLAME_AUTO_TEST_UNSUPPORTED' });
    try {
      const report = await detectors.runAutoTest((progress) => {
        wsServer.broadcast({ type: WSMessageType.FLAME_TEST_PROGRESS, payload: progress, timestamp: Date.now() });
      }, { enabledStepKeys: Array.isArray(req.body?.enabledStepKeys) ? req.body.enabledStepKeys : undefined });
      res.json({ success: true, report });
    } catch (error: any) {
      res.status(409).json({ code: 'FLAME_AUTO_TEST_FAILED', error: error?.message || String(error) });
    }
  });
  app.get('/api/field/summary', (_req, res) => res.json(summary()));
  app.all(['/api/do', '/api/do/*', '/api/relays/:relayId/do/:channel', '/api/closure/*'], (_req, res) => {
    res.status(409).json({ code: 'FIELD_STATUS_READONLY' });
  });

  return {
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
  const runtime = createFieldStatusRuntime();
  const port = await runtime.listen();
  console.log(`[现场状态] 已启动只读 PLC 工序状态服务：http://127.0.0.1:${port}`);
  return runtime;
}
