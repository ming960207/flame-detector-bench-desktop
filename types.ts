
export enum LogicAction {
  WAIT = 'WAIT',
  ABORT = 'ABORT',
  JUMP = 'JUMP'
}

export interface ModbusConfig {
  protocol: 'TCP';
  interfaceType: 'LAN' | 'WIFI';
  ip: string;
  port: number;
  slaveId: number;
}

// PLC一体机配置（S7-200 SMART，支持TCP和RTU两种连接方式）
export interface PLCDeviceConfig {
  id: string;             // 唯一标识
  name: string;           // 显示名称
  enabled: boolean;       // 是否启用
  mode: 'TCP' | 'RTU' | 'S7';  // 连接模式：以太网TCP / RS485串口RTU / S7协议(端口102)
  // TCP 模式参数
  ip: string;             // IP地址（默认 192.168.2.1）
  port: number;           // 端口（默认 502）
  slaveId: number;        // 从站ID（默认 1）
  // RTU 模式参数
  serialPath?: string;    // 串口号（如 COM3）
  baudRate?: number;      // 波特率（默认 9600）
  dataBits?: number;      // 数据位（默认 8）
  stopBits?: number;      // 停止位（默认 1）
  parity?: string;        // 校验位（默认 none）
  // 通用参数
  diCount: number;        // DI点数（默认18，对应I0.0~I2.1）
  doCount: number;        // DO点数（默认12，对应Q0.0~Q1.3）
  pollIntervalMs?: number; // 轮询间隔(ms)，默认200
}

// PLC连接状态
export interface PLCDeviceStatus {
  id: string;
  name: string;
  connected: boolean;
  mode: 'TCP' | 'RTU' | 'S7';
  ip: string;
  port: number;
  serialPath?: string;
  lastError?: string;
}

// 火焰探测器单台配置
export interface FlameDetectorUnitConfig {
  index: number;       // 编号 1-6
  address: number;     // Modbus从站地址 1-247
  enabled: boolean;    // 是否启用
  // 每台独立连接配置（不填则使用全局配置）
  connMode?: 'RTU' | 'TCP';  // 独立通信模式
  serialPath?: string;       // 独立串口号 (如 COM3)
  baudRate?: number;          // 独立波特率
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  tcpHost?: string;           // 独立 TCP IP
  tcpPort?: number;           // 独立 TCP 端口
  protocol?: 'standard' | 'four-wavelength';
  imageAlarmEnabled?: boolean;
  imageAlarmZone?: number;
}

// 火焰探测器连接配置
export interface FlameDetectorConfig {
  mode: 'TCP' | 'RTU';       // 通信模式
  // TCP
  ip: string;
  port: number;
  // RTU
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  // 探测器列表
  units: FlameDetectorUnitConfig[];
  pollIntervalMs?: number;
  protocol?: 'standard' | 'four-wavelength';
  waveformSendMode?: 'active' | 'filtered';
  waveformModeSwitchLowerLimitGateEnabled?: boolean;
  waveformDisplayMode?: 'raw' | 'normalized';
  waveformMaxSamples?: number;
  waveformAnalysis?: Partial<FlameWaveformAnalysisConfig>;
}

export interface FlameWaveformAnalysisConfig {
  minNoiseSamples: number;
  minInterferenceSamples: number;
  minNoiseRms: number;
  maxNoiseRms: number;
  maxNoiseAbsolute?: number;
  maxInterferenceRatio: number;
  noiseProbes?: Array<'probe1' | 'probe2' | 'probe3' | 'probe4'>;
  interferenceRatio?: { numerator: 'probe1' | 'probe2' | 'probe3' | 'probe4'; denominator: 'probe1' | 'probe2' | 'probe3' | 'probe4' };
  consistencyProbes?: Array<'probe1' | 'probe2' | 'probe3' | 'probe4'>;
  minConsistencyTrend?: number;
  quality?: DetectionQualityConfig;
}

export interface DetectionSNRRange {
  min: number;
  max: number;
}

export interface DetectionQualityThresholds {
  maxNoiseRms: number;
  maxNoiseAbsolute?: number;
  maxInterferenceRatio: number;
  minSensitivity: number;
  minConsistencyTrend?: number;
}

export interface DetectionRatioThresholds {
  snr21: DetectionSNRRange;
  snr23: DetectionSNRRange;
  snr31: DetectionSNRRange;
}

export interface DetectionQualityConfig {
  acceptanceGrade: 'A' | 'B';
  a: DetectionQualityThresholds;
  b: DetectionQualityThresholds;
  ratios: { a: DetectionRatioThresholds; b: DetectionRatioThresholds };
}

