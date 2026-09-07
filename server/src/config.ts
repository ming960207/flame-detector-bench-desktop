import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FlameProtocolId } from './modbus/flame-protocol.js';
import type { WaveformAnalysisConfig } from './closure/field-waveform-analysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

export interface PLCConfig {
  mode: 'TCP' | 'RTU' | 'S7';
  ip: string;
  port: number;
  slaveId: number;
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
}

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
  diCount: number;
  doCount: number;
  pollIntervalMs?: number;
}

export interface FlameUnitConfig {
  index: number;
  address: number;
  enabled: boolean;
  connMode?: 'RTU' | 'TCP';
  serialPath?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  tcpHost?: string;
  tcpPort?: number;
  protocol?: FlameProtocolId;
  imageAlarmEnabled?: boolean;
  imageAlarmZone?: number;
}

export type WaveformSendMode = 'active' | 'filtered';
export const DEFAULT_WAVEFORM_SEND_MODE: WaveformSendMode = 'active';

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
  waveformSendMode?: WaveformSendMode;
  /** 是否必须等待 PLC 垂直下限反馈后才发送波形模式切换指令。 */
  waveformModeSwitchLowerLimitGateEnabled?: boolean;
  waveformDisplayMode?: 'raw' | 'normalized';
  waveformMaxSamples?: number;
  waveformAnalysis?: Partial<WaveformAnalysisConfig>;
}

export interface MQTTConfigLocal {
  mqttEnabled: boolean;
  brokerUrl: string;
  topic?: string;
  clientId?: string;
  username?: string;
  password?: string;
  factoryId: string;
  lineId: string;
  deviceId: string;
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
  mqttConfig: MQTTConfigLocal;
}

export const DEFAULT_FLAME_TCP_HOST = '192.168.16.253';
export const DEFAULT_FLAME_TCP_PORTS = [31001, 32001, 33001, 34001, 35001, 36001] as const;
export const DEFAULT_FLAME_POLL_INTERVAL_MS = 250;
export const MAX_FLAME_POLL_INTERVAL_MS = 900;
export const DEFAULT_MQTT_BROKER = 'mqtt://115.190.63.111:1883';

export function createDefaultFlameUnits(host = DEFAULT_FLAME_TCP_HOST): FlameUnitConfig[] {
  return DEFAULT_FLAME_TCP_PORTS.map((tcpPort, index) => ({
    index: index + 1,
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
    waveformModeSwitchLowerLimitGateEnabled: process.env.FLAME_WAVEFORM_LOWER_LIMIT_GATE !== 'false',
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
  doRelations: { interlocks: [], associations: [], linkages: [] },
  mqttConfig: {
    // External publishing is opt-in. A persisted config can enable it later.
    mqttEnabled: process.env.MQTT_ENABLED === 'true',
    brokerUrl: process.env.MQTT_BROKER_URL || DEFAULT_MQTT_BROKER,
    topic: process.env.MQTT_TOPIC || undefined,
    clientId: process.env.MQTT_CLIENT_ID || undefined,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    factoryId: process.env.MQTT_FACTORY_ID || 'SH_F1',
    lineId: process.env.MQTT_LINE_ID || 'LINE_A1',
    deviceId: process.env.MQTT_DEVICE_ID || 'flame_detector_bench',
  },
};

export default config;
