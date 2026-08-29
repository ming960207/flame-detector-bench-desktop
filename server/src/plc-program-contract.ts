export interface PLCSignalDefinition {
  key: string;
  address: string;
  label: string;
}

/**
 * EMC 工序的实际 PLC 输出链路：M11.2 AND M31.7 → Q0.7。
 * M31.7 是 PLC 的输出安全使能，Q0.7 才是当前工程的电磁干扰继电器。
 */
export const PLC_EMC_MAPPING = {
  controlBit: { address: 'M11.2', label: '电磁干扰工序/控制位' },
  safetyGate: { address: 'M31.7', label: '输出安全使能' },
  physicalOutput: { address: 'Q0.7', label: '电磁干扰继电器' },
} as const;

/**
 * 地址与当前工程 PLC.awl 保持同一份可读契约，现场状态读取和主屏展示都从这里取名。
 * 这份映射只描述只读监测点，不改变 PLC 的控制逻辑。
 */
export const PLC_PROGRAM = {
  inputs: [
    { key: 'startPosition', address: 'I0.0', label: '初始位置传感器' },
    { key: 'zone1Position', address: 'I0.2', label: '检测区1位置传感器' },
    { key: 'zone2Position', address: 'I0.1', label: '检测区2位置传感器' },
    { key: 'safetyInput', address: 'I1.0', label: '安全/急停输入' },
    { key: 'autoStartInput', address: 'I1.3', label: '自动启动输入（闭合脉冲触发开始工序）' },
    { key: 'verticalDownFeedback', address: 'I0.4', label: '垂直下限反馈' },
    { key: 'verticalUpFeedback', address: 'I0.3', label: '垂直上限反馈' },
  ] satisfies readonly PLCSignalDefinition[],
  relays: [
    { key: 'heatSource', address: 'Q0.1', label: '模拟人温度/热源' },
    { key: 'verticalPower', address: 'Q0.4', label: '上下电机总电源' },
    { key: 'horizontalRun', address: 'Q0.5', label: '左右电机运行' },
    { key: 'horizontalStop', address: 'Q0.6', label: '左右电机停止' },
    { key: 'electromagneticRelay', address: 'Q0.7', label: '电磁干扰继电器' },
    { key: 'handTestCylinder', address: 'Q1.0', label: '气缸/挥手测试' },
    { key: 'verticalDirection', address: 'Q1.1', label: '垂直方向（1上/0下）' },
    { key: 'flashLamp1', address: 'Q1.2', label: '爆闪灯1' },
    { key: 'flashLamp2', address: 'Q1.3', label: '爆闪灯2' },
  ] satisfies readonly PLCSignalDefinition[],
  internal: [
    { key: 'autoRunning', address: 'M0.0', label: '自动运行' },
    { key: 'complete', address: 'M0.1', label: '流程完成' },
    { key: 'processAlarm', address: 'M0.2', label: '流程报警' },
    { key: 'safetyOk', address: 'M0.3', label: '安全链满足' },
    { key: 'stopLatch', address: 'M1.0', label: '停止/中止锁存' },
    { key: 'stopRequest', address: 'M2.0', label: '停止请求' },
    { key: 'safetyLimit', address: 'M2.2', label: '安全限位' },
    { key: 'startRequest', address: 'M2.3', label: '启动请求' },
    { key: 'manualEnable', address: 'M2.4', label: '手动使能' },
    { key: 'signalStabilizing', address: 'M15.0', label: '热源位信号稳定阶段' },
    { key: 'noiseCaptureWindow', address: 'M25.2', label: '信号稳定后30秒噪声采集窗口' },
    { key: 'returnHomeFlag', address: 'M11.4', label: '回初始位标志' },
  ] satisfies readonly PLCSignalDefinition[],
  steps: [
    { key: 'stepM10_0', address: 'M10.0', label: '初始位垂直复位' },
    { key: 'stepM10_1', address: 'M10.1', label: '初始位确认' },
    { key: 'stepM10_2', address: 'M10.2', label: '检测区1定位' },
    { key: 'stepM10_3', address: 'M10.3', label: '热源位夹具下压' },
    { key: 'stepM10_4', address: 'M10.4', label: '热源干扰测试' },
    { key: 'stepM10_5', address: 'M10.5', label: '热源后夹具上升' },
    { key: 'stepM10_6', address: 'M10.6', label: '检测区2定位' },
    { key: 'stepM10_7', address: 'M10.7', label: '爆闪位夹具下压' },
    { key: 'stepM11_0', address: 'M11.0', label: '五次爆闪测试' },
    { key: 'stepM11_2', address: 'M11.2', label: '电磁干扰工序' },
    { key: 'stepM11_4', address: 'M11.4', label: '回初始位确认' },
  ] satisfies readonly PLCSignalDefinition[],
} as const;

export type PLCProgramArea = keyof typeof PLC_PROGRAM;

export const PLC_PROCESS_TAGS = [
  'DB1,INT600',
  'DB1,INT602',
  ...PLC_PROGRAM.inputs.map((item) => item.address),
  ...PLC_PROGRAM.relays.map((item) => item.address),
  ...PLC_PROGRAM.internal.map((item) => item.address),
  ...PLC_PROGRAM.steps.map((item) => item.address),
] as const;
