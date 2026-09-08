import {
  FLAME_DETECTOR_REGISTERS,
  type FlameDetectorDevice,
} from './flame-detector-device.js';

export interface AlarmFaultSimulationState {
  fire: boolean;
  fault: boolean;
  rawFire: number;
  rawFault: number;
}

export interface LatchedAlarmFaultState {
  fire: boolean;
  fault: boolean;
  rawFire: number;
  rawFault: number;
}

export interface RelaySimulationVerificationDetails {
  requested: AlarmFaultSimulationState;
  readback: AlarmFaultSimulationState;
  latched: LatchedAlarmFaultState;
}

export class RelaySimulationVerificationError extends Error {
  readonly code = 'RELAY_SIMULATION_NOT_EFFECTIVE';

  constructor(readonly details: RelaySimulationVerificationDetails) {
    const requested = `${details.requested.rawFire.toString(16).padStart(4, '0')}/${details.requested.rawFault.toString(16).padStart(4, '0')}`;
    const readback = `${details.readback.rawFire.toString(16).padStart(4, '0')}/${details.readback.rawFault.toString(16).padStart(4, '0')}`;
    const latched = `${details.latched.rawFire.toString(16).padStart(4, '0')}/${details.latched.rawFault.toString(16).padStart(4, '0')}`;
    super(`RELAY_SIMULATION_NOT_EFFECTIVE requested=${requested} readback=${readback} latched=${latched}`);
    this.name = 'RelaySimulationVerificationError';
  }
}

export function requestedAlarmFaultSimulationState(fire: boolean, fault: boolean): AlarmFaultSimulationState {
  return {
    fire,
    fault,
    rawFire: fire ? 0x0000 : 0xFFFF,
    rawFault: fault ? 0x0001 : 0x0000,
  };
}

export function alarmFaultSimulationMatches(
  requested: AlarmFaultSimulationState,
  readback: AlarmFaultSimulationState,
  latched: LatchedAlarmFaultState,
): boolean {
  return readback.rawFire === requested.rawFire
    && readback.rawFault === requested.rawFault
    && latched.fire === requested.fire
    && latched.fault === requested.fault;
}

/**
 * 实机已验证：当前固件不能分别单寄存器写 A000/A001；必须从 A000 开始
 * 使用 FC10 连续写两个寄存器。
 *
 * normal      = FFFF / 0000
 * fire        = 0000 / 0000
 * fault       = FFFF / 0001
 * fire+fault  = 0000 / 0001
 */
export async function setAlarmFaultSimulation(
  device: FlameDetectorDevice,
  fire: boolean,
  fault: boolean,
): Promise<void> {
  const requested = requestedAlarmFaultSimulationState(fire, fault);
  await device.writeRegisters(FLAME_DETECTOR_REGISTERS.FIRE_ALARM_STATUS, [requested.rawFire, requested.rawFault]);
}

export async function simulateAlarm(device: FlameDetectorDevice): Promise<void> {
  await setAlarmFaultSimulation(device, true, false);
}

export async function simulateFault(device: FlameDetectorDevice): Promise<void> {
  await setAlarmFaultSimulation(device, false, true);
}

export async function simulateAlarmAndFault(device: FlameDetectorDevice): Promise<void> {
  await setAlarmFaultSimulation(device, true, true);
}

/** 仅用于诊断/恢复验证；正式生产流程优先调用 F000=1234 系统复位。 */
export async function writeNormalSimulationState(device: FlameDetectorDevice): Promise<void> {
  await setAlarmFaultSimulation(device, false, false);
}

export async function readAlarmFaultSimulation(device: FlameDetectorDevice): Promise<AlarmFaultSimulationState> {
  const values = await device.readRegisters(FLAME_DETECTOR_REGISTERS.FIRE_ALARM_STATUS, 2);
  const rawFire = values[0] ?? 0xFFFF;
  const rawFault = values[1] ?? 0;
  const signedFire = rawFire > 0x7FFF ? rawFire - 0x10000 : rawFire;
  return {
    fire: signedFire >= 0,
    fault: rawFault !== 0,
    rawFire,
    rawFault,
  };
}

export async function readLatchedAlarmFaultState(device: FlameDetectorDevice): Promise<LatchedAlarmFaultState> {
  const values = await device.readRegisters(FLAME_DETECTOR_REGISTERS.LATCHED_ALARM_STATUS, 2);
  const rawFire = values[0] ?? 0;
  const rawFault = values[1] ?? 0;
  return {
    fire: rawFire === 1,
    fault: rawFault === 1,
    rawFire,
    rawFault,
  };
}

export async function resetAlarmFaultSimulation(device: FlameDetectorDevice): Promise<void> {
  await device.systemReset();
}
