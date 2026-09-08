import { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
import { RelayFunctionalTestCoordinator } from './relay-functional-test-coordinator.js';
import {
  beginRelayLiveState,
  finishRelayLiveState,
  updateRelayLiveInternal,
  updateRelayLivePhysical,
} from './relay-live-state.js';
import {
  alarmFaultSimulationMatches,
  readAlarmFaultSimulation,
  readLatchedAlarmFaultState,
  RelaySimulationVerificationError,
  requestedAlarmFaultSimulationState,
} from './modbus/flame-detector-relay-simulation.js';
import {
  pauseWaveformRecoveryForControlWindow,
  resumeAndRecoverWaveformAfterControlWindow,
} from './modbus/flame-detector-waveform-control-window.js';
import type { FlameDetectorDevice } from './modbus/flame-detector-device.js';
import type { ProductPrecheckReport } from './product-profile.js';
import type {
  RelayFunctionalTestConfig,
  RelayFunctionalTestReport,
} from './relay-functional-test.js';

const PATCHED = Symbol.for('product-aware-relay-verification-policy-patched');
const BASELINE_PATCHED = Symbol.for('relay-functional-test-runtime-baseline-policy-patched');
const VERIFY_DELAYS_MS = [80, 160, 220] as const;
type InternalService = Record<PropertyKey, any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hex16(value: number): string {
  return `0x${(Number(value) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')}`;
}

function relayKind(state: { fire: boolean; fault: boolean }): string {
  if (state.fire && state.fault) return '火警+故障';
  if (state.fire) return '火警';
  if (state.fault) return '故障';
  return '正常';
}

function infrastructureOnly(report: RelayFunctionalTestReport): boolean {
  if (report.verdict !== 'FAIL' || report.units.length === 0) return false;
  const allowed = [
    'RELAY_TEST_GLOBAL_DISABLED',
    'DIO_NOT_CONFIGURED',
    'RELAY_FEEDBACK_MAPPING_MISSING:',
  ];
  const reasons = report.units.flatMap((unit) => [...unit.alarm.reasons, ...unit.fault.reasons]);
  return reasons.length > 0 && reasons.every((reason) => {
    const normalized = reason.replace(/^(ALARM|FAULT):/, '');
    return allowed.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
  });
}

function markInfrastructureInvalid(report: RelayFunctionalTestReport): void {
  if (!infrastructureOnly(report)) return;
  report.verdict = 'TEST_INVALID';
  for (const unit of report.units) {
    unit.verdict = 'TEST_INVALID';
    unit.alarm.verdict = 'TEST_INVALID';
    unit.fault.verdict = 'TEST_INVALID';
  }
}

function stripInvalidRelayFailureReasons(report: ProductPrecheckReport): void {
  const relay = report.relayFunctionalTest;
  if (!relay) return;
  markInfrastructureInvalid(relay);

  for (const relayUnit of relay.units) {
    if (relayUnit.verdict !== 'TEST_INVALID') continue;
    const unit = report.units.find((item) => item.index === relayUnit.detectorIndex);
    if (!unit) continue;
    unit.reasons = unit.reasons.filter((reason) => (
      reason !== 'RELAY_FUNCTIONAL_TEST_FAILED'
      && !reason.startsWith('RELAY:')
    ));
    unit.verdict = unit.reasons.length === 0 ? 'PASS' : 'FAIL';
    console.warn(
      `[产品预检][D${unit.index}] 继电器检测=TEST_INVALID；模拟状态/反馈链路未形成有效证据，不判产品 NG。`,
    );
  }
  report.verdict = report.units.length > 0 && report.units.every((unit) => unit.verdict === 'PASS') ? 'PASS' : 'FAIL';
}

/**
 * 现场 DIO 的 0/1 是输入模块原始电平，不等于“继电器正常/动作”。
 * 每次正式继电器检测前学习本批实际 baseline；动作看相对 baseline 的变化，
 * 复位要求回到 baseline。运行期 baseline 不写回 system-config.json。
 */
function patchRelayRuntimeBaseline(): void {
  const proto = RelayFunctionalTestCoordinator.prototype as unknown as InternalService;
  if (proto[BASELINE_PATCHED]) return;
  proto[BASELINE_PATCHED] = true;

  const originalLogInternal = proto.logInternal;
  proto.logInternal = function logInternalWithLiveState(
    this: InternalService,
    context: string,
    index: number,
    internal: { fire: boolean; fault: boolean },
  ): void {
    originalLogInternal.call(this, context, index, internal);
    updateRelayLiveInternal(index, internal, context);
  };

  const originalLogDio = proto.logDio;
  proto.logDio = function logDioWithLiveState(
    this: InternalService,
    context: string,
    index: number,
    inputs: Record<string, boolean> | undefined,
    alarm: boolean | null,
    fault: boolean | null,
    error?: string,
  ): void {
    originalLogDio.call(this, context, index, inputs, alarm, fault, error);
    if (!error) updateRelayLivePhysical(index, { alarm, fault }, context);
  };

  const originalRun = proto.run;
  proto.run = async function runWithRuntimeDioBaseline(
    this: InternalService,
    batchId: string | null = null,
  ): Promise<RelayFunctionalTestReport> {
    const relayConfig = this.config as RelayFunctionalTestConfig | undefined;
    const feedback = this.feedback as { readInputs?: () => Record<string, boolean> | undefined | Promise<Record<string, boolean> | undefined> } | undefined;
    const detectorIndexes = typeof this.detectors?.enabledDetectorIndexes === 'function'
      ? this.detectors.enabledDetectorIndexes() as number[]
      : relayConfig?.mappings.map((mapping) => mapping.detectorIndex) ?? [];
    beginRelayLiveState(batchId, detectorIndexes);

    try {
      if (relayConfig?.enabled && feedback?.readInputs) {
        try {
          const inputs = await feedback.readInputs();
          if (inputs) {
            for (const mapping of relayConfig.mappings) {
              const configuredAlarm = mapping.alarmNormalLevel;
              const configuredFault = mapping.faultNormalLevel;
              const alarmRaw = inputs[mapping.alarmInputAddress];
              const faultRaw = inputs[mapping.faultInputAddress];

              if (typeof alarmRaw === 'boolean') mapping.alarmNormalLevel = alarmRaw;
              if (typeof faultRaw === 'boolean') mapping.faultNormalLevel = faultRaw;

              const alarmText = typeof alarmRaw === 'boolean' ? (alarmRaw ? 1 : 0) : '?';
              const faultText = typeof faultRaw === 'boolean' ? (faultRaw ? 1 : 0) : '?';
              console.log(
                `[继电器检测][BASELINE_AUTO][D${mapping.detectorIndex}] `
                + `alarm=${mapping.alarmInputAddress || '-'} baselineRaw=${alarmText} configuredNormal=${configuredAlarm ? 1 : 0}; `
                + `fault=${mapping.faultInputAddress || '-'} baselineRaw=${faultText} configuredNormal=${configuredFault ? 1 : 0}; `
                + '本批后续动作/复位均按相对 baseline 变化判定。',
              );
            }
          } else {
            console.warn('[继电器检测][BASELINE_AUTO] DIO 未返回输入，本次由协调器原有基线校验继续处理。');
          }
        } catch (error) {
          console.warn(
            `[继电器检测][BASELINE_AUTO] 预读 DIO 基线失败，本次由协调器原有错误链继续处理：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return await originalRun.call(this, batchId) as RelayFunctionalTestReport;
    } finally {
      finishRelayLiveState();
    }
  };
}

async function verifySimulationState(
  device: FlameDetectorDevice,
  detectorIndex: number,
  kind: string,
  requested: ReturnType<typeof requestedAlarmFaultSimulationState>,
): Promise<{ matched: boolean; details?: any; error?: unknown }> {
  let lastDetails: any;
  let lastError: unknown;
  for (const delay of VERIFY_DELAYS_MS) {
    await sleep(delay);
    try {
      const readback = await readAlarmFaultSimulation(device);
      console.log(
        `[继电器检测][D${detectorIndex}][${kind}] A000/A001 回读：`
        + `A000=${hex16(readback.rawFire)} A001=${hex16(readback.rawFault)} `
        + `fire=${readback.fire ? 1 : 0} fault=${readback.fault ? 1 : 0}`,
      );
      const latched = await readLatchedAlarmFaultState(device);
      console.log(
        `[继电器检测][D${detectorIndex}][${kind}] B000/B001 回读：`
        + `B000=${hex16(latched.rawFire)} B001=${hex16(latched.rawFault)} `
        + `fire=${latched.fire ? 1 : 0} fault=${latched.fault ? 1 : 0}`,
      );
      updateRelayLiveInternal(detectorIndex, { fire: latched.fire, fault: latched.fault }, `${kind}_VERIFY`);
      lastDetails = { requested, readback, latched };
      if (alarmFaultSimulationMatches(requested, readback, latched)) return { matched: true, details: lastDetails };
    } catch (error) {
      lastError = error;
      console.warn(`[继电器检测][D${detectorIndex}][${kind}] 状态回读暂未确认，继续短时验证：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { matched: false, details: lastDetails, error: lastError };
}

async function resetStateCleared(
  device: FlameDetectorDevice,
  detectorIndex: number,
): Promise<{ cleared: boolean; error?: unknown }> {
  let lastError: unknown;
  for (const delay of VERIFY_DELAYS_MS) {
    await sleep(delay);
    try {
      const latched = await readLatchedAlarmFaultState(device);
      console.log(
        `[继电器检测][D${detectorIndex}][复位] 即时 B000/B001：`
        + `B000=${hex16(latched.rawFire)} B001=${hex16(latched.rawFault)} `
        + `fire=${latched.fire ? 1 : 0} fault=${latched.fault ? 1 : 0}`,
      );
      updateRelayLiveInternal(detectorIndex, { fire: latched.fire, fault: latched.fault }, 'RESET_IMMEDIATE');
      if (!latched.fire && !latched.fault) return { cleared: true };
    } catch (error) {
      lastError = error;
      console.warn(`[继电器检测][D${detectorIndex}][复位] B000/B001 暂未确认，继续短时验证：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { cleared: false, error: lastError };
}

function patchRuntime(): void {
  const proto = ProductAwareFlameDetectorService.prototype as unknown as InternalService;
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

  const originalSimulate = proto.simulate;
  proto.simulate = async function verifiedSimulate(
    this: InternalService,
    detectorIndex: number,
    state: { fire: boolean; fault: boolean },
  ): Promise<void> {
    const requested = requestedAlarmFaultSimulationState(state.fire, state.fault);
    const kind = relayKind(state);
    const device = this.detectorDevice(detectorIndex) as FlameDetectorDevice;
    console.log(
      `[继电器检测][D${detectorIndex}][${kind}] FC10 写 A000/A001 请求：`
      + `A000=${hex16(requested.rawFire)} A001=${hex16(requested.rawFault)}`,
    );

    let commandError: unknown;
    try {
      await originalSimulate.call(this, detectorIndex, state);
      console.log(`[继电器检测][D${detectorIndex}][${kind}] FC10 写 A000/A001 ACK 已收到。`);
    } catch (error) {
      commandError = error;
      console.warn(`[继电器检测][D${detectorIndex}][${kind}] FC10 ACK 未确认，先回读 A/B 状态判断命令是否实际生效：${error instanceof Error ? error.message : String(error)}`);
    }

    let verification = await verifySimulationState(device, detectorIndex, kind, requested);
    if (verification.matched) {
      console.log(`[继电器检测][D${detectorIndex}][${kind}] ${commandError ? 'ACK丢失但内部状态已确认；' : ''}模拟命令有效性确认通过，允许进入实体 DIO 判定。`);
      return;
    }

    if (commandError) {
      console.warn(`[继电器检测][D${detectorIndex}][${kind}] 首次 ACK 丢失且状态未建立，执行一次受限重发。`);
      try {
        await originalSimulate.call(this, detectorIndex, state);
        commandError = undefined;
        console.log(`[继电器检测][D${detectorIndex}][${kind}] 受限重发 ACK 已收到。`);
      } catch (error) {
        commandError = error;
        console.warn(`[继电器检测][D${detectorIndex}][${kind}] 受限重发 ACK 仍未确认：${error instanceof Error ? error.message : String(error)}`);
      }
      verification = await verifySimulationState(device, detectorIndex, kind, requested);
      if (verification.matched) {
        console.log(`[继电器检测][D${detectorIndex}][${kind}] 重发后内部状态确认通过，允许进入实体 DIO 判定。`);
        return;
      }
    }

    if (verification.details) {
      const error = new RelaySimulationVerificationError(verification.details);
      console.error(`[继电器检测][D${detectorIndex}][${kind}] ${error.code}：模拟状态最终未建立。`);
      throw error;
    }
    throw verification.error ?? commandError ?? new Error('RELAY_SIMULATION_VERIFICATION_UNAVAILABLE');
  };

  const originalReset = proto.reset;
  proto.reset = async function verifiedReset(this: InternalService, detectorIndex: number): Promise<void> {
    const device = this.detectorDevice(detectorIndex) as FlameDetectorDevice;
    console.log(`[继电器检测][D${detectorIndex}][复位] 写 F000=0x1234 请求。`);
    let commandError: unknown;
    try {
      await originalReset.call(this, detectorIndex);
      console.log(`[继电器检测][D${detectorIndex}][复位] F000=0x1234 ACK 已收到。`);
    } catch (error) {
      commandError = error;
      console.warn(`[继电器检测][D${detectorIndex}][复位] ACK 未确认，先通过 B000/B001 判断复位是否已经实际生效：${error instanceof Error ? error.message : String(error)}`);
    }

    let verification = await resetStateCleared(device, detectorIndex);
    if (verification.cleared) {
      if (commandError) console.log(`[继电器检测][D${detectorIndex}][复位] ACK丢失但 B000/B001 已清零，按复位成功继续。`);
      return;
    }

    if (commandError) {
      console.warn(`[继电器检测][D${detectorIndex}][复位] 首次 ACK 丢失且内部状态未清零，执行一次受限重发。`);
      try {
        await originalReset.call(this, detectorIndex);
        commandError = undefined;
        console.log(`[继电器检测][D${detectorIndex}][复位] 受限重发 ACK 已收到。`);
      } catch (error) {
        commandError = error;
        console.warn(`[继电器检测][D${detectorIndex}][复位] 受限重发 ACK 仍未确认：${error instanceof Error ? error.message : String(error)}`);
      }
      verification = await resetStateCleared(device, detectorIndex);
      if (verification.cleared) return;
      if (commandError) throw commandError;
    }

    // ACK 已收到但即时内部状态尚未清零时，不抢先判失败；协调器原有的
    // resetTimeoutMs 稳定验证仍会继续，并最终决定 PASS/FAIL/TEST_INVALID。
    if (verification.error) {
      console.warn(`[继电器检测][D${detectorIndex}][复位] 即时回读仍不稳定，交由后续复位窗口继续确认：${verification.error instanceof Error ? verification.error.message : String(verification.error)}`);
    }
  };

  const originalRunProductPrecheck = proto.runProductPrecheck;
  proto.runProductPrecheck = async function controlledRunProductPrecheck(
    this: InternalService,
    productConfig: Parameters<ProductAwareFlameDetectorService['runProductPrecheck']>[0],
    batchId: string | null = null,
  ): Promise<ProductPrecheckReport> {
    const service = this as unknown as ProductAwareFlameDetectorService;
    const indexes = service.enabledDetectorIndexes();
    pauseWaveformRecoveryForControlWindow(service, `product-precheck:${batchId ?? '-'}`);

    let report: ProductPrecheckReport | undefined;
    let precheckError: unknown;
    try {
      report = await originalRunProductPrecheck.call(this, productConfig, batchId) as ProductPrecheckReport;
      stripInvalidRelayFailureReasons(report);
    } catch (error) {
      precheckError = error;
    }

    this.precheckAnalysisBlocked = true;
    this.precheckAnalysisRecoveryUntil = 0;
    let recoveryError: unknown;
    try {
      await resumeAndRecoverWaveformAfterControlWindow(service, indexes, 15_000);
    } catch (error) {
      recoveryError = error;
      console.error(`[产品预检] 控制窗口结束后的波形恢复失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.precheckAnalysisBlocked = false;
      this.precheckAnalysisRecoveryUntil = Date.now() + 500;
    }

    if (precheckError && recoveryError) {
      throw new AggregateError([precheckError, recoveryError], '产品预检与波形恢复均失败');
    }
    if (precheckError) throw precheckError;
    if (recoveryError) throw recoveryError;
    if (!report) throw new Error('PRODUCT_PRECHECK_REPORT_MISSING');
    return report;
  };
}

patchRelayRuntimeBaseline();
patchRuntime();

export {};
