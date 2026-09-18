/** 现场用于继电器/状态联动验证的火焰探测器广播指令。 */

export type FlameDetectorSimulationCommand = 'simulateFire' | 'simulateFault' | 'systemReset';

export interface FlameDetectorSimulationCommandDefinition {
  readonly label: string;
  readonly description: string;
  /** 带空格的大写十六进制原始 RTU 帧，包含 CRC。 */
  readonly frameHex: string;
}

export const FLAME_DETECTOR_SIMULATION_COMMANDS: Readonly<Record<FlameDetectorSimulationCommand, FlameDetectorSimulationCommandDefinition>> = Object.freeze({
  simulateFire: Object.freeze({
    label: '模拟火警',
    description: '置位火警，故障保持正常',
    frameHex: 'FF 10 A0 00 00 02 04 00 00 00 00 3C 43',
  }),
  simulateFault: Object.freeze({
    label: '模拟故障',
    description: '置位故障，火警保持正常',
    frameHex: 'FF 10 A0 00 00 02 04 FF FF 00 01 FD A7',
  }),
  systemReset: Object.freeze({
    label: '系统复位',
    description: '清除当前模拟状态',
    frameHex: 'FF 10 F0 00 00 01 02 12 34 13 4C',
  }),
});

export function isFlameDetectorSimulationCommand(value: unknown): value is FlameDetectorSimulationCommand {
  return value === 'simulateFire' || value === 'simulateFault' || value === 'systemReset';
}
