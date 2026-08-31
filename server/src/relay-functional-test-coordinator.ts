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
  readInputs(): Record<string, boolean> | undefined;
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

export class RelayFunctionalTestCoordinator {
  constructor(
    private readonly detectors: RelayDetectorPort,
    private readonly feedback: RelayFeedbackSource,
    private readonly config: RelayFunctionalTestConfig,
  ) {}

  private physicalState(index: number): { alarm: boolean | null; fault: boolean | null } {
    const mapping = relayFeedbackMappingFor(this.config, index);
    const inputs = this.feedback.readInputs();
    if (!mapping || !inputs) return { alarm: null, fault: null };
    return {
      alarm: relayInputIsActive(inputs[mapping.alarmInputKey], mapping.alarmNormalLevel),
      fault: relayInputIsActive(inputs[mapping.faultInputKey], mapping.faultNormalLevel),
    };
  }

  private async readBaseline(work: Map<number, UnitWorkState>): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      try {
        const internal = await this.detectors.readLatched(index);
        const physical = this.physicalState(index);
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
      } catch {
        uniquePush(state.result.alarm.reasons, 'RELAY_BASELINE_READ_FAILED');
        uniquePush(state.result.fault.reasons, 'RELAY_BASELINE_READ_FAILED');
      }
    }));
  }

  /**
   * 正常生产 FAST_BATCH：每台探测器一次写入 fire+fault=true。
   * 对地址 01 的当前实机，该调用最终对应已验证帧：
   * 01 10 A0 00 00 02 04 00 00 00 01 CA 68
   * 六台独立连接时并行下发，从而把继电器功能测试压缩为一次激励 + 一次复位。
   */
  private async sendCombinedBatchCommand(work: Map<number, UnitWorkState>): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      state.commandStartedAt = Date.now();
      try {
        await this.detectors.simulate(index, { fire: true, fault: true });
        state.result.alarm.commandAccepted = true;
        state.result.fault.commandAccepted = true;
      } catch {
        uniquePush(state.result.alarm.reasons, 'ALARM_COMMAND_FAILED');
        uniquePush(state.result.fault.reasons, 'FAULT_COMMAND_FAILED');
      }
    }));
  }

  private async waitForCombinedAction(work: Map<number, UnitWorkState>): Promise<void> {
    const deadline = Date.now() + this.config.feedbackTimeoutMs;
    const stable = new Map<number, number>();
    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const alarm = state.result.alarm;
        const fault = state.result.fault;
        if (!alarm.commandAccepted || !fault.commandAccepted) return;
        if (
          alarm.internalStateReached
          && fault.internalStateReached
          && alarm.physicalStateReached
          && fault.physicalStateReached
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        ) return;
        try {
          const internal = await this.detectors.readLatched(index);
          const physical = this.physicalState(index);
          const alarmInternalReached = internal.fire === true;
          const faultInternalReached = internal.fault === true;
          const alarmPhysicalReached = physical.alarm === true;
          const faultPhysicalReached = physical.fault === true;

          alarm.internalStateReached ||= alarmInternalReached;
          fault.internalStateReached ||= faultInternalReached;
          alarm.physicalStateReached ||= alarmPhysicalReached;
          fault.physicalStateReached ||= faultPhysicalReached;
          // FAST_BATCH 同时要求两路动作，因此“对侧保持正常”不适用，固定视为满足。
          alarm.oppositeRelayStayedNormal = true;
          fault.oppositeRelayStayedNormal = true;

          const allReached = alarmInternalReached
            && faultInternalReached
            && alarmPhysicalReached
            && faultPhysicalReached;
          if (allReached) {
            const next = (stable.get(index) ?? 0) + 1;
            stable.set(index, next);
            if (next >= this.config.stableSamples) {
              const responseTimeMs = Math.max(0, Date.now() - (state.commandStartedAt ?? Date.now()));
              if (alarm.responseTimeMs === null) alarm.responseTimeMs = responseTimeMs;
              if (fault.responseTimeMs === null) fault.responseTimeMs = responseTimeMs;
            }
          } else {
            stable.set(index, 0);
          }
        } catch {
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const alarm = state.result.alarm;
        const fault = state.result.fault;
        return !alarm.commandAccepted || !fault.commandAccepted || (
          alarm.internalStateReached
          && fault.internalStateReached
          && alarm.physicalStateReached
          && fault.physicalStateReached
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        );
      });
      if (done) break;
      await sleep(this.config.sampleIntervalMs);
    }

    for (const state of work.values()) {
      const alarm = state.result.alarm;
      const fault = state.result.fault;
      if (alarm.commandAccepted) {
        if (!alarm.internalStateReached) uniquePush(alarm.reasons, 'ALARM_INTERNAL_STATE_NOT_SET');
        if (!alarm.physicalStateReached) uniquePush(alarm.reasons, 'ALARM_RELAY_NOT_ACTUATED');
      }
      if (fault.commandAccepted) {
        if (!fault.internalStateReached) uniquePush(fault.reasons, 'FAULT_INTERNAL_STATE_NOT_SET');
        if (!fault.physicalStateReached) uniquePush(fault.reasons, 'FAULT_RELAY_NOT_ACTUATED');
      }
    }
  }

  private async resetCombinedBatch(work: Map<number, UnitWorkState>): Promise<void> {
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      try {
        await this.detectors.reset(index);
        state.result.alarm.resetAccepted = true;
        state.result.fault.resetAccepted = true;
      } catch {
        uniquePush(state.result.alarm.reasons, 'ALARM_RESET_COMMAND_FAILED');
        uniquePush(state.result.fault.reasons, 'FAULT_RESET_COMMAND_FAILED');
      }
    }));
  }

  private async waitForCombinedReset(work: Map<number, UnitWorkState>): Promise<void> {
    const deadline = Date.now() + this.config.resetTimeoutMs;
    const stable = new Map<number, number>();
    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const alarm = state.result.alarm;
        const fault = state.result.fault;
        if (!alarm.resetAccepted || !fault.resetAccepted) return;
        try {
          const internal = await this.detectors.readLatched(index);
          const physical = this.physicalState(index);
          const alarmInternalRecovered = internal.fire === false;
          const faultInternalRecovered = internal.fault === false;
          const alarmPhysicalRecovered = physical.alarm === false;
          const faultPhysicalRecovered = physical.fault === false;

          alarm.internalRecovered ||= alarmInternalRecovered;
          fault.internalRecovered ||= faultInternalRecovered;
          alarm.physicalRecovered ||= alarmPhysicalRecovered;
          fault.physicalRecovered ||= faultPhysicalRecovered;

          const allRecovered = alarmInternalRecovered
            && faultInternalRecovered
            && alarmPhysicalRecovered
            && faultPhysicalRecovered;
          stable.set(index, allRecovered ? (stable.get(index) ?? 0) + 1 : 0);
        } catch {
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const alarm = state.result.alarm;
        const fault = state.result.fault;
        return !alarm.resetAccepted || !fault.resetAccepted || (
          alarm.internalRecovered
          && fault.internalRecovered
          && alarm.physicalRecovered
          && fault.physicalRecovered
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        );
      });
      if (done) break;
      await sleep(this.config.sampleIntervalMs);
    }

    for (const state of work.values()) {
      const alarm = state.result.alarm;
      const fault = state.result.fault;
      if (alarm.resetAccepted) {
        if (!alarm.internalRecovered) uniquePush(alarm.reasons, 'ALARM_RESET_INTERNAL_FAILED');
        if (!alarm.physicalRecovered) uniquePush(alarm.reasons, 'ALARM_RELAY_STUCK_AFTER_RESET');
      }
      if (fault.resetAccepted) {
        if (!fault.internalRecovered) uniquePush(fault.reasons, 'FAULT_RESET_INTERNAL_FAILED');
        if (!fault.physicalRecovered) uniquePush(fault.reasons, 'FAULT_RELAY_STUCK_AFTER_RESET');
      }
    }
  }

  /** DIAGNOSTIC 模式仍然分开激励 Alarm/Fault，保留故障定位能力。 */
  private async sendDiagnosticCommand(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    for (const [index, state] of work.entries()) {
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
    }
  }

  private async waitForDiagnosticAction(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    const deadline = Date.now() + this.config.feedbackTimeoutMs;
    const stable = new Map<number, number>();
    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.commandAccepted || action.internalStateReached && action.physicalStateReached && action.oppositeRelayStayedNormal && (stable.get(index) ?? 0) >= this.config.stableSamples) return;
        try {
          const internal = await this.detectors.readLatched(index);
          const physical = this.physicalState(index);
          const internalReached = kind === 'alarm'
            ? internal.fire && !internal.fault
            : !internal.fire && internal.fault;
          const physicalReached = kind === 'alarm' ? physical.alarm === true : physical.fault === true;
          const oppositeNormal = kind === 'alarm' ? physical.fault === false : physical.alarm === false;
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
      if (!action.internalStateReached) uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_INTERNAL_STATE_NOT_SET' : 'FAULT_INTERNAL_STATE_NOT_SET');
      if (!action.physicalStateReached) uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RELAY_NOT_ACTUATED' : 'FAULT_RELAY_NOT_ACTUATED');
      if (!action.oppositeRelayStayedNormal) uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_TRIGGERED_FAULT_RELAY' : 'FAULT_TRIGGERED_ALARM_RELAY');
    }
  }

  private async resetDiagnostic(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    for (const [index, state] of work.entries()) {
      const action = state.result[kind];
      try {
        await this.detectors.reset(index);
        action.resetAccepted = true;
      } catch {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RESET_COMMAND_FAILED' : 'FAULT_RESET_COMMAND_FAILED');
      }
    }
  }

  private async waitForDiagnosticReset(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    const deadline = Date.now() + this.config.resetTimeoutMs;
    const stable = new Map<number, number>();
    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.resetAccepted) return;
        try {
          const internal = await this.detectors.readLatched(index);
          const physical = this.physicalState(index);
          const internalRecovered = !internal.fire && !internal.fault;
          const physicalRecovered = physical.alarm === false && physical.fault === false;
          action.internalRecovered ||= internalRecovered;
          action.physicalRecovered ||= physicalRecovered;
          stable.set(index, internalRecovered && physicalRecovered ? (stable.get(index) ?? 0) + 1 : 0);
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
      if (!action.internalRecovered) uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RESET_INTERNAL_FAILED' : 'FAULT_RESET_INTERNAL_FAILED');
      if (!action.physicalRecovered) uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_RELAY_STUCK_AFTER_RESET' : 'FAULT_RELAY_STUCK_AFTER_RESET');
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

    const work = new Map<number, UnitWorkState>(indexes.map((index) => [index, { result: emptyUnit(index), commandStartedAt: null }]));
    await this.readBaseline(work);

    if (this.config.mode === 'FAST_BATCH') {
      // 生产默认：一次同时触发 Alarm + Fault，仅复位一次。
      await this.sendCombinedBatchCommand(work);
      await this.waitForCombinedAction(work);
      await this.resetCombinedBatch(work);
      await this.waitForCombinedReset(work);
    } else {
      // 诊断模式：逐功能分开测试，便于定位 Alarm/Fault 接反或互串。
      await this.sendDiagnosticCommand(work, 'alarm');
      await this.waitForDiagnosticAction(work, 'alarm');
      await this.resetDiagnostic(work, 'alarm');
      await this.waitForDiagnosticReset(work, 'alarm');

      await this.sendDiagnosticCommand(work, 'fault');
      await this.waitForDiagnosticAction(work, 'fault');
      await this.resetDiagnostic(work, 'fault');
      await this.waitForDiagnosticReset(work, 'fault');
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
