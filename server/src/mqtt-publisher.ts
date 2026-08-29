import mqtt, { MqttClient } from 'mqtt';
import { ConnectionStatus, FlameDetectorState } from './types.js';

export interface MQTTConfigLocal {
  mqttEnabled?: boolean;
  brokerUrl?: string;
  topic?: string;
  clientId?: string;
  username?: string;
  password?: string;
  factoryId?: string;
  lineId?: string;
  deviceId?: string;
  tcpBrokerUrl?: string;
  serverBrokerUrl?: string;
}

const DEFAULT_FACTORY_ID = 'SH_F1';
const DEFAULT_LINE_ID = 'LINE_A1';
const DEFAULT_DEVICE_ID = 'flame_detector_bench';
const DEFAULT_TCP_BROKER = 'mqtt://115.190.63.111:1883';
const HEARTBEAT_MS = 30000;

function normalizeBrokerUrl(config: MQTTConfigLocal): string {
  if (process.env.MQTT_BROKER_URL) return process.env.MQTT_BROKER_URL;
  if (config.serverBrokerUrl) return config.serverBrokerUrl;
  if (config.tcpBrokerUrl) return config.tcpBrokerUrl;
  if (config.brokerUrl?.startsWith('mqtt://') || config.brokerUrl?.startsWith('mqtts://')) {
    return config.brokerUrl;
  }
  if (config.brokerUrl?.startsWith('ws://') || config.brokerUrl?.startsWith('wss://')) {
    try {
      const parsed = new URL(config.brokerUrl);
      return `mqtt://${parsed.hostname}:1883`;
    } catch {
      return DEFAULT_TCP_BROKER;
    }
  }
  return DEFAULT_TCP_BROKER;
}

function statusTopic(config: MQTTConfigLocal): string {
  const factoryId = config.factoryId || DEFAULT_FACTORY_ID;
  const lineId = config.lineId || DEFAULT_LINE_ID;
  const deviceId = config.deviceId || DEFAULT_DEVICE_ID;
  return config.topic || `dt/up/${factoryId}/${lineId}/${deviceId}/status`;
}

function eventTopic(config: MQTTConfigLocal): string {
  const factoryId = config.factoryId || DEFAULT_FACTORY_ID;
  const lineId = config.lineId || DEFAULT_LINE_ID;
  const deviceId = config.deviceId || DEFAULT_DEVICE_ID;
  return `dt/up/${factoryId}/${lineId}/${deviceId}/event`;
}

function seqNo(timestamp: number): string {
  return `${timestamp}${Math.floor(1000 + Math.random() * 9000)}`;
}

export class MQTTPublisher {
  private config: MQTTConfigLocal;
  private client: MqttClient | null = null;
  private connected = false;
  private lastFlameState: FlameDetectorState | null = null;
  private lastConnectionStatus: ConnectionStatus | null = null;
  private lastSignature = '';
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: MQTTConfigLocal = {}) {
    this.config = {
      mqttEnabled: true,
      factoryId: DEFAULT_FACTORY_ID,
      lineId: DEFAULT_LINE_ID,
      deviceId: DEFAULT_DEVICE_ID,
      brokerUrl: DEFAULT_TCP_BROKER,
      ...config,
    };
  }

  updateConfig(config: MQTTConfigLocal = {}): void {
    const next = { ...this.config, ...config };
    const brokerChanged = normalizeBrokerUrl(next) !== normalizeBrokerUrl(this.config);
    const clientChanged = next.clientId !== this.config.clientId || next.username !== this.config.username || next.password !== this.config.password;
    const enabledChanged = next.mqttEnabled !== this.config.mqttEnabled;
    this.config = next;
    if (brokerChanged || clientChanged || enabledChanged) {
      this.disconnect();
      this.connect();
    }
  }

  connect(): void {
    if (this.config.mqttEnabled === false) return;
    if (this.client) return;

    const brokerUrl = normalizeBrokerUrl(this.config);
    const options: mqtt.IClientOptions = {
      clientId: this.config.clientId || `flame_bench_server_${Math.random().toString(36).slice(2, 10)}`,
      clean: true,
      keepalive: 30,
      connectTimeout: 8000,
      reconnectPeriod: 5000,
    };
    if (this.config.username) options.username = this.config.username;
    if (this.config.password) options.password = this.config.password;

    console.log(`[MQTT Server] 正在连接云端 Broker: ${brokerUrl}`);
    this.client = mqtt.connect(brokerUrl, options);
    this.client.on('connect', () => {
      this.connected = true;
      console.log('[MQTT Server] 云端连接成功');
    });
    this.client.on('close', () => {
      this.connected = false;
      console.log('[MQTT Server] 云端连接关闭');
    });
    this.client.on('error', (error) => {
      this.connected = false;
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
      this.client.end(true);
      this.client = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  publish(topic: string, payload: unknown): Promise<boolean> {
    if (this.config.mqttEnabled === false) return Promise.resolve(false);
    if (!this.client) this.connect();
    if (!this.client || !this.connected) {
      console.warn('[MQTT Server] 云端未连接，跳过发布');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this.client!.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, (error) => {
        if (error) {
          console.error(`[MQTT Server] 发布失败 ${topic}:`, error.message);
          resolve(false);
          return;
        }
        console.log(`[MQTT Server] 已发布 ${topic}`);
        resolve(true);
      });
    });
  }

  handleFlameState(state: FlameDetectorState, connectionStatus: ConnectionStatus): void {
    this.lastFlameState = state;
    this.lastConnectionStatus = connectionStatus;
    const signature = `${state.onlineCount}:${state.fireCount}:${state.faultCount}:${connectionStatus.flame?.connected ? 1 : 0}`;
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
    const deviceId = this.config.deviceId || DEFAULT_DEVICE_ID;
    const flameCommFault = conn?.flame ? conn.flame.connected === false : false;
    let standardStatus = 'IDLE';
    if (state.faultCount > 0 || flameCommFault) {
      standardStatus = 'FAULT';
    } else if (state.fireCount > 0) {
      standardStatus = 'ALARM';
    }

    const alarms = [];
    if (state.fireCount > 0) {
      alarms.push({ code: 'E1001', level: 'CRITICAL', msg: '探测器火警/报警触发' });
    }
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
        uptime: Math.max(0, ...state.units.map(unit => unit.runTime || 0)),
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
          flame_units: state.units.map(unit => ({
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
    const deviceId = this.config.deviceId || DEFAULT_DEVICE_ID;
    const payload = {
      header: {
        device_id: deviceId,
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
  }
}

export default MQTTPublisher;
