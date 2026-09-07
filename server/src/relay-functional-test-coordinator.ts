import {
  relayFeedbackMappingFor,
  relayInputIsActive,
  type RelayActionResult,
  type RelayFunctionalTestConfig,
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

interface UnitWorkState {
  result: RelayFunctionalTestUnitResult;
  commandStartedAt: number | null;
}

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
 * 实机结论（2026-08-31）：虽然 A000/A001 可同时写成 0000/0001，且寄存器可读回，
 * 但实体输出只响应火警，故障继电器不会同时动作。因此生产 FAST_BATCH 必须按功能分阶段：
 * 6 台并行火警 -> 验证 -> 6 台并行复位 -> 6 台并行故障 -> 验证 -> 6 台并行复位。
 *
 * DIAGNOSTIC 则必须真正逐槽位完成一整套火警/故障循环后再进入下一槽位，
 * 才能用于安装调试时发现槽位之间的 DI 交叉接线。
 *
 * 无论正常、失败还是出现未预期异常，run() 最外层都会再次对所有参与槽位执行
 * 强制复位并确认内部锁存和实体 DI 均恢复。清理失败会直接写入该槽位原因并判 FAIL。
 */
export class RelayFunctionalTestCoordinator {
  constructor(
    private readonly detectors: RelayDetectorPort,
    private readonly feedback: RelayFeedbackSource,
    private readonly config: RelayFunctionalTestConfig,
  ) {}

  private async physicalState(index: number): Promise<{ alarm: boolean | null; fault: boolean | null; error?: string }> {
    const mapping = relayFeedbackMappingFor(this.config, index);
    let inputs: Record<string, boolean> | undefined;
    try {
      inputs = await this.feedback.readInputs();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error ? error.message : String(error);
      return { alarm: null, fault: null, error: code || 'DIO_READ_FAILED' };
    }
    if (!mapping || !inputs) return { alarm: null, fault: null };
    return {
      alarm: relayInputIsActive(inputs[mapping.alarmInputAddress], mapping.alarmNormalLevel),
      fault: relayInputIsActive(inputs[mapping.faultInputAddress], mapping.faultNormalLevel),
    };
  }

  private async readBaseline(work: Map<number, UnitWorkState>): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      try {
        const internal = await this.detectors.readLatched(index);
        const physical = await this.physicalState(index);
        state.result.baseline = {
          alarmInternal: internal.fire,
          faultInternal: internal.fault,
          alarmPhysical: physical.alarm,
          faultPhysical: physical.fault,
        };
        if (internal.fire) uniquePush(state.result.alarm.reasons, 'ALARM_ACTIVE_AT_BASELINE');
        if (internal.fault) uniquePush(state.result.fault.reasons, 'FAULT_ACTIVE_AT_BASELINE');
        if (physical.alarm === true) uniquePush(state.result.alarm.reasons, 'ALARM_RELAY_ACTIVE_AT_BASELINE');
        if (physical.fault === true) uniquePush(state.result.fault.reasons, 'FAULT_RELAY_ACTIVE_AT_BASELINE');
        if (physical.error) {
          uniquePush(state.result.alarm.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
          uniquePush(state.result.fault.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
        }
      } catch {
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
      try {
        await this.detectors.simulate(index, kind === 'alarm'
          ? { fire: true, fault: false }
          : { fire: false, fault: true });
        action.commandAccepted = true;
      } catch {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_COMMAND_FAILED' : 'FAULT_COMMAND_FAILED');
      }
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
        if (
          action.internalStateReached
          && action.physicalStateReached
          && action.oppositeRelayStayedNormal
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        ) return;

        try {
          const internal = await this.detectors.readLatched(index);
          const physical = await this.physicalState(index);
          if (physical.error) {
            uniquePush(action.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
            stable.set(index, 0);
            return;
          }
          const internalReached = kind === 'alarm'
            ? internal.fire === true && internal.fault === false
            : internal.fire === false && internal.fault === true;
          const physicalReached = kind === 'alarm'
            ? physical.alarm === true
            : physical.fault === true;
          const oppositeNormal = kind === 'alarm'
            ? physical.fault === false
            : physical.alarm === false;

          action.internalStateReached ||= internalReached;
          action.physicalStateReached ||= physicalReached;
          action.oppositeRelayStayedNormal &&= oppositeNormal;

          if (internalReached && physicalReached && oppositeNormal) {
            const next = (stable.get(index) ?? 0) + 1;
            stable.set(index, next);
            if (next >= this.config.stableSamples && action.responseTimeMs === null) {
              action.responseTimeMs = Math.max(0, Date.now() - (state.commandStartedAt ?? Date.now()));
            }
          } else {
            stable.set(index, 0);
          }
        } catch {
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const action = state.result[kind];
        return !action.commandAccepted || (
          action.internalStateReached
          && action.physicalStateReached
          && action.oppositeRelayStayedNormal
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        );
      });
      if (done) break;
      await sleep(this.config.sampleIntervalMs);
    }

    for (const state of work.values()) {
      const action = state.result[kind];
      if (!action.commandAccepted) continue;
      if (!action.internalStateReached) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_INTERNAL_STATE_NOT_SET' : 'FAULT_INTERNAL_STATE_NOT_SET');
      }
      const feedbackReadFailed = action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'));
      if (!action.physicalStateReached && !feedbackReadFailed) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RELAY_NOT_ACTUATED' : 'FAULT_RELAY_NOT_ACTUATED');
      }
      if (!action.oppositeRelayStayedNormal) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_TRIGGERED_FAULT_RELAY' : 'FAULT_TRIGGERED_ALARM_RELAY');
      }
    }
  }

  private async resetBatch(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const action = state.result[kind];
      try {
        await this.detectors.reset(index);
        action.resetAccepted = true;
      } catch {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RESET_COMMAND_FAILED' : 'FAULT_RESET_COMMAND_FAILED');
      }
    }));
  }

  private async waitForReset(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    const deadline = Date.now() + this.config.resetTimeoutMs;
    const stable = new Map<number, number>();

    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.resetAccepted) return;

        try {
          const internal = await this.detectors.readLatched(index);
          const physical = await this.physicalState(index);
          if (physical.error) {
            uniquePush(action.reasons, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
            stable.set(index, 0);
            return;
          }
          const internalRecovered = internal.fire === false && internal.fault === false;
          const physicalRecovered = physical.alarm === false && physical.fault === false;

          action.internalRecovered ||= internalRecovered;
          action.physicalRecovered ||= physicalRecovered;
          stable.set(index, internalRecovered && physicalRecovered
            ? (stable.get(index) ?? 0) + 1
            : 0);
        } catch {
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const action = state.result[kind];
        return !action.resetAccepted || (
          action.internalRecovered
          && action.physicalRecovered
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        );
      });
      if (done) break;
      await sleep(this.config.sampleIntervalMs);
    }

    for (const state of work.values()) {
      const action = state.result[kind];
      if (!action.resetAccepted) continue;
      if (!action.internalRecovered) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RESET_INTERNAL_FAILED' : 'FAULT_RESET_INTERNAL_FAILED');
      }
      const feedbackReadFailed = action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'));
      if (!action.physicalRecovered && !feedbackReadFailed) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RELAY_STUCK_AFTER_RESET' : 'FAULT_RELAY_STUCK_AFTER_RESET');
      }
    }
  }

  private async runActionCycle(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    await this.sendCommand(work, kind);
    await this.waitForAction(work, kind);
    await this.resetBatch(work, kind);
    await this.waitForReset(work, kind);
  }

  private async runFastBatch(work: Map<number, UnitWorkState>): Promise<void> {
    await this.runActionCycle(work, 'alarm');
    await this.runActionCycle(work, 'fault');
  }

  private async runDiagnostic(work: Map<number, UnitWorkState>): Promise<void> {
    // One complete slot at a time. This is intentionally slower and is only for
    // commissioning/maintenance where exact slot-to-DI wiring attribution matters.
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
      try {
        await this.detectors.reset(index);
        resetAccepted.add(index);
      } catch {
        this.addCleanupReason(state, 'EMERGENCY_RESET_COMMAND_FAILED');
      }
    }));

    const stable = new Map<number, number>();
    const recovered = new Set<number>();
    const feedbackErrors = new Map<number, string>();
    const deadline = Date.now() + this.config.resetTimeoutMs;

    while (Date.now() <= deadline && recovered.size < resetAccepted.size) {
      await Promise.all([...work.entries()].map(async ([index]) => {
        if (!resetAccepted.has(index) || recovered.has(index)) return;
        try {
          const internal = await this.detectors.readLatched(index);
          const physical = await this.physicalState(index);
          if (physical.error) {
            feedbackErrors.set(index, physical.error);
            stable.set(index, 0);
            return;
          }
          const clear = internal.fire === false
            && internal.fault === false
            && physical.alarm === false
            && physical.fault === false;
          const next = clear ? (stable.get(index) ?? 0) + 1 : 0;
          stable.set(index, next);
          if (next >= this.config.stableSamples) recovered.add(index);
        } catch {
          stable.set(index, 0);
        }
      }));
      if (recovered.size >= resetAccepted.size) break;
      await sleep(this.config.sampleIntervalMs);
    }

    for (const [index, state] of work.entries()) {
      if (!resetAccepted.has(index)) continue;
      if (recovered.has(index)) continue;
      const feedbackError = feedbackErrors.get(index);
      if (feedbackError) this.addCleanupReason(state, `EMERGENCY_RESET_FEEDBACK_READ_FAILED:${feedbackError}`);
      else this.addCleanupReason(state, 'EMERGENCY_RESET_NOT_CONFIRMED');
    }
  }

  private finalizeAction(action: RelayActionResult): void {
    action.verdict = action.commandAccepted
      && action.internalStateReached
      && action.physicalStateReached
      && action.oppositeRelayStayedNormal
      && action.resetAccepted
      && action.internalRecovered
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
      indexes.map((index) => [index, { result: emptyUnit(index), commandStartedAt: null }]),
    );

    try {
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
