import { EventEmitter } from 'node:events';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { FlameDetectorState, FlameDetectorWaveformDelta } from '../types.js';
import type { PLCProcessStatus } from '../process-status.js';
import { TestProgramArchiveStore } from './test-program-archive.js';
import { TestProgramTracker } from './test-program-tracker.js';
import {
  clonePlan,
  derivePlanFromPLCSteps,
  normalizePLCSteps,
  normalizeStagePlan,
  type TestProgramConfigPayload,
  type TestProgramPLCStep,
  type TestProgramPlanSource,
} from './test-program-plan-config.js';
import {
  DEFAULT_TEST_PROGRAM_STAGE_PLAN,
} from './test-program-types.js';
import type {
  TestProgramFormalSummary,
  TestProgramRun,
  TestProgramSnapshot,
  TestProgramStageDefinition,
} from './test-program-types.js';

export interface TestProgramObserverOptions {
  formalBackendUrl?: string;
  formalBackendWsUrl?: string;
  pollIntervalMs?: number;
  reconnectIntervalMs?: number;
  completionFlushDelayMs?: number;
  archiveStore?: TestProgramArchiveStore;
  tracker?: TestProgramTracker;
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function wsUrlFromHttp(httpUrl: string): string {
  return httpUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

function sourceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SavedPlanConfig {
  plan: TestProgramStageDefinition[];
  updatedAt: number;
}

interface FormalSystemConfigResponse {
  config?: {
    steps?: unknown[];
    lastUpdated?: unknown;
  } | null;
}

function readSavedPlan(file: string): SavedPlanConfig | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedPlanConfig>;
    if (!Array.isArray(parsed.plan)) return null;
    return {
      plan: normalizeStagePlan(parsed.plan),
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeSavedPlan(file: string, plan: readonly TestProgramStageDefinition[], updatedAt: number): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify({ plan: clonePlan(plan), updatedAt }, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class TestProgramObserver extends EventEmitter {
  readonly formalBackendUrl: string;
  readonly formalBackendWsUrl: string;
  readonly archiveStore: TestProgramArchiveStore;
  readonly tracker: TestProgramTracker;
  private readonly pollIntervalMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly completionFlushDelayMs: number;
  private readonly planConfigFile: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private completionTimer: NodeJS.Timeout | null = null;
  private websocket: WebSocket | null = null;
  private started = false;
  private wsConnected = false;
  private pollConnected = false;
  private planSource: TestProgramPlanSource = 'DEFAULT';
  private planUpdatedAt: number | null = null;
  private plcSteps: TestProgramPLCStep[] = [];
  private plcConfigUpdatedAt: number | null = null;
  private plcConfigFetchedAt = 0;
  private plcConfigFetchInFlight = false;

  constructor(options: TestProgramObserverOptions = {}) {
    super();
    this.formalBackendUrl = trimUrl(options.formalBackendUrl ?? process.env.FORMAL_BACKEND_URL ?? 'http://127.0.0.1:3003');
    this.formalBackendWsUrl = trimUrl(options.formalBackendWsUrl ?? process.env.FORMAL_BACKEND_WS_URL ?? wsUrlFromHttp(this.formalBackendUrl));
    this.pollIntervalMs = Math.max(250, Math.floor(options.pollIntervalMs ?? (Number(process.env.TEST_PROGRAM_POLL_INTERVAL_MS) || 1_000)));
    this.reconnectIntervalMs = Math.max(250, Math.floor(options.reconnectIntervalMs ?? 1_000));
    this.completionFlushDelayMs = Math.max(50, Math.floor(options.completionFlushDelayMs ?? 350));
    this.archiveStore = options.archiveStore ?? new TestProgramArchiveStore();
    this.planConfigFile = join(this.archiveStore.directory, 'test-program-config.json');
    const savedPlan = readSavedPlan(this.planConfigFile);
    this.tracker = options.tracker ?? new TestProgramTracker({
      formalBackendUrl: this.formalBackendUrl,
      plan: savedPlan?.plan ?? DEFAULT_TEST_PROGRAM_STAGE_PLAN,
    });
    if (options.tracker && savedPlan) this.tracker.setPlan(savedPlan.plan);
    if (savedPlan) {
      this.planSource = 'LOCAL_OVERRIDE';
      this.planUpdatedAt = savedPlan.updatedAt;
    }
    this.tracker.on('run_finalized', (run: TestProgramRun) => this.archiveRun(run));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tracker.setSourceConnection(false, 'FORMAL_BACKEND_WAITING');
    this.connectWebSocket();
    void this.refreshPLCConfiguration(true);
    void this.pollFormalBackend();
    this.pollTimer = setInterval(() => { void this.pollFormalBackend(); }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = null;
    const websocket = this.websocket;
    this.websocket = null;
    this.wsConnected = false;
    this.pollConnected = false;
    this.tracker.setSourceConnection(false, 'TEST_PROGRAM_STOPPED');
    if (websocket) {
      try { websocket.close(); } catch { /* already closed */ }
    }
  }

  snapshot(): TestProgramSnapshot {
    return this.tracker.snapshot();
  }

  configuration(): TestProgramConfigPayload {
    return {
      mode: 'test-program-readonly-observer',
      source: this.formalBackendUrl,
      plan: clonePlan(this.tracker.snapshot().plan),
      planSource: this.planSource,
      planUpdatedAt: this.planUpdatedAt,
      plcSteps: this.plcSteps.map((step) => ({ ...step })),
      plcConfigUpdatedAt: this.plcConfigUpdatedAt,
      note: 'PLC 步骤仅作只读参考；保存的规划只影响测试观察器下一轮归档，不向正式程序写入。',
    };
  }

  updatePlan(rawPlan: unknown): TestProgramConfigPayload {
    const plan = normalizeStagePlan(rawPlan);
    const updatedAt = Date.now();
    writeSavedPlan(this.planConfigFile, plan, updatedAt);
    this.tracker.setPlan(plan);
    this.planSource = 'LOCAL_OVERRIDE';
    this.planUpdatedAt = updatedAt;
    this.emitSnapshot();
    return this.configuration();
  }

  private async refreshPLCConfiguration(force = false): Promise<void> {
    if (!this.started || this.plcConfigFetchInFlight) return;
    const now = Date.now();
    if (!force && now - this.plcConfigFetchedAt < 5_000) return;
    this.plcConfigFetchInFlight = true;
    try {
      const payload = await this.fetchJson<FormalSystemConfigResponse>('/api/system-config');
      const config = payload?.config;
      const steps = normalizePLCSteps(config?.steps);
      this.plcSteps = steps;
      this.plcConfigUpdatedAt = numeric(config?.lastUpdated);
      this.plcConfigFetchedAt = Date.now();
      if (this.planSource !== 'LOCAL_OVERRIDE') {
        this.tracker.setPlan(derivePlanFromPLCSteps(steps));
        this.planSource = steps.length > 0 ? 'PLC_REFERENCE' : 'DEFAULT';
      }
      this.emitSnapshot();
    } catch {
      // The formal configuration is optional reference data. Polling and WS
      // status remain authoritative when the endpoint is unavailable.
    } finally {
      this.plcConfigFetchInFlight = false;
    }
  }

  private connectWebSocket(): void {
    if (!this.started || this.websocket || this.reconnectTimer) return;
    let websocket: WebSocket;
    try {
      websocket = new WebSocket(this.formalBackendWsUrl);
    } catch (error) {
      this.handleSourceFailure(error);
      this.scheduleReconnect();
      return;
    }
    this.websocket = websocket;
    websocket.on('open', () => {
      if (this.websocket !== websocket) return;
      this.wsConnected = true;
      this.updateSourceConnection();
      this.emitSnapshot();
      void this.pollFormalBackend();
    });
    websocket.on('message', (data) => {
      if (this.websocket !== websocket) return;
      this.handleFormalMessage(data.toString());
    });
    websocket.on('error', (error) => {
      if (this.websocket !== websocket) return;
      this.handleSourceFailure(error);
    });
    websocket.on('close', () => {
      if (this.websocket !== websocket) return;
      this.websocket = null;
      this.wsConnected = false;
      this.updateSourceConnection();
      this.emitSnapshot();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, this.reconnectIntervalMs);
    this.reconnectTimer.unref?.();
  }

  private handleFormalMessage(text: string): void {
    let message: { type?: string; payload?: unknown; timestamp?: number };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      this.handleSourceFailure('FORMAL_WS_MESSAGE_INVALID_JSON');
      return;
    }
    this.tracker.markSourceSeen(Number(message.timestamp) || Date.now());
    switch (message.type) {
      case 'plc_process_status':
        this.tracker.observeProcess(message.payload as PLCProcessStatus);
        this.scheduleCompletionFlush();
        this.emitSnapshot();
        break;
      case 'flame_state':
        this.tracker.observeFlameState(message.payload as FlameDetectorState);
        // Formal field status broadcasts the summary alongside detector state;
        // avoid pushing the full raw history on every waveform packet.
        break;
      case 'flame_waveform_delta':
        this.tracker.observeWaveformDelta(message.payload as FlameDetectorWaveformDelta);
        break;
      case 'field_summary':
        this.tracker.observeSummary(message.payload as TestProgramFormalSummary);
        this.emitSnapshot();
        break;
      case 'error':
        this.handleSourceFailure((message.payload as { error?: string })?.error ?? 'FORMAL_BACKEND_ERROR');
        break;
      default:
        break;
    }
  }

  private async pollFormalBackend(): Promise<void> {
    if (!this.started) return;
    try {
      const summary = await this.fetchJson<TestProgramFormalSummary>('/api/field/summary');
      this.tracker.markPoll(Date.now());
      this.tracker.observeSummary(summary);
      this.pollConnected = true;
      const devices = await this.fetchJson<FlameDetectorState>('/api/flame/devices');
      this.tracker.observeFlameState(devices);
      void this.refreshPLCConfiguration();
      this.updateSourceConnection();
      this.emitSnapshot();
    } catch (error) {
      this.pollConnected = false;
      this.handleSourceFailure(error);
      this.updateSourceConnection();
      this.emitSnapshot();
    }
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.formalBackendUrl}${path}`, {
      signal: AbortSignal.timeout(Math.min(5_000, Math.max(1_000, this.pollIntervalMs))),
    });
    if (!response.ok) throw new Error(`FORMAL_BACKEND_HTTP_${response.status}`);
    return response.json() as Promise<T>;
  }

  private handleSourceFailure(error: unknown): void {
    const message = sourceError(error);
    if (!this.wsConnected && !this.pollConnected) this.tracker.setSourceConnection(false, message);
    this.emit('source_error', message);
  }

  private updateSourceConnection(): void {
    if (this.wsConnected || this.pollConnected) this.tracker.setSourceConnection(true);
    else this.tracker.setSourceConnection(false, this.tracker.snapshot().source.lastError ?? 'FORMAL_BACKEND_DISCONNECTED');
  }

  private scheduleCompletionFlush(): void {
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      this.tracker.completePending();
    }, this.completionFlushDelayMs);
    this.completionTimer.unref?.();
  }

  private archiveRun(run: TestProgramRun): void {
    try {
      const archive = this.archiveStore.store(run);
      this.emit('archive', archive);
      this.emitSnapshot();
    } catch (error) {
      this.emit('archive_error', sourceError(error));
    }
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot());
  }
}
