import mqtt, { MqttClient } from 'mqtt';
import { DEFAULT_MQTT_BROKER, type MQTTConfigLocal } from './config.js';
import { ConnectionStatus, FlameDetectorState } from './types.js';

const DEFAULT_FACTORY_ID = 'SH_F1';
const DEFAULT_LINE_ID = 'LINE_A1';
const DEFAULT_DEVICE_ID = 'flame_detector_bench';
const HEARTBEAT_MS = 30000;

function cleanString(value: unknown, fallback = '', maxLength = 256): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : fallback;
}

function validBrokerUrl(value: unknown, fallback: string): string {
  const raw = cleanString(value, fallback, 1024);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'mqtt:' && parsed.protocol !== 'mqtts:') return fallback;
    if (!parsed.hostname) return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

export function normalizeMQTTConfig(input: unknown, current?: Partial<MQTTConfigLocal>): MQTTConfigLocal {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const fallback: MQTTConfigLocal = {
    mqttEnabled: current?.mqttEnabled ?? true,
    brokerUrl: current?.brokerUrl ?? DEFAULT_MQTT_BROKER,
    topic: current?.topic,
    clientId: current?.clientId,
    username: current?.username,
    password: current?.password,
    factoryId: current?.factoryId ?? DEFAULT_FACTORY_ID,
    lineId: current?.lineId ?? DEFAULT_LINE_ID,
    deviceId: current?.deviceId ?? DEFAULT_DEVICE_ID,
  };
  return {
    mqttEnabled: typeof source.mqttEnabled === 'boolean' ? source.mqttEnabled : fallback.mqttEnabled,
    brokerUrl: validBrokerUrl(source.brokerUrl, fallback.brokerUrl),
    topic: cleanString(source.topic, fallback.topic ?? '', 512) || undefined,
    clientId: cleanString(source.clientId, fallback.clientId ?? '', 128) || undefined,
    username: cleanString(source.username, fallback.username ?? '', 256) || undefined,
    password: typeof source.password === 'string' ? source.password.slice(0, 512) : fallback.password,
    factoryId: cleanString(source.factoryId, fallback.factoryId, 128),
    lineId: cleanString(source.lineId, fallback.lineId, 128),
    deviceId: cleanString(source.deviceId, fallback.deviceId, 128),
  };
}

function brokerLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '<invalid-broker-url>';
  }
}

function statusTopic(config: MQTTConfigLocal): string {
  return config.topic || `dt/up/${config.factoryId}/${config.lineId}/${config.deviceId}/status`;
}

function eventTopic(config: MQTTConfigLocal): string {
  return `dt/up/${config.factoryId}/${config.lineId}/${config.deviceId}/event`;
}

function seqNo(timestamp: number): string {
  return `${timestamp}${Math.floor(1000 + Math.random() * 9000)}`;
}

export interface MQTTPublisherStatus {
  enabled: boolean;
  connected: boolean;
  broker: string;
  clientId?: string;
  lastError?: string;
}

export class MQTTPublisher {
  private config: MQTTConfigLocal;
  private client: MqttClient | null = null;
  private connected = false;
  private lastFlameState: FlameDetectorState | null = null;
  private lastConnectionStatus: ConnectionStatus | null = null;
  private lastSignature = '';
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastError = '';

  constructor(config: Partial<MQTTConfigLocal> = {}) {
    this.config = normalizeMQTTConfig(config, {
      mqttEnabled: true,
      brokerUrl: DEFAULT_MQTT_BROKER,
      factoryId: DEFAULT_FACTORY_ID,
      lineId: DEFAULT_LINE_ID,
      deviceId: DEFAULT_DEVICE_ID,
    });
  }

  getConfig(): MQTTConfigLocal {
    return { ...this.config };
  }

  getPublicConfig(): Omit<MQTTConfigLocal, 'password'> & { passwordConfigured: boolean } {
    const { password, ...rest } = this.config;
    return { ...rest, passwordConfigured: Boolean(password) };
  }

  getStatus(): MQTTPublisherStatus {
    return {
      enabled: this.config.mqttEnabled,
      connected: this.connected,
      broker: brokerLabel(this.config.brokerUrl),
      clientId: this.config.clientId,
      lastError: this.lastError || undefined,
    };
  }

  updateConfig(config: unknown): void {
    const next = normalizeMQTTConfig(config, this.config);
    const brokerChanged = next.brokerUrl !== this.config.brokerUrl;
    const clientChanged = next.clientId !== this.config.clientId || next.username !== this.config.username || next.password !== this.config.password;
    const enabledChanged = next.mqttEnabled !== this.config.mqttEnabled;
    this.config = next;
    this.lastSignature = '';
    if (brokerChanged || clientChanged || enabledChanged) {
      this.disconnect();
      if (this.config.mqttEnabled) this.connect();
    }
  }

