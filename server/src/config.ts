import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FlameProtocolId } from './modbus/flame-protocol.js';
import type { WaveformAnalysisConfig } from './closure/field-waveform-analysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

// PLC一体机配置（现场 PLC.awl 对应 S7-200 SMART，使用 S7/ISO-on-TCP 102）
export interface PLCConfig {
  mode: 'TCP' | 'RTU' | 'S7';
  // TCP
  ip: string;
  port: number;
  slaveId: number;
  // RTU
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
}

// PLC设备配置（扩展）
export interface PLCDeviceConfigLocal {
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
  diCount: number;   // DI点数，默认18 (I0.0~I2.1)
  doCount: number;   // DO点数，默认12 (Q0.0~Q1.3)
  pollIntervalMs?: number;
}

// 火焰探测器单台配置
export interface FlameUnitConfig {
  index: number;
  address: number;
  enabled: boolean;
  // 每台独立连接配置（不填则使用全局 FlameConfig）
  connMode?: 'RTU' | 'TCP';
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  tcpHost?: string;
  tcpPort?: number;
  /** 旧上位机协议画像：standard=三波长，four-wavelength=四波长。 */
  protocol?: FlameProtocolId;
  imageAlarmEnabled?: boolean;
  imageAlarmZone?: number;
}

export type WaveformSendMode = 'active' | 'filtered';
export const DEFAULT_WAVEFORM_SEND_MODE: WaveformSendMode = 'active';

// 火焰探测器通信配置
export interface FlameConfig {
  mode: 'TCP' | 'RTU';
  ip: string;
  port: number;
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  units: FlameUnitConfig[];
  pollIntervalMs?: number;
  protocol?: FlameProtocolId;
  /** 默认波形发送模式：主动发送(1)或滤波发送(2)。 */
  waveformSendMode?: WaveformSendMode;
  waveformDisplayMode?: 'raw' | 'normalized';
  waveformMaxSamples?: number;
  waveformAnalysis?: Partial<WaveformAnalysisConfig>;
}

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

export interface AppConfig {
  serverPort: number;
  closureMode: 'offline' | 'field';
  plc: PLCConfig;
  plcs: PLCDeviceConfigLocal[];
  flame: FlameConfig;
  pollIntervalDI: number;
  doRelations?: DORelationRule;
  mqttConfig?: any;
}

export const DEFAULT_FLAME_TCP_HOST = '192.168.16.253';
export const DEFAULT_FLAME_TCP_PORTS = [31001, 32001, 33001, 34001, 35001, 36001] as const;
export const DEFAULT_FLAME_POLL_INTERVAL_MS = 250;
export const MAX_FLAME_POLL_INTERVAL_MS = 900;

export function createDefaultFlameUnits(host = DEFAULT_FLAME_TCP_HOST): FlameUnitConfig[] {
  return DEFAULT_FLAME_TCP_PORTS.map((tcpPort, index) => ({
    index: index + 1,
    // 每个探测器使用独立串口服务器 TCP 端口，端口才是设备归属边界；
    // 现场探测器的 Modbus 从站地址均为 1。
    address: 1,
    enabled: true,
    connMode: 'TCP' as const,
    tcpHost: host,
    tcpPort,
  }));
}

function parsePLCsFromEnv(): PLCDeviceConfigLocal[] {
  const mode = (process.env.PLC_MODE as PLCDeviceConfigLocal['mode']) || 'S7';
  const defaultPLC: PLCDeviceConfigLocal = {
    id: 'plc-1',
    name: 'PLC一体机',
    enabled: true,
    mode,
    ip: process.env.PLC_IP || '192.168.2.1',
    port: parseInt(process.env.PLC_PORT || (mode === 'S7' ? '102' : '502'), 10),
    slaveId: parseInt(process.env.PLC_SLAVE_ID || '1', 10),
    serialPath: process.env.PLC_SERIAL_PATH,
    baudRate: parseInt(process.env.PLC_BAUD_RATE || '9600', 10),
    dataBits: parseInt(process.env.PLC_DATA_BITS || '8', 10),
    stopBits: parseInt(process.env.PLC_STOP_BITS || '1', 10),
    parity: process.env.PLC_PARITY || 'none',
    diCount: parseInt(process.env.PLC_DI_COUNT || '18', 10),
    doCount: parseInt(process.env.PLC_DO_COUNT || '12', 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_DI || '200', 10),
  };

  const plcsJson = process.env.PLCS_CONFIG;
  if (plcsJson) {
    try {
      const parsed = JSON.parse(plcsJson);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      console.warn('[Config] 解析 PLCS_CONFIG 失败，使用默认配置');
    }
  }

  return [defaultPLC];
}

