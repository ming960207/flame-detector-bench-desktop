import {
  relayFeedbackMappingFor,
  relayInputIsActive,
  type RelayActionResult,
  type RelayFunctionalTestConfig,
  type RelayFunctionalTestPhase,
  type RelayFunctionalTestPhaseEvent,
  type RelayFunctionalTestReport,
  type RelayFunctionalTestUnitResult,
} from './relay-functional-test.js';

export interface RelayDetectorPort {
  enabledDetectorIndexes(): number[];
  simulate(detectorIndex: number, state: { fire: boolean; fault: boolean }): Promise<void>;
  reset(detectorIndex: number): Promise<void>;
  readLatched(detectorIndex: number): Promise<{ fire: boolean; fault: boolean }>;
}

export interface RelayFeedbackSource {
  readInputs(): Record<string, boolean> | undefined | Promise<Record<string, boolean> | undefined>;
}

export type RelayFunctionalTestPhaseListener = (event: RelayFunctionalTestPhaseEvent) => void;

interface UnitWorkState {
  result: RelayFunctionalTestUnitResult;
  commandStartedAt: number | null;
  baselineLevels: {
    alarm: boolean | null;
    fault: boolean | null;
  };
  /** Last sampled DIO levels during each actuation, before the reset phase. */
  actionLevels: Record<'alarm' | 'fault', { alarm: boolean | null; fault: boolean | null } | null>;
}

const RELAY_COMMAND_MAX_ATTEMPTS = 3;
const RELAY_COMMAND_RETRY_DELAY_MS = 80;
const RELAY_SIMULATION_BURST_COUNT = 3;
export const RELAY_SIMULATION_BURST_INTERVAL_MS = 100;
// UVC samples every 240 ms and needs two frames. Keep the confirmed alarm
// active long enough for phase delivery, camera exposure and stable evidence.
export const ALARM_INDICATOR_OBSERVATION_MS = 1000;
const RELAY_READ_MAX_ATTEMPTS = 3;
const RELAY_READ_RETRY_DELAY_MS = 80;

function emptyAction(): RelayActionResult {
  return {
    commandAccepted: false,
    internalStateReached: false,
    physicalStateReached: false,
    oppositeRelayStayedNormal: true,
    responseTimeMs: null,
    resetAccepted: false,
    internalRecovered: false,
    physicalRecovered: false,
    verdict: 'PENDING',
    reasons: [],
  };
}

function emptyUnit(index: number): RelayFunctionalTestUnitResult {
  return {
    detectorIndex: index,
    enabled: true,
    baseline: {
      alarmInternal: null,
      faultInternal: null,
      alarmPhysical: null,
      faultPhysical: null,
    },
    alarm: emptyAction(),
    fault: emptyAction(),
    verdict: 'PENDING',
  };
}

