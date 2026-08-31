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
  const rawFire = fire ? 0x0000 : 0xFFFF;
  const rawFault = fault ? 0x0001 : 0x0000;
  await device.writeRegisters(FLAME_DETECTOR_REGISTERS.FIRE_ALARM_STATUS, [rawFire, rawFault]);
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
