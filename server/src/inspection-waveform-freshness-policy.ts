import { PLCProcessMonitor } from './plc-process-monitor.js';
import { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
import type { PLCProcessStatus } from './process-status.js';
import type { FlameDetectorState } from './types.js';

const PATCHED = Symbol.for('inspection-waveform-freshness-policy-patched-v2');
const STALE_FOR_ANALYSIS_MS = 1_500;
const STAGE_GATE_WARN_MS = 2_000;

type InternalService = Record<PropertyKey, any>;
type InternalMonitor = Record<PropertyKey, any>;

interface StageFreshnessGate {
  stage: string;
  startedAt: number;
  baseline: Map<number, number>;
  pending: Set<number>;
  warned: boolean;
}

const activeServices = new Set<ProductAwareFlameDetectorService>();
const previousStatusByMonitor = new WeakMap<object, PLCProcessStatus>();
const stageGateByService = new WeakMap<object, StageFreshnessGate>();

function stageStarts(previous: PLCProcessStatus | undefined, current: PLCProcessStatus): string[] {
  const result: string[] = [];
  if (current.io?.steps?.stepM10_4 === true && previous?.io?.steps?.stepM10_4 !== true) result.push('heat');
  if (current.processStage === 'FLASH' && previous?.processStage !== 'FLASH') result.push('flash');
  if (current.processStage === 'EMC' && previous?.processStage !== 'EMC') result.push('emc');
  return result;
}

function beginPassiveStageGate(service: ProductAwareFlameDetectorService, stage: string): void {
  const internal = service as unknown as InternalService;
  const indexes = service.enabledDetectorIndexes();
  if (indexes.length === 0) return;

  const baseline = new Map<number, number>();
  for (const index of indexes) baseline.set(index, Number(internal.lastPushAt?.get?.(index) ?? 0));
  stageGateByService.set(service, {
    stage,
    startedAt: Date.now(),
    baseline,
    pending: new Set(indexes),
    warned: false,
  });

  console.log(
    `[工序波形门控][${stage}] 已建立被动新鲜帧门：不重发模式、不停止物理推流；`
    + `仅要求 ${indexes.map((index) => `D${index}`).join(',')} 在工序开始后各收到至少一帧新数据。`,
  );
}

function sanitizeStageFreshness(
  service: ProductAwareFlameDetectorService,
  state: FlameDetectorState,
): FlameDetectorState {
  const internal = service as unknown as InternalService;
  const gate = stageGateByService.get(service);
  const now = Number(state.timestamp) || Date.now();
  let changed = false;

  const units = state.units.map((unit) => {
    const lastPushAt = Number(internal.lastPushAt?.get?.(unit.index) ?? unit.lastUpdate ?? 0);
    const age = lastPushAt > 0 ? Math.max(0, now - lastPushAt) : Number.POSITIVE_INFINITY;

    if (gate?.pending.has(unit.index)) {
      const before = gate.baseline.get(unit.index) ?? 0;
      if (lastPushAt > before && age <= STALE_FOR_ANALYSIS_MS && unit.sourceReady && unit.syncOk) {
        gate.pending.delete(unit.index);
      }
    }

    const waitingForFreshStageFrame = gate?.pending.has(unit.index) === true;
    const stale = unit.online && age > STALE_FOR_ANALYSIS_MS;
    if (!waitingForFreshStageFrame && !stale) return unit;

    changed = true;
    return {
      ...unit,
      sourceReady: false,
      syncOk: false,
      lastError: waitingForFreshStageFrame
        ? `工序 ${gate?.stage ?? '-'} 等待工序开始后的新鲜帧`
        : `波形超过 ${STALE_FOR_ANALYSIS_MS}ms 未更新，等待新鲜帧`,
    };
  });

  if (gate) {
    if (gate.pending.size === 0) {
      console.log(`[工序波形门控][${gate.stage}] D1~D6 均收到工序开始后的新鲜帧，耗时 ${Date.now() - gate.startedAt}ms；开放定量采样。`);
      stageGateByService.delete(service);
    } else if (!gate.warned && Date.now() - gate.startedAt >= STAGE_GATE_WARN_MS) {
      gate.warned = true;
      console.warn(
        `[工序波形门控][${gate.stage}] ${STAGE_GATE_WARN_MS}ms 内仍有 `
        + `${[...gate.pending].map((index) => `D${index}`).join(',')} 未形成新鲜帧；`
        + '保持分析门关闭，交由原 10s 波形看门狗恢复，不主动打断其余正常推流。',
      );
    }
  }

  return changed ? { ...state, units } : state;
}

function patchRuntime(): void {
  const serviceProto = ProductAwareFlameDetectorService.prototype as unknown as InternalService;
  if (serviceProto[PATCHED]) return;
  serviceProto[PATCHED] = true;

  const originalConnect = serviceProto.connect;
  serviceProto.connect = async function connectWithInspectionRegistration(this: ProductAwareFlameDetectorService, ...args: unknown[]) {
    activeServices.add(this);
    return originalConnect.apply(this, args);
  };

  const originalDisconnect = serviceProto.disconnect;
  serviceProto.disconnect = async function disconnectWithInspectionRegistration(this: ProductAwareFlameDetectorService, ...args: unknown[]) {
    activeServices.delete(this);
    stageGateByService.delete(this);
    return originalDisconnect.apply(this, args);
  };

  const originalEmit = serviceProto.emit;
  serviceProto.emit = function emitWithFreshnessTruth(this: ProductAwareFlameDetectorService, eventName: string | symbol, ...args: any[]) {
    if (eventName === 'flame_state' && args[0]?.units) {
      args[0] = sanitizeStageFreshness(this, args[0] as FlameDetectorState);
    }
    return originalEmit.call(this, eventName, ...args);
  };

  const monitorProto = PLCProcessMonitor.prototype as unknown as InternalMonitor;
  const originalMonitorEmit = monitorProto.emit;
  monitorProto.emit = function emitWithStageFreshness(this: object, eventName: string | symbol, ...args: any[]) {
    if (eventName === 'status' && args[0]) {
      const current = args[0] as PLCProcessStatus;
      const previous = previousStatusByMonitor.get(this);
      const starts = stageStarts(previous, current);
      previousStatusByMonitor.set(this, current);
      for (const stage of starts) {
        for (const service of activeServices) beginPassiveStageGate(service, stage);
      }
    }
    return originalMonitorEmit.call(this, eventName, ...args);
  };
}

patchRuntime();

export {};
