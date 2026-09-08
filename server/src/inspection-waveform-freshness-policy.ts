import { PLCProcessMonitor } from './plc-process-monitor.js';
import { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
import type { PLCProcessStatus } from './process-status.js';
import type { FlameDetectorState } from './types.js';
import {
  pauseWaveformRecoveryForControlWindow,
  resumeAndRecoverWaveformAfterControlWindow,
} from './modbus/flame-detector-waveform-control-window.js';

const PATCHED = Symbol.for('inspection-waveform-freshness-policy-patched');
const STALE_FOR_ANALYSIS_MS = 1_500;
const RECOVERY_TIMEOUT_MS = 15_000;
const POST_RECOVERY_GUARD_MS = 500;
const PRECHECK_WAIT_LIMIT_MS = 20_000;

type InternalService = Record<PropertyKey, any>;
type InternalMonitor = Record<PropertyKey, any>;

const activeServices = new Set<ProductAwareFlameDetectorService>();
const previousStatusByMonitor = new WeakMap<object, PLCProcessStatus>();
const recoveryQueue = new WeakMap<object, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stageStarts(previous: PLCProcessStatus | undefined, current: PLCProcessStatus): string[] {
  const result: string[] = [];
  if (current.io?.steps?.stepM10_4 === true && previous?.io?.steps?.stepM10_4 !== true) result.push('heat');
  if (current.io?.steps?.stepM11_0 === true && previous?.io?.steps?.stepM11_0 !== true) result.push('flash');
  if (current.io?.steps?.stepM11_2 === true && previous?.io?.steps?.stepM11_2 !== true) result.push('emc');
  return result;
}

async function waitForPrecheckGate(service: ProductAwareFlameDetectorService): Promise<void> {
  const internal = service as unknown as InternalService;
  const deadline = Date.now() + PRECHECK_WAIT_LIMIT_MS;
  while (internal.precheckAnalysisBlocked === true && Date.now() < deadline) await sleep(50);
  if (internal.precheckAnalysisBlocked === true) {
    throw new Error('PRECHECK_ANALYSIS_GATE_TIMEOUT');
  }
}

async function recoverForStage(service: ProductAwareFlameDetectorService, stage: string): Promise<void> {
  await waitForPrecheckGate(service);
  const internal = service as unknown as InternalService;
  const indexes = service.enabledDetectorIndexes();
  if (indexes.length === 0) return;

  internal.precheckAnalysisBlocked = true;
  internal.precheckAnalysisRecoveryUntil = 0;
  service.clearWaveformHistory();
  pauseWaveformRecoveryForControlWindow(service, `inspection-stage:${stage}`);
  const startedAt = Date.now();

  try {
    console.log(`[工序波形门控][${stage}] 已清历史并暂停定量采样，重新进入模式1，等待 ${indexes.map((index) => `D${index}`).join(',')} 新鲜首帧。`);
    await resumeAndRecoverWaveformAfterControlWindow(service, indexes, RECOVERY_TIMEOUT_MS);
    console.log(`[工序波形门控][${stage}] 新鲜波形恢复完成，耗时 ${Date.now() - startedAt}ms；保护 ${POST_RECOVERY_GUARD_MS}ms 后开放采样。`);
    internal.precheckAnalysisRecoveryUntil = Date.now() + POST_RECOVERY_GUARD_MS;
  } catch (error) {
    internal.precheckAnalysisRecoveryUntil = Date.now() + 2_000;
    console.error(`[工序波形门控][${stage}] WAVEFORM_STAGE_RECOVERY_FAILED：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    internal.precheckAnalysisBlocked = false;
  }
}

function queueStageRecovery(service: ProductAwareFlameDetectorService, stage: string): void {
  const previous = recoveryQueue.get(service) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => recoverForStage(service, stage));
  recoveryQueue.set(service, next);
  void next.catch(() => undefined);
}

function sanitizeStaleState(state: FlameDetectorState): FlameDetectorState {
  const now = Number(state.timestamp) || Date.now();
  let changed = false;
  const units = state.units.map((unit) => {
    const age = Number.isFinite(unit.lastUpdate) && unit.lastUpdate > 0 ? Math.max(0, now - unit.lastUpdate) : Number.POSITIVE_INFINITY;
    if (!unit.online || age <= STALE_FOR_ANALYSIS_MS) return unit;
    changed = true;
    return {
      ...unit,
      sourceReady: false,
      syncOk: false,
      lastError: `波形超过 ${STALE_FOR_ANALYSIS_MS}ms 未更新，等待新鲜帧`,
    };
  });
  return changed ? { ...state, units } : state;
}

function patchRuntime(): void {
  const serviceProto = ProductAwareFlameDetectorService.prototype as unknown as InternalService;
  if (serviceProto[PATCHED]) return;
  serviceProto[PATCHED] = true;

  const originalConnect = serviceProto.connect;
  serviceProto.connect = async function connectWithInspectionRecoveryRegistration(this: ProductAwareFlameDetectorService, ...args: unknown[]) {
    activeServices.add(this);
    return originalConnect.apply(this, args);
  };

  const originalEmit = serviceProto.emit;
  serviceProto.emit = function emitWithFreshnessTruth(this: ProductAwareFlameDetectorService, eventName: string | symbol, ...args: any[]) {
    if (eventName === 'flame_state' && args[0]?.units) args[0] = sanitizeStaleState(args[0] as FlameDetectorState);
    return originalEmit.call(this, eventName, ...args);
  };

  const monitorProto = PLCProcessMonitor.prototype as unknown as InternalMonitor;
  const originalMonitorEmit = monitorProto.emit;
  monitorProto.emit = function emitWithStageRecovery(this: object, eventName: string | symbol, ...args: any[]) {
    if (eventName === 'status' && args[0]) {
      const current = args[0] as PLCProcessStatus;
      const previous = previousStatusByMonitor.get(this);
      const starts = stageStarts(previous, current);
      previousStatusByMonitor.set(this, current);
      for (const stage of starts) {
        for (const service of activeServices) queueStageRecovery(service, stage);
      }
    }
    return originalMonitorEmit.call(this, eventName, ...args);
  };
}

patchRuntime();

export {};