function parseFlameUnits(mode: 'TCP' | 'RTU', host: string): FlameUnitConfig[] {
  const defaults: FlameUnitConfig[] = mode === 'TCP'
    ? createDefaultFlameUnits(host)
    : Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      address: index + 1,
      enabled: true,
    }));

  return defaults.map((unit) => {
    const port = process.env[`FLAME_UNIT_${unit.index}_TCP_PORT`];
    const unitHost = process.env[`FLAME_UNIT_${unit.index}_TCP_HOST`];
    return {
      ...unit,
      address: parseInt(process.env[`FLAME_UNIT_${unit.index}_ADDR`] || String(mode === 'TCP' ? 1 : unit.address), 10),
      enabled: process.env[`FLAME_UNIT_${unit.index}_ENABLED`] !== 'false',
      ...(mode === 'TCP' ? {
        tcpHost: unitHost || unit.tcpHost || host,
        tcpPort: parseInt(port || String(unit.tcpPort ?? DEFAULT_FLAME_TCP_PORTS[unit.index - 1]), 10),
      } : {}),
    };
  });
}

const defaultFlameMode: 'TCP' | 'RTU' = process.env.FLAME_MODE === 'RTU' ? 'RTU' : 'TCP';
const defaultFlameHost = process.env.FLAME_IP || DEFAULT_FLAME_TCP_HOST;

export const config: AppConfig = {
  serverPort: parseInt(process.env.SERVER_PORT || '3001', 10),
  closureMode: process.env.CLOSURE_MODE === 'field' ? 'field' : 'offline',

  plc: {
    mode: (process.env.PLC_MODE as PLCConfig['mode']) || 'S7',
    ip: process.env.PLC_IP || '192.168.2.1',
    port: parseInt(process.env.PLC_PORT || (process.env.PLC_MODE === 'S7' || !process.env.PLC_MODE ? '102' : '502'), 10),
    slaveId: parseInt(process.env.PLC_SLAVE_ID || '1', 10),
    serialPath: process.env.PLC_SERIAL_PATH,
    baudRate: parseInt(process.env.PLC_BAUD_RATE || '9600', 10),
  },

  plcs: parsePLCsFromEnv(),

  flame: {
    mode: defaultFlameMode,
    ip: defaultFlameHost,
    port: parseInt(process.env.FLAME_PORT || String(DEFAULT_FLAME_TCP_PORTS[0]), 10),
    serialPath: process.env.FLAME_SERIAL_PATH,
    baudRate: parseInt(process.env.FLAME_BAUD_RATE || '115200', 10),
    dataBits: parseInt(process.env.FLAME_DATA_BITS || '8', 10),
    stopBits: parseInt(process.env.FLAME_STOP_BITS || '1', 10),
    parity: process.env.FLAME_PARITY || 'none',
    units: parseFlameUnits(defaultFlameMode, defaultFlameHost),
    pollIntervalMs: parseInt(process.env.FLAME_POLL_INTERVAL || String(DEFAULT_FLAME_POLL_INTERVAL_MS), 10),
    protocol: process.env.FLAME_PROTOCOL === 'four-wavelength' || process.env.FLAME_PROTOCOL === 'standard'
      ? process.env.FLAME_PROTOCOL
      : undefined,
    waveformSendMode: process.env.FLAME_WAVEFORM_SEND_MODE === 'filtered'
      ? 'filtered'
      : DEFAULT_WAVEFORM_SEND_MODE,
    waveformDisplayMode: process.env.FLAME_WAVEFORM_MODE === 'raw' ? 'raw' : 'normalized',
    waveformMaxSamples: parseInt(process.env.FLAME_WAVEFORM_SAMPLES || '1000', 10),
    waveformAnalysis: {
      minNoiseSamples: parseInt(process.env.FLAME_NOISE_MIN_SAMPLES || '400', 10),
      minInterferenceSamples: parseInt(process.env.FLAME_INTERFERENCE_MIN_SAMPLES || '80', 10),
      minNoiseRms: parseFloat(process.env.FLAME_MIN_NOISE_RMS || '50'),
      maxNoiseRms: parseFloat(process.env.FLAME_MAX_NOISE_RMS || '200'),
      maxNoiseAbsolute: parseFloat(process.env.FLAME_MAX_NOISE_ABSOLUTE || '1000'),
      maxInterferenceRatio: parseFloat(process.env.FLAME_MAX_INTERFERENCE_RATIO || '1.5'),
      interferenceRatio: { numerator: 'probe2', denominator: 'probe3' },
      noiseProbes: ['probe2', 'probe3'],
      consistencyProbes: ['probe2', 'probe3'],
      minConsistencyTrend: parseFloat(process.env.FLAME_MIN_CONSISTENCY_TREND || '0.75'),
    },
  },

  pollIntervalDI: parseInt(process.env.POLL_INTERVAL_DI || '200', 10),
  doRelations: { interlocks: [], associations: [], linkages: [] }
};

export default config;
