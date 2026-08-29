/**
 * 共享类型定义
 */

// DI/DO 状态
export interface IOState {
  relayId: string;  // PLC设备标识
  di: boolean[];
  do: boolean[];
  timestamp: number;
}

export interface PLCProcessStatus {
  stageCode: number;
  stepCode: number;
  autoRunning: boolean;
  complete: boolean;
  alarm: boolean;
  returningHome: boolean;
  stage: 'IDLE' | 'INIT' | 'HEAT' | 'FLASH' | 'EMC' | 'RETURN_HOME' | 'COMPLETE' | 'FAULT' | 'UNKNOWN';
  label: string;
  processStage: 'IDLE' | 'INIT' | 'HEAT' | 'FLASH' | 'EMC' | 'RETURN_HOME' | 'COMPLETE' | 'UNKNOWN';
  processLabel: string;
  valid: boolean;
  reason?: string;
  timestamp: number;
}

// PLC设备配置（与前端同步）
export interface PLCDeviceConfig {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'TCP' | 'RTU' | 'S7';
  ip: string;
  port: number;
  slaveId: number;
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  diCount: number;
  doCount: number;
  pollIntervalMs?: number;
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

// 火焰探测器单台状态
export interface FlameSample {
  probe1: number;
  probe2: number;
  probe3: number;
  probe4?: number;
}

export interface FlameFeature {
  snr2: number;
  snr21: number;
  snr23: number;
  snr31: number;
  snr43?: number;
  peakPower: number;
}

export interface FlameDetectorUnitState {
  index: number;
  address: number;
  online: boolean;
  fire: boolean;
  fault: boolean;
  sourceReady: boolean;
  syncOk: boolean;
  probe1: number;
  probe2: number;
  probe3: number;
  probe4?: number;
  probe1Absolute?: number;
  probe2Absolute?: number;
  probe3Absolute?: number;
  probe4Absolute?: number;
  probe1Fluctuation?: number;
  probe2Fluctuation?: number;
  probe3Fluctuation?: number;
  probe4Fluctuation?: number;
  snr21: number;
  snr23: number;
  snr31: number;
  sensitivity: number;
  sendMode: number;
  version: string;
  address_r: number;
  runTime: number;
  probeCount: number;
  lastUpdate: number;
  protocol?: 'standard' | 'four-wavelength';
  features?: FlameFeature[];
  samples?: FlameSample[];
  rawSamples?: FlameSample[];
  historySamples?: FlameSample[];
  rawHistorySamples?: FlameSample[];
  historySampleTotal?: number;
  lastError?: string;
}

// 火焰探测器全量状态
export interface FlameDetectorState {
  units: FlameDetectorUnitState[];
  onlineCount: number;
  fireCount: number;
  faultCount: number;
  timestamp: number;
}

// 火焰探测器增量波形状态。首次连接仍发送 FlameDetectorState 全量历史，
// 后续只携带本次新增的采样点，网页端在本地维护完整窗口。
export interface FlameDetectorWaveformDeltaUnit extends Omit<FlameDetectorUnitState, 'historySamples' | 'rawHistorySamples'> {
  historyReset: boolean;
  historyDelta: FlameSample[];
  rawHistoryDelta: FlameSample[];
}

export interface FlameDetectorWaveformDelta {
  units: FlameDetectorWaveformDeltaUnit[];
  onlineCount: number;
  fireCount: number;
  faultCount: number;
  timestamp: number;
}

// WebSocket 消息类型
export enum WSMessageType {
  // 服务端推送
  IO_STATE = 'io_state',
  FLAME_STATE = 'flame_state',
  FLAME_WAVEFORM_DELTA = 'flame_waveform_delta',
  CONNECTION_STATUS = 'connection_status',
  ERROR = 'error',
  CLOSURE_STATE = 'closure_state',
  CLOSURE_COMMAND_RESULT = 'closure_command_result',
  PLC_PROCESS_STATUS = 'plc_process_status',
  FIELD_SUMMARY = 'field_summary',
  FLAME_TEST_PROGRESS = 'flame_test_progress',

  // 客户端请求
  SET_DO = 'set_do',
  SET_DO_MULTI = 'set_do_multi',
  SET_ALL_DO = 'set_all_do',
  SET_ONLY_ONE_DO = 'set_only_one_do',
  DISCONNECT_ALL_DO = 'disconnect_all_do',
  UPDATE_CONFIG = 'update_config',
  CLOSURE_COMMAND = 'closure_command',
}

// WebSocket 消息结构
export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  timestamp: number;
}

// PLC连接状态（兼容旧版relay字段名）
export interface PLCConnectionStatus {
  connected: boolean;
  mode?: 'TCP' | 'RTU' | 'S7';
  ip: string;
  port: number;
  serialPath?: string;
  lastError?: string;
}

// 设备连接状态
export interface ConnectionStatus {
  relay: PLCConnectionStatus;    // 保留relay字段名兼容
  relays?: PLCDeviceStatus[];
  flame?: {
    connected: boolean;
    /** 串口服务器 TCP 会话状态，不代表探测器波形有效。 */
    transportConnected?: boolean;
    /** 最近是否收到探测器合法波形数据。 */
    dataStreamConnected?: boolean;
    mode?: 'TCP' | 'RTU' | 'S7';
    lastError?: string;
  };
}

// DO 控制请求
export interface SetDORequest {
  channel: number;  // 1-12
  value: boolean;
}

// 多路 DO 控制请求
export interface SetDOMultiRequest {
  channels: { channel: number; value: boolean }[];
}