  connect(): void {
    if (!this.config.mqttEnabled || this.client) return;
    const brokerUrl = validBrokerUrl(this.config.brokerUrl, '');
    if (!brokerUrl) {
      this.lastError = 'MQTT_BROKER_URL_INVALID';
      console.error('[MQTT Server] Broker 地址无效');
      return;
    }

    const options: mqtt.IClientOptions = {
      clientId: this.config.clientId || `flame_bench_server_${Math.random().toString(36).slice(2, 10)}`,
      clean: true,
      keepalive: 30,
      connectTimeout: 8000,
      reconnectPeriod: 5000,
    };
    if (this.config.username) options.username = this.config.username;
    if (this.config.password) options.password = this.config.password;

    console.log(`[MQTT Server] 正在连接云端 Broker: ${brokerLabel(brokerUrl)}`);
    try {
      this.client = mqtt.connect(brokerUrl, options);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.client = null;
      this.connected = false;
      console.error('[MQTT Server] 创建连接失败:', this.lastError);
      return;
    }
    this.client.on('connect', () => {
      this.connected = true;
      this.lastError = '';
      console.log('[MQTT Server] 云端连接成功');
    });
    this.client.on('close', () => {
      this.connected = false;
      console.log('[MQTT Server] 云端连接关闭');
    });
    this.client.on('error', (error) => {
      this.connected = false;
      this.lastError = error.message;
      console.error('[MQTT Server] 云端连接错误:', error.message);
    });
    this.startHeartbeat();
  }

  disconnect(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  publish(topic: string, payload: unknown): Promise<boolean> {
    if (!this.config.mqttEnabled) return Promise.resolve(false);
    if (!this.client) this.connect();
    if (!this.client || !this.connected) return Promise.resolve(false);

    return new Promise((resolve) => {
      this.client!.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, (error) => {
        if (error) {
          this.lastError = error.message;
          console.error(`[MQTT Server] 发布失败 ${topic}:`, error.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  handleFlameState(state: FlameDetectorState, connectionStatus: ConnectionStatus): void {
    this.lastFlameState = state;
    this.lastConnectionStatus = connectionStatus;
    const signature = `${state.onlineCount}:${state.fireCount}:${state.faultCount}:${connectionStatus.flame?.connected ? 1 : 0}:${connectionStatus.relay.connected ? 1 : 0}`;
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      void this.publishFlameStatus();
    }
  }

  async publishFlameStatus(): Promise<boolean> {
    if (!this.lastFlameState) return false;

    const state = this.lastFlameState;
    const conn = this.lastConnectionStatus;
    const timestamp = Date.now();
    const deviceId = this.config.deviceId;
    const flameCommFault = conn?.flame ? conn.flame.connected === false : false;
    let standardStatus = 'IDLE';
    if (state.faultCount > 0 || flameCommFault) {
      standardStatus = 'FAULT';
    } else if (state.fireCount > 0) {
      standardStatus = 'ALARM';
    }

    const alarms = [];
    if (state.fireCount > 0) alarms.push({ code: 'E1001', level: 'CRITICAL', msg: '探测器火警/报警触发' });
    if (state.faultCount > 0 || flameCommFault) {
      alarms.push({ code: 'E2001', level: 'WARNING', msg: flameCommFault ? '探测器通信故障' : '探测器故障' });
    }

    const payload = {
      header: {
        device_id: deviceId,
        timestamp,
        data_type: 'REALTIME',
        seq_no: seqNo(timestamp),
      },
      payload: {
        status: standardStatus,
        mode: 'AUTO',
        uptime: Math.max(0, ...state.units.map((unit) => unit.runTime || 0)),
        message: `火焰探测器在线 ${state.onlineCount}/${state.units.length}`,
        metrics: {
          'flame.total_count': state.units.length,
          'flame.online_count': state.onlineCount,
          'flame.fire_count': state.fireCount,
          'flame.fault_count': state.faultCount,
          'flame.connected': conn?.flame?.connected ? 1 : 0,
          'plc.connected': conn?.relay?.connected ? 1 : 0,
          'server.connected': 1,
        },
        extra_data: {
          step_name: '后端火焰探测器实时心跳',
          flame_units: state.units.map((unit) => ({
            index: unit.index,
            address: unit.address,
            online: unit.online,
            fire: unit.fire,
            fault: unit.fault,
            last_update: unit.lastUpdate,
          })),
        },
        alarms,
      },
    };

    return this.publish(statusTopic(this.config), payload);
  }

  publishEvent(code: string, level: 'INFO' | 'WARNING' | 'CRITICAL' | 'FATAL', msg: string): Promise<boolean> {
    const timestamp = Date.now();
    const payload = {
      header: {
        device_id: this.config.deviceId,
        timestamp,
        data_type: 'REALTIME',
      },
      payload: {
        event_code: code,
        event_level: level,
        event_msg: msg,
        trigger_time: timestamp,
        extra_data: {},
      },
    };
    return this.publish(eventTopic(this.config), payload);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.publishFlameStatus();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }
}

export default MQTTPublisher;