function uniquePush(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 继电器功能检测协调器。
 *
 * 生产检测按功能分阶段执行：6 台并行火警 -> 复位 -> 6 台并行故障 -> 复位。
 * 模拟和复位命令使用有限重试，以吸收现场偶发的单次通讯失败。
 *
 * 判定原则：探测器继电器是否动作，只以该继电器对应的真实 DIO 反馈源为准。
 * 正式功能判定以测试开始时读取到的 DIO 原始电平作为每路触点基线：动作必须相对
 * 基线稳定翻转，复位必须稳定回到基线。这样 NO/NC 或现场反相接法不会因为静态
 * alarmNormalLevel/faultNormalLevel 配置不一致而被误判；配置极性只保留给诊断/UI。
 * 探测器内部火警/故障锁存和另一只继电器反馈只作为诊断信息记录，不参与当前继电器
 * 的 PASS/FAIL。火警动作只验证火警反馈，故障动作只验证故障反馈；复位同理。
 */
export class RelayFunctionalTestCoordinator {
  constructor(
    private readonly detectors: RelayDetectorPort,
    private readonly feedback: RelayFeedbackSource,
    private readonly config: RelayFunctionalTestConfig,
    private readonly onPhase?: RelayFunctionalTestPhaseListener,
  ) {}

  private emitPhase(phase: RelayFunctionalTestPhase, work: Map<number, UnitWorkState>): void {
    this.onPhase?.({
      phase,
      detectorIndexes: [...work.keys()],
      timestamp: Date.now(),
    });
  }

  private async detectorCommandWithRetry(operation: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= RELAY_COMMAND_MAX_ATTEMPTS; attempt += 1) {
      try {
        await operation();
        return true;
      } catch {
        if (attempt >= RELAY_COMMAND_MAX_ATTEMPTS) return false;
        await sleep(RELAY_COMMAND_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private async detectorSimulationBurst(
    operation: () => Promise<void>,
    onWrite?: (success: boolean) => void,
  ): Promise<boolean> {
    let accepted = false;
    for (let attempt = 1; attempt <= RELAY_SIMULATION_BURST_COUNT; attempt += 1) {
      try {
        await operation();
        accepted = true;
        onWrite?.(true);
      } catch {
        onWrite?.(false);
        // Simulation commands are idempotent; keep sending the remaining frames.
      }
      if (attempt < RELAY_SIMULATION_BURST_COUNT) await sleep(RELAY_SIMULATION_BURST_INTERVAL_MS);
    }
    return accepted;
  }

  private async detectorReadWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RELAY_READ_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < RELAY_READ_MAX_ATTEMPTS) await sleep(RELAY_READ_RETRY_DELAY_MS);
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(String(lastError ?? 'RELAY_READ_FAILED'));
  }

  private async diagnosticInternalState(index: number): Promise<{ fire: boolean; fault: boolean } | null> {
    // Production sampling must not enqueue diagnostic reads on detector command
    // links: one slow link would consume the shared DIO confirmation window.
    if (this.config.mode === 'FAST_BATCH') return null;
    try {
      return await this.detectorReadWithRetry(() => this.detectors.readLatched(index));
    } catch {
      return null;
    }
  }

  private async withinDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('relay sampling deadline exceeded'), { code: 'DIO_READ_TIMEOUT' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('relay sampling deadline exceeded'), { code: 'DIO_READ_TIMEOUT' })), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readFeedback(deadline: number): Promise<Record<string, boolean> | undefined> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RELAY_READ_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.withinDeadline(() => Promise.resolve(this.feedback.readInputs()), deadline);
      } catch (error) {
        lastError = error;
        const remaining = deadline - Date.now();
        if (attempt === RELAY_READ_MAX_ATTEMPTS || remaining <= 0) break;
        await sleep(Math.min(RELAY_READ_RETRY_DELAY_MS, remaining));
      }
    }
    throw lastError;
  }

  private sharedSample(deadline: number): () => Promise<Record<string, boolean> | undefined> {
    let sample: Promise<Record<string, boolean> | undefined> | undefined;
    return () => sample ??= this.readFeedback(deadline);
  }

  private async physicalState(index: number, sample: () => Promise<Record<string, boolean> | undefined>): Promise<{
    alarm: boolean | null;
    fault: boolean | null;
    rawAlarm: boolean | null;
    rawFault: boolean | null;
    error?: string;
  }> {
    const mapping = relayFeedbackMappingFor(this.config, index);
    let inputs: Record<string, boolean> | undefined;
    try {
      inputs = await sample();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error ? error.message : String(error);
      return { alarm: null, fault: null, rawAlarm: null, rawFault: null, error: code || 'DIO_READ_FAILED' };
    }
    if (!mapping || !inputs) return { alarm: null, fault: null, rawAlarm: null, rawFault: null, error: 'DIO_RESPONSE_INVALID' };
    const alarmLevel = inputs[mapping.alarmInputAddress];
    const faultLevel = inputs[mapping.faultInputAddress];
    const rawAlarm = typeof alarmLevel === 'boolean' ? alarmLevel : null;
    const rawFault = typeof faultLevel === 'boolean' ? faultLevel : null;
    if (rawAlarm === null || rawFault === null) return { alarm: null, fault: null, rawAlarm, rawFault, error: 'DIO_RESPONSE_INVALID' };
    return {
      alarm: relayInputIsActive(alarmLevel, mapping.alarmNormalLevel),
      fault: relayInputIsActive(faultLevel, mapping.faultNormalLevel),
      rawAlarm,
      rawFault,
    };
  }

  private async readBaseline(work: Map<number, UnitWorkState>): Promise<void> {
    // One PLC pass, but up to two independent DIO baseline snapshots. The
    // underlying readFeedback already retries its Modbus transaction; a fresh
    // snapshot also recovers from an exhausted transient timeout. Never simulate
    // a relay until a complete, trustworthy baseline has been observed.
    const pending = new Set(work.keys());
    const lastErrors = new Map<number, string>();
    for (let attempt = 0; attempt < 2 && pending.size > 0; attempt += 1) {
      if (attempt > 0) await sleep(RELAY_READ_RETRY_DELAY_MS);
      const sample = this.sharedSample(Date.now() + this.config.dio.requestTimeoutMs);
      await Promise.all([...work.entries()].filter(([index]) => pending.has(index)).map(async ([index, state]) => {
        const [internal, physical] = await Promise.all([
          this.diagnosticInternalState(index),
          this.physicalState(index, sample),
        ]);
        if (physical.error || physical.rawAlarm === null || physical.rawFault === null) {
          lastErrors.set(index, physical.error ?? 'DIO_RESPONSE_INVALID');
          return;
        }
        lastErrors.delete(index);
        pending.delete(index);
        state.baselineLevels = { alarm: physical.rawAlarm, fault: physical.rawFault };
        state.result.baseline = {
          alarmInternal: internal?.fire ?? null,
          faultInternal: internal?.fault ?? null,
          alarmPhysical: physical.alarm,
          faultPhysical: physical.fault,
        };
        // An already-energized contact is NOT a transient read failure. Do
        // not reset/energize it blindly to manufacture a passing transition.
        if (physical.alarm === true || physical.fault === true) {
          uniquePush(state.result.alarm.reasons, 'RELAY_BASELINE_NOT_NORMAL');
          uniquePush(state.result.fault.reasons, 'RELAY_BASELINE_NOT_NORMAL');
        }
      }));
    }
    for (const index of pending) {
      const state = work.get(index)!;
      const reason = `RELAY_FEEDBACK_READ_FAILED:${lastErrors.get(index) ?? 'DIO_RESPONSE_INVALID'}`;
      uniquePush(state.result.alarm.reasons, reason);
      uniquePush(state.result.fault.reasons, reason);
    }
  }

  private async sendCommand(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const action = state.result[kind];
      // Never issue blind simulation to a detector without trustworthy DIO
      // baseline feedback. The remaining stations continue in parallel.
      if (action.reasons.includes('RELAY_BASELINE_NOT_NORMAL')
        || action.reasons.includes('RELAY_BASELINE_READ_FAILED')
        || action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'))) return;
      state.commandStartedAt = Date.now();
      const accepted = await this.detectorSimulationBurst(
        () => this.detectors.simulate(index, kind === 'alarm'
          ? { fire: true, fault: false }
          : { fire: false, fault: true }),
        (success) => {
          action.commandWriteAttempts = (action.commandWriteAttempts ?? 0) + 1;
          if (success) action.commandWriteAccepted = (action.commandWriteAccepted ?? 0) + 1;
        },
      );
      if (accepted) action.commandAccepted = true;
      else uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_COMMAND_FAILED' : 'FAULT_COMMAND_FAILED');
    }));
  }

  private async waitForAction(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    let deadline = Date.now() + this.config.feedbackTimeoutMs;
    // A slow but awaited rescue write must leave enough wall-clock time for
    // physical DIO stable samples. Extend *confirmation only*, bounded by
    // one extra second; do not issue more than one rescue or rerun the PLC.
    const hardDeadline = deadline + Math.min(1000,
      this.config.stableSamples * this.config.sampleIntervalMs + this.config.sampleIntervalMs);
    const stable = new Map<number, number>();
    const feedbackErrors = new Map<number, string>();
    const retried = new Set<number>();
    const retryAt = deadline - this.config.feedbackTimeoutMs / 2;
    const confirmationReserveMs = this.config.stableSamples * this.config.sampleIntervalMs;

    while (Date.now() < deadline) {
      // All six contacts use one fresh DIO snapshot per round, including retries.
      const sample = this.sharedSample(deadline);
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.commandAccepted) return;
        if (action.physicalStateReached && (stable.get(index) ?? 0) >= this.config.stableSamples) return;

        const [internal, physical] = await Promise.all([
          this.diagnosticInternalState(index),
          this.physicalState(index, sample),
        ]);
        if (physical.error) {
          feedbackErrors.set(index, physical.error);
          stable.set(index, 0);
          return;
        }
        feedbackErrors.delete(index);
        state.actionLevels[kind] = { alarm: physical.rawAlarm, fault: physical.rawFault };

        const ownPhysical = kind === 'alarm' ? physical.alarm : physical.fault;
        const oppositePhysical = kind === 'alarm' ? physical.fault : physical.alarm;
        const ownLevel = kind === 'alarm' ? physical.rawAlarm : physical.rawFault;
        const oppositeLevel = kind === 'alarm' ? physical.rawFault : physical.rawAlarm;
        const ownBaseline = kind === 'alarm' ? state.baselineLevels.alarm : state.baselineLevels.fault;
        const oppositeBaseline = kind === 'alarm' ? state.baselineLevels.fault : state.baselineLevels.alarm;
        const internalReached = internal === null
          ? false
          : kind === 'alarm'
            ? internal.fire === true && internal.fault === false
            : internal.fire === false && internal.fault === true;

        const ownTransitioned = ownLevel !== null && ownBaseline !== null
          ? ownLevel !== ownBaseline
          : ownPhysical === true;
        const oppositeStayedBaseline = oppositeLevel !== null && oppositeBaseline !== null
          ? oppositeLevel === oppositeBaseline
          : oppositePhysical !== true;

        // These two fields remain diagnostic only and never gate the relay verdict.
        action.internalStateReached ||= internalReached;
        action.oppositeRelayStayedNormal &&= oppositeStayedBaseline;

        if (ownTransitioned) {
          const next = (stable.get(index) ?? 0) + 1;
          stable.set(index, next);
          if (next >= this.config.stableSamples) {
            action.physicalStateReached = true;
            action.physicalConfirmedAt ??= Date.now();
            if (action.responseTimeMs === null) {
              action.responseTimeMs = Math.max(0, Date.now() - (state.commandStartedAt ?? Date.now()));
            }
          }
        } else {
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const action = state.result[kind];
        return !action.commandAccepted
          || (action.physicalStateReached && (stable.get(index) ?? 0) >= this.config.stableSamples);
      });
      if (done) break;
      let rescueAttempted = false;
      if (Date.now() >= retryAt && Date.now() < deadline - confirmationReserveMs) {
        await Promise.all([...work.entries()].map(async ([index, state]) => {
          const action = state.result[kind];
          if (!action.commandAccepted || action.physicalStateReached || (stable.get(index) ?? 0) > 0
            || retried.has(index) || feedbackErrors.has(index)) return;
          retried.add(index);
          rescueAttempted = true;
          // One idempotent rescue frame only; keep the original baseline, stable
          // sample requirement and deadline. Never repeat the whole action cycle.
          action.commandWriteAttempts = (action.commandWriteAttempts ?? 0) + 1;
          action.rescueWriteAttempts = (action.rescueWriteAttempts ?? 0) + 1;
          try {
            // Never abandon an in-flight physical write with Promise.race:
            // it could remain queued and execute *after* the next reset phase.
            // Await the actual queued completion, even when the DIO deadline
            // is nearly exhausted; the next phase must not overtake it.
            await this.detectors.simulate(index, kind === 'alarm'
              ? { fire: true, fault: false }
              : { fire: false, fault: true });
            action.commandWriteAccepted = (action.commandWriteAccepted ?? 0) + 1;
          } catch {
            // The original command was accepted. Physical evidence remains the
            // authority, and lack of actuation still fails at the same deadline.
          }
        }));
      }
      // Only the physical confirmation deadline may extend: a write can finish
      // late, but the following reset must wait until it has actually settled.
      if (rescueAttempted) {
        deadline = Math.min(hardDeadline, Math.max(deadline,
          Date.now() + confirmationReserveMs + this.config.sampleIntervalMs));
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.config.sampleIntervalMs, remaining));
    }

    for (const state of work.values()) {
      const action = state.result[kind];
      if (!action.commandAccepted) continue;
      const feedbackError = feedbackErrors.get(state.result.detectorIndex);
      if (!action.physicalStateReached && feedbackError) uniquePush(action.reasons, `RELAY_FEEDBACK_READ_FAILED:${feedbackError}`);
      const feedbackReadFailed = action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'));
      if (!action.physicalStateReached && !feedbackReadFailed) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RELAY_NOT_ACTUATED' : 'FAULT_RELAY_NOT_ACTUATED');
      }
    }
  }

  private async resetBatch(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const action = state.result[kind];
      const accepted = await this.detectorCommandWithRetry(() => this.detectors.reset(index));
      if (accepted) action.resetAccepted = true;
      else uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RESET_COMMAND_FAILED' : 'FAULT_RESET_COMMAND_FAILED');
    }));
  }

  private async waitForReset(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    const deadline = Date.now() + this.config.resetTimeoutMs;
    const stable = new Map<number, number>();
    const feedbackErrors = new Map<number, string>();
    const retriedReset = new Set<number>();
    const retryAt = deadline - this.config.resetTimeoutMs / 2;
    const confirmationReserveMs = this.config.stableSamples * this.config.sampleIntervalMs;

    while (Date.now() < deadline) {
      const sample = this.sharedSample(deadline);
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.resetAccepted) return;
        if (action.physicalRecovered && (stable.get(index) ?? 0) >= this.config.stableSamples) return;

        const [internal, physical] = await Promise.all([
          this.diagnosticInternalState(index),
          this.physicalState(index, sample),
        ]);
        if (physical.error) {
          feedbackErrors.set(index, physical.error);
          stable.set(index, 0);
          return;
        }
        feedbackErrors.delete(index);

        const ownLevel = kind === 'alarm' ? physical.rawAlarm : physical.rawFault;
        const ownBaseline = kind === 'alarm' ? state.baselineLevels.alarm : state.baselineLevels.fault;
        const ownRecovered = ownLevel !== null && ownBaseline !== null
          ? ownLevel === ownBaseline
          : kind === 'alarm' ? physical.alarm === false : physical.fault === false;
        const internalRecovered = internal !== null && internal.fire === false && internal.fault === false;
        action.internalRecovered ||= internalRecovered;

        if (ownRecovered) {
          const next = (stable.get(index) ?? 0) + 1;
          stable.set(index, next);
          if (next >= this.config.stableSamples) {
            action.physicalRecovered = true;
            action.resetConfirmedAt ??= Date.now();
          }
        } else {
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const action = state.result[kind];
        return !action.resetAccepted
          || (action.physicalRecovered && (stable.get(index) ?? 0) >= this.config.stableSamples);
      });
      if (done) break;
      // A reset ACK (or local write completion) does not prove the contact
      // returned to normal. Reissue one idempotent reset only after a fresh DIO
      // snapshot showed no recovery and while stable confirmation still fits.
      // This is a rescue inside the same PLC pass, never a second test cycle.
      let rescueAttempted = false;
      if (Date.now() >= retryAt && Date.now() < deadline - confirmationReserveMs) {
        await Promise.all([...work.entries()].map(async ([index, state]) => {
          const action = state.result[kind];
          if (!action.resetAccepted || action.physicalRecovered || (stable.get(index) ?? 0) > 0
            || feedbackErrors.has(index) || retriedReset.has(index)) return;
          retriedReset.add(index);
          rescueAttempted = true;
          action.resetRescueWriteAttempts = (action.resetRescueWriteAttempts ?? 0) + 1;
          try {
            // Wait for the queued addressed F000 write AND its matching FC10
            // reply. A deadline-raced promise could execute in the next phase.
            await this.detectors.reset(index);
          } catch {
            // DIO physical recovery remains the final authority.
          }
        }));
      }
      if (rescueAttempted) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.config.sampleIntervalMs, remaining));
    }

    for (const state of work.values()) {
      const action = state.result[kind];
      if (!action.resetAccepted) continue;
      const feedbackError = feedbackErrors.get(state.result.detectorIndex);
      if (!action.physicalRecovered && feedbackError) uniquePush(action.reasons, `RELAY_FEEDBACK_READ_FAILED:${feedbackError}`);
      const feedbackReadFailed = action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'));
      if (!action.physicalRecovered && !feedbackReadFailed) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RELAY_STUCK_AFTER_RESET' : 'FAULT_RELAY_STUCK_AFTER_RESET');
      }
    }
  }

  private async runActionCycle(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    this.emitPhase(kind === 'alarm' ? 'ALARM_COMMAND' : 'FAULT_COMMAND', work);
    await this.sendCommand(work, kind);
    this.emitPhase(kind === 'alarm' ? 'ALARM_VERIFY' : 'FAULT_VERIFY', work);
    await this.waitForAction(work, kind);
    if (kind === 'alarm' && [...work.values()].some((state) => state.result.alarm.commandAccepted)) {
      await sleep(ALARM_INDICATOR_OBSERVATION_MS);
    }
    this.emitPhase(kind === 'alarm' ? 'ALARM_RESET' : 'FAULT_RESET', work);
    await this.resetBatch(work, kind);
    this.emitPhase(kind === 'alarm' ? 'ALARM_RESET_VERIFY' : 'FAULT_RESET_VERIFY', work);
    await this.waitForReset(work, kind);
  }

  private async runFastBatch(work: Map<number, UnitWorkState>): Promise<void> {
    await this.runActionCycle(work, 'alarm');
    await this.runActionCycle(work, 'fault');
  }

  private async runDiagnostic(work: Map<number, UnitWorkState>): Promise<void> {
    for (const [index, state] of work.entries()) {
      const single = new Map<number, UnitWorkState>([[index, state]]);
      await this.runActionCycle(single, 'alarm');
      await this.runActionCycle(single, 'fault');
    }
  }

  private addCleanupReason(state: UnitWorkState, reason: string): void {
    uniquePush(state.result.alarm.reasons, reason);
    uniquePush(state.result.fault.reasons, reason);
  }

  private async emergencyCleanup(work: Map<number, UnitWorkState>): Promise<void> {
    const resetAccepted = new Set<number>();
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const accepted = await this.detectorCommandWithRetry(() => this.detectors.reset(index));
      if (accepted) resetAccepted.add(index);
      else this.addCleanupReason(state, 'EMERGENCY_RESET_COMMAND_FAILED');
    }));

    const alarmStable = new Map<number, number>();
    const faultStable = new Map<number, number>();
    const alarmRecovered = new Set<number>();
    const faultRecovered = new Set<number>();
    const feedbackErrors = new Map<number, string>();
    const deadline = Date.now() + this.config.resetTimeoutMs;

    while (Date.now() < deadline) {
      const sample = this.sharedSample(deadline);
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        if (!resetAccepted.has(index)) return;
        if (alarmRecovered.has(index) && faultRecovered.has(index)) return;

        const physical = await this.physicalState(index, sample);
        if (physical.error) {
          feedbackErrors.set(index, physical.error);
          alarmStable.set(index, 0);
          faultStable.set(index, 0);
          return;
        }
        feedbackErrors.delete(index);

        if (!alarmRecovered.has(index)) {
          const recovered = !state.result.alarm.reasons.includes('RELAY_BASELINE_NOT_NORMAL')
            && physical.rawAlarm !== null && state.baselineLevels.alarm !== null
            ? physical.rawAlarm === state.baselineLevels.alarm
            : physical.alarm === false;
          const next = recovered ? (alarmStable.get(index) ?? 0) + 1 : 0;
          alarmStable.set(index, next);
          if (next >= this.config.stableSamples) alarmRecovered.add(index);
        }
        if (!faultRecovered.has(index)) {
          const recovered = !state.result.fault.reasons.includes('RELAY_BASELINE_NOT_NORMAL')
            && physical.rawFault !== null && state.baselineLevels.fault !== null
            ? physical.rawFault === state.baselineLevels.fault
            : physical.fault === false;
          const next = recovered ? (faultStable.get(index) ?? 0) + 1 : 0;
          faultStable.set(index, next);
          if (next >= this.config.stableSamples) faultRecovered.add(index);
        }
      }));

      const done = [...resetAccepted].every((index) => alarmRecovered.has(index) && faultRecovered.has(index));
      if (done) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.config.sampleIntervalMs, remaining));
    }

    for (const [index, state] of work.entries()) {
      if (!resetAccepted.has(index)) continue;
      state.result.alarm.emergencyRecovered = alarmRecovered.has(index);
      state.result.fault.emergencyRecovered = faultRecovered.has(index);
      const feedbackError = feedbackErrors.get(index);
      if (feedbackError) {
        this.addCleanupReason(state, `EMERGENCY_RESET_FEEDBACK_READ_FAILED:${feedbackError}`);
        continue;
      }
      if (!alarmRecovered.has(index)) uniquePush(state.result.alarm.reasons, 'ALARM_RELAY_STUCK_AFTER_RESET');
      if (!faultRecovered.has(index)) uniquePush(state.result.fault.reasons, 'FAULT_RELAY_STUCK_AFTER_RESET');
    }
  }

  private finalizeAction(action: RelayActionResult): void {
    action.verdict = action.commandAccepted
      && action.physicalStateReached
      && action.resetAccepted
      && action.physicalRecovered
      && action.reasons.length === 0
      ? 'PASS'
      : 'FAIL';
  }

  async run(batchId: string | null = null): Promise<RelayFunctionalTestReport> {
    const startedAt = Date.now();
    const indexes = [...new Set(this.detectors.enabledDetectorIndexes())]
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= 6)
      .sort((a, b) => a - b);

    if (!this.config.enabled) {
      return {
        batchId,
        mode: this.config.mode,
        phase: 'COMPLETE',
        startedAt,
        completedAt: Date.now(),
        verdict: 'SKIPPED',
        units: indexes.map((index) => ({ ...emptyUnit(index), enabled: false, verdict: 'SKIPPED' })),
      };
    }

    const work = new Map<number, UnitWorkState>(
      indexes.map((index) => [index, {
        result: emptyUnit(index),
        commandStartedAt: null,
        baselineLevels: { alarm: null, fault: null },
        actionLevels: { alarm: null, fault: null },
      }]),
    );

    try {
      this.emitPhase('BASELINE', work);
      await this.readBaseline(work);
      if (this.config.mode === 'DIAGNOSTIC') await this.runDiagnostic(work);
      else await this.runFastBatch(work);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const state of work.values()) this.addCleanupReason(state, `RELAY_TEST_ABORTED:${message}`);
    } finally {
      await this.emergencyCleanup(work);
    }

    const units = [...work.values()].map(({ result, baselineLevels, actionLevels }) => {
      this.finalizeAction(result.alarm);
      this.finalizeAction(result.fault);
      result.verdict = result.alarm.verdict === 'PASS' && result.fault.verdict === 'PASS' ? 'PASS' : 'FAIL';
      result.diagnostics = {
        baselineRawAlarm: baselineLevels.alarm,
        baselineRawFault: baselineLevels.fault,
        alarmSampleRawAlarm: actionLevels.alarm?.alarm ?? null,
        alarmSampleRawFault: actionLevels.alarm?.fault ?? null,
        faultSampleRawAlarm: actionLevels.fault?.alarm ?? null,
        faultSampleRawFault: actionLevels.fault?.fault ?? null,
      };
      return result;
    });

    // Field failure evidence must expose the actual DIO baseline and sampled
    // transition. A command write being accepted does not prove that a contact
    // moved, especially when all six TCP ports have recently disconnected.
    for (const [index, state] of work) {
      const { result, baselineLevels, actionLevels } = state;
      if (result.verdict !== 'FAIL') continue;
      const print = (value: boolean | null | undefined) => value === null || value === undefined ? '?' : Number(value);
      const describe = (kind: 'alarm' | 'fault') => {
        const action = result[kind];
        const sampled = actionLevels[kind];
        return `${kind}{dio=${print(sampled?.alarm)}/${print(sampled?.fault)},tcpWrites=${action.commandWriteAccepted ?? 0}/${action.commandWriteAttempts ?? 0},rescue=${action.rescueWriteAttempts ?? 0},physicalConfirmed=${Number(action.physicalStateReached)},resetAck=${Number(action.resetAccepted)},inWindowRecovered=${Number(action.physicalRecovered)},cleanupRecovered=${Number(action.emergencyRecovered ?? false)},reasons=${action.reasons.join(',') || '-'}}`;
      };
      console.warn(`[RelayDiag] batch=${batchId ?? '-'} D${index} baselineDio=${print(baselineLevels.alarm)}/${print(baselineLevels.fault)} ${describe('alarm')} ${describe('fault')}`);
    }

    this.emitPhase('COMPLETE', work);

    return {
      batchId,
      mode: this.config.mode,
      phase: 'COMPLETE',
      startedAt,
      completedAt: Date.now(),
      verdict: units.length > 0 && units.every((unit) => unit.verdict === 'PASS') ? 'PASS' : 'FAIL',
      units,
    };
  }
}
