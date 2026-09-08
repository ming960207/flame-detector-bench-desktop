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
  testInvalid: boolean;
  resetRequired: boolean;
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

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const message = error instanceof Error ? error.message : String(error.code);
    return `${error.code}:${message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function actionPrefix(kind: 'alarm' | 'fault'): 'ALARM' | 'FAULT' {
  return kind === 'alarm' ? 'ALARM' : 'FAULT';
}

function isKnownProductRelayFailure(reason: string): boolean {
  return [
    'ALARM_ACTIVE_AT_BASELINE',
    'FAULT_ACTIVE_AT_BASELINE',
    'ALARM_RELAY_ACTIVE_AT_BASELINE',
    'FAULT_RELAY_ACTIVE_AT_BASELINE',
    'ALARM_RELAY_NOT_ACTUATED',
    'FAULT_RELAY_NOT_ACTUATED',
    'ALARM_TRIGGERED_FAULT_RELAY',
    'FAULT_TRIGGERED_ALARM_RELAY',
    'ALARM_RELAY_STUCK_AFTER_RESET',
    'FAULT_RELAY_STUCK_AFTER_RESET',
  ].includes(reason);
}

/**
 * 继电器功能检测协调器。
 *
 * 生产 FAST_BATCH：6 台并行火警 -> 验证 -> 复位 -> 6 台并行故障 -> 验证 -> 复位。
 * 关键判定边界：只有“内部模拟状态已经建立 + DIO 可读取”后，实体触点不动作才是产品 FAIL；
 * 模拟状态无法建立、DIO 不可读、复位无法确认等均属于 TEST_INVALID，禁止把基础设施/控制失败误判为产品 NG。
 */
export class RelayFunctionalTestCoordinator {
  private readonly dioLogSignatures = new Map<string, string>();
  private readonly internalLogSignatures = new Map<string, string>();

  constructor(
    private readonly detectors: RelayDetectorPort,
    private readonly feedback: RelayFeedbackSource,
    private readonly config: RelayFunctionalTestConfig,
  ) {}

  private logInternal(context: string, index: number, internal: { fire: boolean; fault: boolean }): void {
    const key = `${context}:D${index}`;
    const signature = `${internal.fire ? 1 : 0}/${internal.fault ? 1 : 0}`;
    if (this.internalLogSignatures.get(key) === signature) return;
    this.internalLogSignatures.set(key, signature);
    console.log(`[继电器检测][${context}][D${index}][B000/B001] fire=${internal.fire ? 1 : 0} fault=${internal.fault ? 1 : 0}`);
  }

  private logDio(
    context: string,
    index: number,
    inputs: Record<string, boolean> | undefined,
    alarm: boolean | null,
    fault: boolean | null,
    error?: string,
  ): void {
    const mapping = relayFeedbackMappingFor(this.config, index);
    const raw = inputs
      ? Object.keys(inputs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((key) => `${key}=${inputs[key] ? 1 : 0}`).join(',')
      : '-';
    const mappingText = mapping
      ? `alarm=${mapping.alarmInputAddress}(normal=${mapping.alarmNormalLevel ? 1 : 0})->${alarm === null ? '?' : alarm ? 1 : 0} `
        + `fault=${mapping.faultInputAddress}(normal=${mapping.faultNormalLevel ? 1 : 0})->${fault === null ? '?' : fault ? 1 : 0}`
      : 'mapping=missing';
    const signature = `${raw}|${mappingText}|${error ?? ''}`;
    const key = `${context}:D${index}`;
    if (this.dioLogSignatures.get(key) === signature) return;
    this.dioLogSignatures.set(key, signature);
    const line = `[继电器检测][${context}][D${index}][DIO] raw={${raw}} ${mappingText}${error ? ` error=${error}` : ''}`;
    if (error) console.error(line);
    else console.log(line);
  }

  private markInvalid(state: UnitWorkState, kind: 'alarm' | 'fault', reason: string): void {
    const action = state.result[kind];
    action.verdict = 'TEST_INVALID';
    state.testInvalid = true;
    uniquePush(action.reasons, reason);
  }

  private async physicalState(
    index: number,
    context: string,
  ): Promise<{ alarm: boolean | null; fault: boolean | null; error?: string }> {
    const mapping = relayFeedbackMappingFor(this.config, index);
    let inputs: Record<string, boolean> | undefined;
    try {
      inputs = await this.feedback.readInputs();
    } catch (error) {
      const code = errorText(error) || 'DIO_READ_FAILED';
      this.logDio(context, index, undefined, null, null, code);
      return { alarm: null, fault: null, error: code };
    }
    if (!mapping || !inputs) {
      const error = !mapping ? 'DIO_MAPPING_MISSING' : 'DIO_INPUTS_UNAVAILABLE';
      this.logDio(context, index, inputs, null, null, error);
      return { alarm: null, fault: null, error };
    }
    const alarm = relayInputIsActive(inputs[mapping.alarmInputAddress], mapping.alarmNormalLevel);
    const fault = relayInputIsActive(inputs[mapping.faultInputAddress], mapping.faultNormalLevel);
    this.logDio(context, index, inputs, alarm, fault);
    return { alarm, fault };
  }

  private async readBaseline(work: Map<number, UnitWorkState>): Promise<void> {
    console.log('[继电器检测][BASELINE] 开始读取 B000/B001 与 DIO 正常态。');
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      try {
        const internal = await this.detectors.readLatched(index);
        this.logInternal('BASELINE', index, internal);
        const physical = await this.physicalState(index, 'BASELINE');
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
          this.markInvalid(state, 'alarm', `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
          this.markInvalid(state, 'fault', `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
        }
      } catch (error) {
        const reason = `RELAY_BASELINE_READ_FAILED:${errorText(error)}`;
        this.markInvalid(state, 'alarm', reason);
        this.markInvalid(state, 'fault', reason);
      }
    }));
  }

  private async sendCommand(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    const prefix = actionPrefix(kind);
    console.log(`[继电器检测][${prefix}_COMMAND] 开始${kind === 'alarm' ? '火警' : '故障'}模拟。`);
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      const action = state.result[kind];
      if (state.testInvalid) {
        action.verdict = 'TEST_INVALID';
        uniquePush(action.reasons, `${prefix}_SKIPPED_AFTER_TEST_INVALID`);
        console.warn(`[继电器检测][${prefix}_COMMAND][D${index}] 已存在 TEST_INVALID，停止该槽位后续模拟命令。`);
        return;
      }

      state.commandStartedAt = Date.now();
      state.resetRequired = true;
      try {
        await this.detectors.simulate(index, kind === 'alarm'
          ? { fire: true, fault: false }
          : { fire: false, fault: true });
        action.commandAccepted = true;
        console.log(`[继电器检测][${prefix}_COMMAND][D${index}] FC10 写入、A000/A001 回读及 B000/B001 内部状态验证通过。`);
      } catch (error) {
        const message = errorText(error);
        this.markInvalid(state, kind, `${prefix}_SIMULATION_INVALID:${message}`);
        console.error(`[继电器检测][${prefix}_COMMAND][D${index}] TEST_INVALID：模拟命令无法建立可验证内部状态，停止该槽位后续功能判定。${message}`);
      }
    }));
  }

  private async waitForAction(
    work: Map<number, UnitWorkState>,
    kind: 'alarm' | 'fault',
  ): Promise<void> {
    const prefix = actionPrefix(kind);
    const context = `${prefix}_VERIFY`;
    const deadline = Date.now() + this.config.feedbackTimeoutMs;
    const stable = new Map<number, number>();

    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.commandAccepted || action.verdict === 'TEST_INVALID') return;
        if (
          action.internalStateReached
          && action.physicalStateReached
          && action.oppositeRelayStayedNormal
          && (stable.get(index) ?? 0) >= this.config.stableSamples
        ) return;

        try {
          const internal = await this.detectors.readLatched(index);
          this.logInternal(context, index, internal);
          const physical = await this.physicalState(index, context);
          if (physical.error) {
            this.markInvalid(state, kind, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
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
              console.log(`[继电器检测][${context}][D${index}] 内部状态+DIO 实体反馈稳定 ${next} 次，响应 ${action.responseTimeMs}ms。`);
            }
          } else {
            stable.set(index, 0);
          }
        } catch (error) {
          this.markInvalid(state, kind, `${prefix}_VERIFY_READ_FAILED:${errorText(error)}`);
          stable.set(index, 0);
        }
      }));

      const done = [...work.entries()].every(([index, state]) => {
        const action = state.result[kind];
        return !action.commandAccepted
          || action.verdict === 'TEST_INVALID'
          || (
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
      if (!action.commandAccepted || action.verdict === 'TEST_INVALID') continue;
      if (!action.internalStateReached) {
        this.markInvalid(state, kind, `${prefix}_INTERNAL_STATE_NOT_SET`);
        continue;
      }
      const feedbackReadFailed = action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'));
      if (!action.physicalStateReached && !feedbackReadFailed) {
        uniquePush(action.reasons, `${prefix}_RELAY_NOT_ACTUATED`);
      }
      if (!action.oppositeRelayStayedNormal) {
        uniquePush(action.reasons, kind === 'alarm' ? 'ALARM_TRIGGERED_FAULT_RELAY' : 'FAULT_TRIGGERED_ALARM_RELAY');
      }
    }
  }

  private async resetBatch(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    const prefix = actionPrefix(kind);
    console.log(`[继电器检测][${prefix}_RESET] 对实际执行过模拟命令的槽位写 F000=1234。`);
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      if (!state.resetRequired) return;
      const action = state.result[kind];
      try {
        await this.detectors.reset(index);
        action.resetAccepted = true;
        state.resetRequired = false;
        console.log(`[继电器检测][${prefix}_RESET][D${index}] F000=1234 写入已确认。`);
      } catch (error) {
        this.markInvalid(state, kind, `${prefix}_RESET_COMMAND_FAILED:${errorText(error)}`);
        console.error(`[继电器检测][${prefix}_RESET][D${index}] 复位命令失败：${errorText(error)}`);
      }
    }));
  }

  private async waitForReset(work: Map<number, UnitWorkState>, kind: 'alarm' | 'fault'): Promise<void> {
    const prefix = actionPrefix(kind);
    const context = `${prefix}_RESET_VERIFY`;
    const deadline = Date.now() + this.config.resetTimeoutMs;
    const stable = new Map<number, number>();

    while (Date.now() <= deadline) {
      await Promise.all([...work.entries()].map(async ([index, state]) => {
        const action = state.result[kind];
        if (!action.resetAccepted) return;

        try {
          const internal = await this.detectors.readLatched(index);
          this.logInternal(context, index, internal);
          const physical = await this.physicalState(index, context);
          if (physical.error) {
            this.markInvalid(state, kind, `RELAY_FEEDBACK_READ_FAILED:${physical.error}`);
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
        } catch (error) {
          this.markInvalid(state, kind, `${prefix}_RESET_VERIFY_READ_FAILED:${errorText(error)}`);
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
        this.markInvalid(state, kind, `${prefix}_RESET_INTERNAL_FAILED`);
        continue;
      }
      const feedbackReadFailed = action.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'));
      if (!action.physicalRecovered && !feedbackReadFailed) {
        uniquePush(action.reasons, `${prefix}_RELAY_STUCK_AFTER_RESET`);
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
    for (const [index, state] of work.entries()) {
      const single = new Map<number, UnitWorkState>([[index, state]]);
      await this.runActionCycle(single, 'alarm');
      await this.runActionCycle(single, 'fault');
    }
  }

  private addCleanupReason(state: UnitWorkState, reason: string): void {
    this.markInvalid(state, 'alarm', reason);
    this.markInvalid(state, 'fault', reason);
  }

  private async emergencyCleanup(work: Map<number, UnitWorkState>): Promise<void> {
    console.log('[继电器检测][EMERGENCY_CLEANUP] 最终强制复位所有参与槽位。');
    const resetAccepted = new Set<number>();
    await Promise.all([...work.entries()].map(async ([index, state]) => {
      try {
        await this.detectors.reset(index);
        resetAccepted.add(index);
      } catch (error) {
        this.addCleanupReason(state, `EMERGENCY_RESET_COMMAND_FAILED:${errorText(error)}`);
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
          this.logInternal('EMERGENCY_RESET_VERIFY', index, internal);
          const physical = await this.physicalState(index, 'EMERGENCY_RESET_VERIFY');
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
      if (!resetAccepted.has(index) || recovered.has(index)) continue;
      const feedbackError = feedbackErrors.get(index);
      if (feedbackError) this.addCleanupReason(state, `EMERGENCY_RESET_FEEDBACK_READ_FAILED:${feedbackError}`);
      else this.addCleanupReason(state, 'EMERGENCY_RESET_NOT_CONFIRMED');
    }
  }

  private finalizeAction(action: RelayActionResult): void {
    if (action.reasons.some(isKnownProductRelayFailure)) {
      action.verdict = 'FAIL';
      return;
    }
    if (action.verdict === 'TEST_INVALID') return;
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
      indexes.map((index) => [index, {
        result: emptyUnit(index),
        commandStartedAt: null,
        testInvalid: false,
        resetRequired: false,
      }]),
    );

    try {
      await this.readBaseline(work);
      if (this.config.mode === 'DIAGNOSTIC') await this.runDiagnostic(work);
      else await this.runFastBatch(work);
    } catch (error) {
      const message = errorText(error);
      for (const state of work.values()) this.addCleanupReason(state, `RELAY_TEST_ABORTED:${message}`);
    } finally {
      await this.emergencyCleanup(work);
    }

    const units = [...work.values()].map(({ result }) => {
      this.finalizeAction(result.alarm);
      this.finalizeAction(result.fault);
      result.verdict = result.alarm.verdict === 'FAIL' || result.fault.verdict === 'FAIL'
        ? 'FAIL'
        : result.alarm.verdict === 'TEST_INVALID' || result.fault.verdict === 'TEST_INVALID'
          ? 'TEST_INVALID'
          : result.alarm.verdict === 'PASS' && result.fault.verdict === 'PASS'
            ? 'PASS'
            : 'FAIL';
      return result;
    });

    const verdict = units.some((unit) => unit.verdict === 'FAIL')
      ? 'FAIL'
      : units.some((unit) => unit.verdict === 'TEST_INVALID')
        ? 'TEST_INVALID'
        : units.length > 0 && units.every((unit) => unit.verdict === 'PASS')
          ? 'PASS'
          : 'FAIL';

    console.log(`[继电器检测][COMPLETE] batch=${batchId ?? '-'} verdict=${verdict} ${units.map((unit) => `D${unit.detectorIndex}=${unit.verdict}`).join(' ')}`);
    return {
      batchId,
      mode: this.config.mode,
      phase: 'COMPLETE',
      startedAt,
      completedAt: Date.now(),
      verdict,
      units,
    };
  }
}
