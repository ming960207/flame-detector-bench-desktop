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
}

const RELAY_COMMAND_MAX_ATTEMPTS = 3;
const RELAY_COMMAND_RETRY_DELAY_MS = 80;
const RELAY_SIMULATION_BURST_COUNT = 3;
export const RELAY_SIMULATION_BURST_INTERVAL_MS = 100;
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

  private async detectorSimulationBurst(operation: () => Promise<void>): Promise<boolean> {
    let accepted = false;
    for (let attempt = 1; attempt <= RELAY_SIMULATION_BURST_COUNT; attempt += 1) {
      try {
        await operation();
        accepted = true;
      } catch {
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
    try {
      return await this.detectorReadWithRetry(() => this.detectors.readLatched(index));
    } catch {
      return null;
    }
  }

  private async physicalState(index: number): Promise<{
    alarm: boolean | null;
    fault: boolean | null;
    rawAlarm: boolean | null;
    rawFault: boolean | null;
    error?: string;
  }> {
    const mapping = relayFeedbackMappingFor(this.config, index);
    let inputs: Record<string, boolean> | undefined;
    try {
      inputs = await this.detectorReadWithRetry(() => Promise.resolve(this.feedback.readInputs()));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error ? error.message : String(error);
      return { alarm: null, fault: null, rawAlarm: null, rawFault: null, error: code || 'DIO_READ_FAILED' };
    }
    if (!mapping || !inputs) return { alarm: null, fault: null, rawAlarm: null, rawFault: null };
    const alarmLevel = inputs[mapping.alarmInputAddress];
    const faultLevel = inputs[mapping.faultInputAddress];
    const rawAlarm = typeof alarmLevel === 'boolean' ? alarmLevel : null;
    const rawFault = typeof faultLevel === 'boolean' ? faultLevel : null;
    return {
      alarm: relayInputIsActive(alarmLevel, mapping.alarmNormalLevel),
      fault: relayInputIsActive(faultLevel, mapping.faultNormalLevel),
      rawAlarm,
      rawFault,
    };
  }

  private async readBaseline(work: Map<number, UnitWorkState>): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const [internal, physical] = await Promise.all([
        this.diagnosticInternalState(index),
        this.physicalState(index),
      ]);
      state.baselineLevels = {
        alarm: physical.rawAlarm,
        fault: physical.rawFault,
      };
      state.result.baseline = {
        alarmInternal: internal?.fire ?? null,
        faultInternal: internal?.fault ?? null,
        alarmPhysical: physical.alarm,
        faultPhysical: physical.fault,
      };

      // Functional verification uses the observed raw baseline, not configured
      // polarity. A stuck/active contact will still fail because it cannot produce
      // the required transition after the command.
      if (physical.error) {
        uniquePush(state.result.alarm.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
        uniquePush(state.result.fault.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
      } else if (physical.rawAlarm === null || physical.rawFault === null) {
        uniquePush(state.result.alarm.reasons, 'RELAY_BASELINE_READ_FAILED');
        uniquePush(state.result.fault.reasons, 'RELAY_BASELINE_READ_FAILED');
      }
    }));
  }

  private async sendCommand(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const action = state.result[kind];
      state.commandStartedAt = Date.now();
      const accepted = await this.detectorSimulationBurst(() => this.detectors.simulate(index, kind === 'alarm'
        ? { fire: true, fault: false }
        : { fire: false, fault: true }));
      if (accepted) action.commandAccepted = true;
      else uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_COMMAND_FAILED' : 'FAULT_COMMAND_FAILED');
    }));
  }

  private async waitForAction(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    const deadline = Date.now() + this.config.feedbackTimeoutMs;
    const stable = new Map<number, number>();

    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.commandAccepted) return;
        if (action.physicalStateReached && (stable.get(index) ?? 0) >= this.config.stableSamples) return;

        const [internal, physical] = await Promise.all([
          this.diagnosticInternalState(index),
          this.physicalState(index),
        ]);
        if (physical.error) {
          uniquePush(action.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
          stable.set(index, 0);
          return;
        }

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
      await sleep(this.config.sampleIntervalMs);
    }

    for (const state of work.values()) {
      const action = state.result[kind];
      if (!action.commandAccepted) continue;
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

    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.resetAccepted) return;
        if (action.physicalRecovered && (stable.get(index) ?? 0) >= this.config.stableSamples) return;

        const [internal, physical] = await Promise.all([
          this.diagnosticInternalState(index),
          this.physicalState(index),
        ]);
        if (physical.error) {
          uniquePush(action.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
          stable.set(index, 0);
          return;
        }

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
          if (next >= this.config.stableSamples) action.physicalRecovered = true;
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
      await sleep(this.config.sampleIntervalMs);
    }

    for (const state of work.values()) {
      const action = state.result[kind];
      if (!action.resetAccepted) continue;
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

    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        if (!resetAccepted.has(index)) return;
        if (alarmRecovered.has(index) && faultRecovered.has(index)) return;

        const physical = await this.physicalState(index);
        if (physical.error) {
          feedbackErrors.set(index, physical.error);
          alarmStable.set(index, 0);
          faultStable.set(index, 0);
          return;
        }

        if (!alarmRecovered.has(index)) {
          const recovered = physical.rawAlarm !== null && state.baselineLevels.alarm !== null
            ? physical.rawAlarm === state.baselineLevels.alarm
            : physical.alarm === false;
          const next = recovered ? (alarmStable.get(index) ?? 0) + 1 : 0;
          alarmStable.set(index, next);
          if (next >= this.config.stableSamples) alarmRecovered.add(index);
        }
        if (!faultRecovered.has(index)) {
          const recovered = physical.rawFault !== null && state.baselineLevels.fault !== null
            ? physical.rawFault === state.baselineLevels.fault
            : physical.fault === false;
          const next = recovered ? (faultStable.get(index) ?? 0) + 1 : 0;
          faultStable.set(index, next);
          if (next >= this.config.stableSamples) faultRecovered.add(index);
        }
      }));

      const done = [...resetAccepted].every((index) => alarmRecovered.has(index) && faultRecovered.has(index));
      if (done) break;
      await sleep(this.config.sampleIntervalMs);
    }

    for (const [index, state] of work.entries()) {
      if (!resetAccepted.has(index)) continue;
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

    const units = [...work.values()].map(({ result }) => {
      this.finalizeAction(result.alarm);
      this.finalizeAction(result.fault);
      result.verdict = result.alarm.verdict === 'PASS' && result.fault.verdict === 'PASS' ? 'PASS' : 'FAIL';
      return result;
    });

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