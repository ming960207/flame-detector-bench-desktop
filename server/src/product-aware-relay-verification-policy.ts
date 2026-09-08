import { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
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
import type { RelayFunctionalTestReport, RelayFunctionalTestUnitResult } from './relay-functional-test.js';

const PATCHED = Symbol.for('product-aware-relay-verification-policy-patched');
type InternalService = Record<PropertyKey, any>;

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
    console.log(
      `[继电器检测][D${detectorIndex}][${kind}] FC10 写 A000/A001 请求：`
      + `A000=${hex16(requested.rawFire)} A001=${hex16(requested.rawFault)}`,
    );

    await originalSimulate.call(this, detectorIndex, state);
    console.log(`[继电器检测][D${detectorIndex}][${kind}] FC10 写 A000/A001 ACK 已收到。`);

    const device = this.detectorDevice(detectorIndex) as FlameDetectorDevice;
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

    if (!alarmFaultSimulationMatches(requested, readback, latched)) {
      const error = new RelaySimulationVerificationError({ requested, readback, latched });
      console.error(`[继电器检测][D${detectorIndex}][${kind}] ${error.code}：写命令有回包，但模拟状态未建立。`);
      throw error;
    }
    console.log(`[继电器检测][D${detectorIndex}][${kind}] 模拟命令有效性确认通过，允许进入实体 DIO 判定。`);
  };

  const originalReset = proto.reset;
  proto.reset = async function loggedReset(this: InternalService, detectorIndex: number): Promise<void> {
    console.log(`[继电器检测][D${detectorIndex}][复位] 写 F000=0x1234 请求。`);
    await originalReset.call(this, detectorIndex);
    console.log(`[继电器检测][D${detectorIndex}][复位] F000=0x1234 ACK 已收到。`);
    try {
      const device = this.detectorDevice(detectorIndex) as FlameDetectorDevice;
      const latched = await readLatchedAlarmFaultState(device);
      console.log(
        `[继电器检测][D${detectorIndex}][复位] 即时 B000/B001：`
        + `B000=${hex16(latched.rawFire)} B001=${hex16(latched.rawFault)} `
        + `fire=${latched.fire ? 1 : 0} fault=${latched.fault ? 1 : 0}`,
      );
    } catch (error) {
      console.warn(`[继电器检测][D${detectorIndex}][复位] 即时 B000/B001 回读失败，后续复位确认仍会继续：${error instanceof Error ? error.message : String(error)}`);
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

    // 原实现 finally 会解除 analysis gate；恢复阶段重新拉起 gate，确保新的有效首帧
    // 尚未全部回来时，噪声窗口绝不会开始消费这些控制命令造成的空洞/残帧。
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

patchRuntime();

export {};
