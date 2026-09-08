import { FlameDetectorService } from './flame-detector-service.js';
import type { FlameDetectorClient } from './flame-detector-device.js';
import type { FlameUnitConfig } from '../config.js';

const PATCHED = Symbol.for('flame-detector-waveform-control-window-patched');
const CONTROL_DEPTH = Symbol.for('flame-detector-waveform-control-window-depth');
const CONTROL_LABEL = Symbol.for('flame-detector-waveform-control-window-label');

type InternalService = Record<PropertyKey, any>;

function internalOf(service: FlameDetectorService): InternalService {
  return service as unknown as InternalService;
}

function pauseDepth(service: InternalService): number {
  return Number(service[CONTROL_DEPTH] ?? 0);
}

function currentTarget(service: InternalService, detectorIndex: number): { unit: FlameUnitConfig; client: FlameDetectorClient } | null {
  const unit = (service.config?.units as FlameUnitConfig[] | undefined)?.find((item) => item.index === detectorIndex && item.enabled);
  const device = service.devices?.get?.(detectorIndex);
  if (!unit || !device) return null;
  for (const entry of service.pool?.values?.() ?? []) {
    if (entry?.ok && entry.client && device.isUsingClient?.(entry.client)) {
      return { unit, client: entry.client as FlameDetectorClient };
    }
  }
  return null;
}

function clearWatchdogTimers(service: InternalService): void {
  for (const timer of service.waveformWatchdogTimers?.values?.() ?? []) clearTimeout(timer);
  service.waveformWatchdogTimers?.clear?.();
}

function clearModeRetryTimers(service: InternalService): void {
  for (const timer of service.broadcastModeRetryTimers?.values?.() ?? []) clearTimeout(timer);
  service.broadcastModeRetryTimers?.clear?.();
}

function patchRuntime(): void {
  const proto = FlameDetectorService.prototype as unknown as InternalService;
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

  const originalScheduleWatchdog = proto.scheduleWaveformWatchdog;
  if (typeof originalScheduleWatchdog === 'function') {
    proto.scheduleWaveformWatchdog = function patchedScheduleWaveformWatchdog(this: InternalService, ...args: unknown[]) {
      if (pauseDepth(this) > 0) return;
      return originalScheduleWatchdog.apply(this, args);
    };
  }

  const originalHandleStale = proto.handleWaveformStale;
  if (typeof originalHandleStale === 'function') {
    proto.handleWaveformStale = function patchedHandleWaveformStale(this: InternalService, ...args: unknown[]) {
      if (pauseDepth(this) > 0) return;
      return originalHandleStale.apply(this, args);
    };
  }

  const originalScheduleModeRetry = proto.scheduleBroadcastModeRetry;
  if (typeof originalScheduleModeRetry === 'function') {
    proto.scheduleBroadcastModeRetry = function patchedScheduleBroadcastModeRetry(this: InternalService, ...args: unknown[]) {
      if (pauseDepth(this) > 0) return;
      return originalScheduleModeRetry.apply(this, args);
    };
  }
}

patchRuntime();

/**
 * 继电器/版本等控制命令与实时波形共用同一条原始 TCP/RTU 通道。
 * 控制窗口期间只暂停“自动恢复动作”，不关闭 socket、不清空历史，也不停止
 * 探测器已经存在的物理推流，避免 stale watchdog 在 FC03/FC10/F000 期间插入 FF 模式帧。
 */
export function pauseWaveformRecoveryForControlWindow(
  service: FlameDetectorService,
  label = 'product-precheck',
): void {
  const internal = internalOf(service);
  const depth = pauseDepth(internal) + 1;
  internal[CONTROL_DEPTH] = depth;
  internal[CONTROL_LABEL] = label;
  if (depth > 1) return;

  clearWatchdogTimers(internal);
  clearModeRetryTimers(internal);
  for (const unit of (internal.config?.units as FlameUnitConfig[] | undefined) ?? []) {
    if (!unit.enabled) continue;
    try { internal.stopBroadcastModeRequests?.(unit.index); } catch { /* best effort */ }
  }
  console.log(`[FlameService][ControlWindow] ${label} 开始：暂停波形 stale watchdog/FF 自动重试，保留 TCP 与物理推流。`);
}