// 火焰探测器单台运行状态
export interface FlameDetectorUnitState {
  index: number;        // 编号 1-6
  address: number;      // Modbus从站地址
  online: boolean;      // 是否在线
  fire: boolean;        // 是否火警
  fault: boolean;       // 是否故障
  sourceReady: boolean; // 光源板就绪
  syncOk: boolean;      // 同步信号正常
  probe1: number;       // 探头1波动值
  probe2: number;       // 探头2波动值
  probe3: number;       // 探头3波动值
  probe4?: number;      // 探头4波动值（四波长设备）
  probe1Absolute?: number;
  probe2Absolute?: number;
  probe3Absolute?: number;
  probe4Absolute?: number;
  probe1Fluctuation?: number;
  probe2Fluctuation?: number;
  probe3Fluctuation?: number;
  probe4Fluctuation?: number;
  snr21: number;        // 探头2/1比值
  snr23: number;        // 探头2/3比值
  snr31: number;        // 探头3/1比值
  sensitivity: number;  // 灵敏度
  sendMode: number;     // 发送模式
  version: string;      // 软件版本
  address_r: number;    // 设备地址（读回）
  runTime: number;      // 运行时长(s)
  probeCount: number;   // 探头数量
  lastUpdate: number;   // 最后更新时间戳
  protocol?: 'standard' | 'four-wavelength';
  features?: Array<{
    snr2: number;
    snr21: number;
    snr23: number;
    snr31: number;
    snr43?: number;
    peakPower: number;
  }>;
  samples?: Array<{ probe1: number; probe2: number; probe3: number; probe4?: number }>;
  rawSamples?: Array<{ probe1: number; probe2: number; probe3: number; probe4?: number }>;
  historySamples?: Array<{ probe1: number; probe2: number; probe3: number; probe4?: number }>;
  rawHistorySamples?: Array<{ probe1: number; probe2: number; probe3: number; probe4?: number }>;
  historySampleTotal?: number;
  lastError?: string;
}

// 图片标注
export interface Annotation {
  id: string;
  type: 'line' | 'rect' | 'arrow' | 'text';
  x1: number;
  y1: number;
  x2?: number;
  y2?: number;
  text?: string;
  color: string;
  strokeWidth: number;
  fontSize?: number;
}

// 多PLC DO配置
export interface MultiRelayDO {
  relayId: string;    // PLC设备ID
  doChannel: number;  // DO通道 1-12
}

export interface ProcessStep {
  id: string;
  name: string;
  duration: number; // in seconds
  waitTime: number; // delay before starting in seconds

  // IO Configuration (Modbus Mapping)
  diChannel?: number; // 1-18, DI通道
  doChannel?: number; // 1-12, DO通道 (兼容单PLC)
  diRelayId?: string; // DI所属PLC设备ID (可选，默认第一个)
  doRelayId?: string; // DO所属PLC设备ID (可选，默认第一个)

  // 多PLC联合控制 - 支持同时控制多个PLC的DO
  multiRelayDO?: MultiRelayDO[];

  holdRelayClosed?: boolean; // 已废弃，由 relayPulseCount 替代

  /**
   * 继电器启动次数
   *  0 → 持续输出（DO 全程保持闭合）
   *  N>0 → 脉冲 N 次，每次间隔 relayPulseInterval 秒
   * undefined → 回退到 holdRelayClosed 旧字段
   */
  relayPulseCount?: number;
  /** 脉冲切换间隔（秒），仅 relayPulseCount>0 时有效，默认 1s */
  relayPulseInterval?: number;

  // Input Validation Configuration
  checkCount?: number;
  checkInterval?: number;
  detectionInterval?: number;

  // Logic Configuration
  logicOnMissingInput: LogicAction;
  jumpToStepId?: string;

  // Visuals
  imageUrl?: string;
  originalImageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  annotations?: Annotation[];
}

export enum SystemStatus {
  IDLE = 'IDLE',
  WAITING_FOR_INPUT = 'WAITING_FOR_INPUT',
  RUNNING_STEP = 'RUNNING_STEP',
  WAITING_DELAY = 'WAITING_DELAY',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
  PAUSED = 'PAUSED'
}

export interface SystemState {
  currentStepId: string | null;
  status: SystemStatus;
  elapsedTimeInStep: number;
  elapsedWaitTime: number;
  startTime: number;
}

// 淋水测试配置
export interface WateringTestConfig {
  alarmDIChannel: number;
  maxResponseTime: number;
  testStepKeyword: string;
  operatorName?: string;
  deviceInfo?: string;
  alarmTriggerMode: 'DI' | 'SOFTWARE' | 'BOTH';
  autoUpload: boolean;
  watchdogEnabled: boolean;
  watchdogDIChannel: number;
  watchdogTimeout: number;
  watchdogAction: 'PAUSE' | 'ABORT';
}

// 测试点记录
export interface TestPointRecord {
  testPointId: string;
  testPointName: string;
  wateringStartTime: number;
  alarmTime: number | null;
  responseTime: number | null;
  alarmDIChannel: number;
  expectedMaxTime: number;
  passed: boolean;
}

// 测试报告
export interface WateringTestReport {
  reportId: string;
  reportTitle: string;
  testDate: string;
  testStartTime: number;
  testEndTime: number;
  totalDuration: number;
  operatorName?: string;
  deviceInfo?: string;
  testPoints: TestPointRecord[];
  overallPassed: boolean;
  remarks?: string;
}

// 手动测试状态枚举
export enum ManualTestStatus {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  WAITING_ALARM = 'WAITING_ALARM',
  COMPLETED = 'COMPLETED'
}

// 手动测试状态
export interface ManualTestState {
  status: ManualTestStatus;
  testStepIndex: number | null;
  testStepId: string | null;
  startTime: number | null;
  elapsedTime: number;
  alarmDetected: boolean;
  alarmTime: number | null;
  responseTime: number | null;
  previousSystemStatus: SystemStatus | null;
  previousStepIndex: number;
}

// DO 关联规则配置
export interface DORelationRule {
  interlocks: number[][];
  associations: {
    source: number;
    targets: number[];
  }[];
  linkages: {
    source: number;
    trigger: 'ON' | 'OFF';
    target: number;
    action: 'ON' | 'OFF' | 'TOGGLE';
  }[];
}

// MQTT 配置
export interface MQTTConfig {
  mqttEnabled: boolean;
  brokerUrl: string;
  topic: string;
  clientId: string;
  username?: string;
  password?: string;
  factoryId?: string;
  lineId?: string;
  deviceId?: string;
}
