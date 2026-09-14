import {
  FLAME_DETECTOR_REGISTERS,
  SEND_MODE_BROADCAST_ADDRESS,
  getRawTcpSocket,
  type FlameDetectorDevice,
} from './flame-detector-device.js';
import { calculateModbusCRC16 } from './flame-data-decoder.js';

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

function buildBroadcastWriteRegistersFrame(startAddress: number, values: number[]): Buffer {
  if (!Number.isInteger(startAddress) || startAddress < 0 || startAddress > 0xFFFF) {
    throw new Error(`广播写寄存器起始地址非法: ${startAddress}`);
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 123) {
    throw new Error(`广播写寄存器数量非法: ${values?.length ?? 0}`);
  }

  const body = Buffer.alloc(7 + values.length * 2);
  body[0] = SEND_MODE_BROADCAST_ADDRESS;
  body[1] = 0x10;
  body.writeUInt16BE(startAddress & 0xFFFF, 2);
  body.writeUInt16BE(values.length, 4);
  body[6] = values.length * 2;
  values.forEach((value, index) => body.writeUInt16BE(Number(value) & 0xFFFF, 7 + index * 2));

  const crc = calculateModbusCRC16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >>> 8) & 0xFF])]);
}

async function writeBroadcastRegisters(
  device: FlameDetectorDevice,
  startAddress: number,
  values: number[],
): Promise<void> {
  const client = (device as unknown as { client?: unknown }).client;
  const socket = getRawTcpSocket(client);

  // 现场 TCP 拓扑为“一个 TCP 端口仅挂一个探测器”，控制写命令统一使用 FF 广播地址；
  // 端口本身负责区分 D1-D6，禁止 detectorIndex/unit.address 参与控制帧地址。
  if (socket) {
    if (socket.destroyed || socket.writable === false) {
      throw new Error('探测器 TCP 连接不可写');
    }
    const request = buildBroadcastWriteRegistersFrame(startAddress, values);
    await new Promise<void>((resolve, reject) => {
      try {
        socket.write(request, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    // FF 广播写在现场为单向控制，不等待 Modbus 写回包。
    return;
  }

  // 非 Raw TCP 连接保留原有地址写逻辑，避免影响 RTU/诊断兼容路径。
  await device.writeRegisters(startAddress, values);
}

/**
 * 实机已验证：当前固件不能分别单寄存器写 A000/A001；必须从 A000 开始
 * 使用 FC10 连续写两个寄存器。
 *
 * TCP 独立端口现场控制统一使用 FF 广播地址：
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
  await writeBroadcastRegisters(FLAME_DETECTOR_REGISTERS.FIRE_ALARM_STATUS, [rawFire, rawFault]);
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
  await writeBroadcastRegisters(FLAME_DETECTOR_REGISTERS.SYSTEM_RESET, [0x1234]);
}