/**
 * 控制窗口结束后统一重新发送一次模式 1（或当前配置的波形模式），并要求每个
 * 参与槽位在该次模式请求之后至少形成一帧新的有效波形。全部恢复前调用方不得
 * 开始噪声定量窗口；超时直接抛错，由正式流程阻止继续判定。
 */
export async function resumeAndRecoverWaveformAfterControlWindow(
  service: FlameDetectorService,
  detectorIndexes: number[],
  timeoutMs = 15_000,
): Promise<void> {
  const internal = internalOf(service);
  const depth = pauseDepth(internal);
  if (depth <= 0) return;
  if (depth > 1) {
    internal[CONTROL_DEPTH] = depth - 1;
    return;
  }

  internal[CONTROL_DEPTH] = 0;
  const label = String(internal[CONTROL_LABEL] ?? 'product-precheck');
  internal[CONTROL_LABEL] = '';
  clearWatchdogTimers(internal);
  clearModeRetryTimers(internal);

  const indexes = [...new Set(detectorIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= 6)
    .sort((a, b) => a - b);
  const targets = indexes.map((index) => ({ index, target: currentTarget(internal, index) }));
  const missing = targets.filter((item) => !item.target).map((item) => item.index);
  if (missing.length > 0) {
    throw new Error(`WAVEFORM_RECOVERY_TARGET_MISSING:${missing.map((index) => `D${index}`).join(',')}`);
  }

  console.log(`[FlameService][ControlWindow] ${label} 结束：统一重新进入波形模式并等待 D1~D6 新鲜首帧。`);
  const baseline = new Map<number, number>();

  await Promise.all(targets.map(async ({ index, target }) => {
    const { unit, client } = target!;
    try { internal.stopBroadcastModeRequests?.(index); } catch { /* best effort */ }
    internal.broadcastModeRequestingUnits?.add?.(index);
    internal.broadcastModeRetryAttempts?.set?.(index, 0);

    const state = internal.units?.get?.(index);
    if (state) {
      state.sourceReady = false;
      state.syncOk = false;
      state.lastError = '控制窗口结束，等待新的有效波形';
      internal.units.set(index, state);
    }

    try {
      await internal.sendBroadcastModeRequest(unit, client);
    } catch (error) {
      console.warn(`[FlameService][ControlWindow] D${index} 模式恢复请求异常，继续等待看门狗恢复: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 必须是模式请求完成之后的下一帧，不能把控制窗口末尾残留的一帧误判为恢复成功。
    baseline.set(index, Number(internal.lastPushAt?.get?.(index) ?? 0));
  }));

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, timeoutMs);
  while (Date.now() <= deadline) {
    const pending = indexes.filter((index) => {
      const before = baseline.get(index) ?? 0;
      const after = Number(internal.lastPushAt?.get?.(index) ?? 0);
      const state = internal.units?.get?.(index);
      return !(after > before && state?.sourceReady === true && state?.syncOk === true);
    });
    if (pending.length === 0) {
      const latency = Date.now() - startedAt;
      console.log(`[FlameService][ControlWindow] 波形恢复完成：${indexes.map((index) => `D${index}`).join(',')} 均收到新有效帧，耗时 ${latency}ms。`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const pending = indexes.filter((index) => {
    const before = baseline.get(index) ?? 0;
    const after = Number(internal.lastPushAt?.get?.(index) ?? 0);
    const state = internal.units?.get?.(index);
    return !(after > before && state?.sourceReady === true && state?.syncOk === true);
  });
  throw new Error(`WAVEFORM_RECOVERY_TIMEOUT:${pending.map((index) => `D${index}`).join(',')}`);
}
