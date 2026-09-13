import { join } from 'node:path';
import mqtt, { MqttClient } from 'mqtt';
import { DEFAULT_MQTT_BROKER, type MQTTConfigLocal } from './config.js';
import { ReliableMQTTOutbox } from './mqtt-reliable-outbox.js';
import type { ProductionRunArchive } from './production-run-coordinator.js';
import type { TestProgramArchive } from './test-program/test-program-types.js';
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

function inspectionTopic(config: MQTTConfigLocal): string {
  return `dt/up/${config.factoryId}/${config.lineId}/${config.deviceId}/inspection`;
}

function seqNo(timestamp: number): string {
  return `${timestamp}${Math.floor(1000 + Math.random() * 9000)}`;
}

function defaultOutboxFile(): string {
  return process.env.MQTT_OUTBOX_FILE
    || join(process.env.APP_DATA_DIR || process.cwd(), 'mqtt-outbox.json');
}

export interface MQTTPublisherStatus {
  enabled: boolean;
  connected: boolean;
  broker: string;
  clientId?: string;
  lastError?: string;
  pendingReliableMessages: number;
  oldestPendingAt?: number;
  backlogWarning: boolean;
  outboxPersistenceHealthy: boolean;
  outboxFile: string;
}

export function buildInspectionResultPayload(run: TestProgramArchive, deviceId: string, timestamp = run.archivedAt || Date.now()) {
  const detectorVerdict = run.evidence.detectorVerdict;
  const detectorUnits = detectorVerdict?.units ?? [];
  const precheckUnits = detectorUnits.flatMap((unit) => unit.precheck ? [unit.precheck] : []);
  const firstPrecheck = precheckUnits[0];
  const derivedPrecheckVerdict = precheckUnits.length === 0
    ? null
    : precheckUnits.some((unit) => unit.verdict === 'FAIL')
      ? 'FAIL'
      : precheckUnits.some((unit) => unit.verdict === 'PENDING')
        ? 'PENDING'
        : 'PASS';
  const productType = detectorVerdict?.productType ?? firstPrecheck?.productType ?? null;
  const expectedSoftwareVersion = detectorVerdict?.expectedSoftwareVersion ?? firstPrecheck?.expectedSoftwareVersion ?? null;
  const expectedProbeCount = detectorVerdict?.expectedProbeCount ?? firstPrecheck?.expectedProbeCount ?? null;
  const productPrecheckVerdict = detectorVerdict?.productPrecheckVerdict ?? derivedPrecheckVerdict;

  return {
    header: {
      device_id: deviceId,
      timestamp,
      data_type: 'INSPECTION_RESULT',
      seq_no: seqNo(timestamp),
    },
    payload: {
      run_id: run.runId,
      status: run.status,
      verdict: run.decision.verdict,
      grade: run.decision.grade,
      started_at: run.startedAt,
      ended_at: run.endedAt,
      duration_ms: run.durationMs,
      reasons: run.decision.reasons.slice(0, 20),
      product_type: productType,
      expected_software_version: expectedSoftwareVersion || null,
      expected_probe_count: expectedProbeCount,
      product_precheck_verdict: productPrecheckVerdict,
      detector_results: detectorUnits.map((unit) => ({
        index: unit.index,
        address: unit.address,
        verdict: unit.verdict,
        grade: unit.grade,
        reason: unit.reason ?? null,
        actual_software_version: unit.precheck?.actualSoftwareVersion ?? null,
        expected_software_version: unit.precheck?.expectedSoftwareVersion || expectedSoftwareVersion || null,
        actual_probe_count: unit.precheck?.actualProbeCount ?? null,
        expected_probe_count: unit.precheck?.expectedProbeCount ?? expectedProbeCount,
        precheck_verdict: unit.precheck?.verdict ?? null,
        precheck_reasons: unit.precheck?.reasons ?? [],
        fire_alarm_at_precheck: unit.precheck?.fireAlarm ?? null,
        fault_at_precheck: unit.precheck?.fault ?? null,
        no_data_probes: unit.noDataProbes ?? [],
      })),
      stages: run.stages.map((stage) => ({
        sequence: stage.sequence,
        id: stage.stageId,
        label: stage.label,
        status: stage.status,
        started_at: stage.startedAt,
        ended_at: stage.endedAt,
        duration_ms: stage.durationMs,
        planned_duration_ms: stage.plannedDurationMs,
        within_plan: stage.withinPlan,
        detector_count: stage.detectors.length,
        relay_event_count: stage.relayEventCount,
        waveform_sample_count: stage.waveforms.reduce((sum, unit) => sum + unit.sampleCount, 0),
      })),
      evidence: {
        plc_available: Boolean(run.evidence.process),
        detector_available: Boolean(run.evidence.detectorState),
        product_identity_available: Boolean(productType),
        product_precheck_available: precheckUnits.length > 0,
        final_verdict: run.evidence.finalVerdict?.verdict ?? null,
        final_grade: run.evidence.finalVerdict?.grade ?? null,
      },
    },
  };
}

/**
 * 正式生产记录上传载荷。与测试监听程序的 INSPECTION_RESULT 共用同一个
 * inspection topic 和可靠 outbox，但 data_type/source 明确区分，避免云端把
 * 只读测试监听归档与正式生产批次混为一谈。
 */
export function buildProductionInspectionPayload(
  run: ProductionRunArchive,
  deviceId: string,
  timestamp = run.archivedAt || Date.now(),
) {
  const record = run.inspectionRecord;
  const precheck = run.summary.productPrecheck;
  const relay = precheck?.relayFunctionalTest ?? run.productContext?.relayFunctionalTest ?? null;
  return {
    header: {
      device_id: deviceId,
      timestamp,
      data_type: 'PRODUCTION_INSPECTION_RECORD',
      seq_no: seqNo(timestamp),
    },
    payload: {
      source: 'FORMAL_PRODUCTION',
      run_id: run.batchId,
      batch_id: run.batchId,
      verdict: record.conclusion === '合格' ? 'PASS' : 'FAIL',
      grade: run.summary.finalVerdict.grade,
      final_reason: run.summary.finalVerdict.reason ?? null,
      product_model: record.productModel,
      production_date: record.productionDate,
      archived_at: run.archivedAt,
      generated_at: record.generatedAt,
      quantity: record.quantity,
      inspector: record.inspector,
      standard: record.standard,
      form_number: record.formNumber,
      form_version: record.formVersion,
      conclusion: record.conclusion,
      product_precheck_verdict: precheck?.verdict ?? null,
      relay_functional_test_verdict: relay?.verdict ?? null,
      detector_results: record.products.map((product) => ({
        slot: product.slot,
        product_code: product.productCode,
        product_code_status: product.productCodeStatus,
        verdict: product.verdict,
        software_version: product.softwareVersion.value,
        probe_count: product.productInfo.value.probeCount,
        sensitivity_level: product.productInfo.value.sensitivityLevel,
        amplitude_values: product.amplitude.values,
        inspection_items: {
          work_current: product.workCurrent,
          fire_action: product.fireAction,
          fault_action: product.faultAction,
          led_display: product.ledDisplay,
          indicator_vision: product.indicatorVision ?? null,
          amplitude: product.amplitude,
          software_version: product.softwareVersion,
          product_info: product.productInfo,
          interference_resistance: product.interferenceResistance,
          power_fluctuation: product.powerFluctuation,
          high_temperature: product.highTemp,
          low_temperature: product.lowTemp,
        },
      })),
      evidence: {
        plc_available: Boolean(run.summary.process),
        detector_available: Boolean(run.flame),
        product_precheck_available: Boolean(precheck),
        product_code_allocation_status: precheck?.productCodeAllocation?.status
          ?? run.productContext?.productCodeAllocation?.status
          ?? null,
        relay_functional_test_available: Boolean(relay),
        final_verdict: run.summary.finalVerdict.verdict,
        final_grade: run.summary.finalVerdict.grade,
      },
    },
  };
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
  private readonly outbox: ReliableMQTTOutbox;
  private flushingReliableMessages = false;
  private backlogWarningLogged = false;

  constructor(config: Partial<MQTTConfigLocal> = {}, options: { outboxFile?: string } = {}) {
    this.config = normalizeMQTTConfig(config, {
      mqttEnabled: true,
      brokerUrl: DEFAULT_MQTT_BROKER,
      factoryId: DEFAULT_FACTORY_ID,
      lineId: DEFAULT_LINE_ID,
      deviceId: DEFAULT_DEVICE_ID,
    });
    this.outbox = new ReliableMQTTOutbox(options.outboxFile || defaultOutboxFile());
    const outboxStatus = this.outbox.status();
    if (!outboxStatus.persistenceHealthy && outboxStatus.lastError) this.lastError = outboxStatus.lastError;
  }

  getConfig(): MQTTConfigLocal {
    return { ...this.config };
  }

  getPublicConfig(): Omit<MQTTConfigLocal, 'password'> & { passwordConfigured: boolean } {
    const { password, ...rest } = this.config;
    return { ...rest, brokerUrl: brokerLabel(rest.brokerUrl), passwordConfigured: Boolean(password) };
  }

  getStatus(): MQTTPublisherStatus {
    const outbox = this.outbox.status();
    return {
      enabled: this.config.mqttEnabled,
      connected: this.connected,
      broker: brokerLabel(this.config.brokerUrl),
      clientId: this.config.clientId,
      lastError: this.lastError || outbox.lastError || undefined,
      pendingReliableMessages: outbox.pending,
      ...(outbox.oldestPendingAt === undefined ? {} : { oldestPendingAt: outbox.oldestPendingAt }),
      backlogWarning: outbox.backlogWarning,
      outboxPersistenceHealthy: outbox.persistenceHealthy,
      outboxFile: outbox.file,
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
      void this.publishFlameStatus();
      void this.flushReliableMessages();
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
    if (state.faultCount > 0 || flameCommFault) standardStatus = 'FAULT';
    else if (state.fireCount > 0) standardStatus = 'ALARM';

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

  publishInspectionResult(run: TestProgramArchive): Promise<boolean> {
    const timestamp = run.archivedAt || Date.now();
    const payload = buildInspectionResultPayload(run, this.config.deviceId, timestamp);
    return this.publishReliable(`inspection:${run.runId}`, inspectionTopic(this.config), payload);
  }

  publishProductionInspectionResult(run: ProductionRunArchive): Promise<boolean> {
    const timestamp = run.archivedAt || Date.now();
    const payload = buildProductionInspectionPayload(run, this.config.deviceId, timestamp);
    return this.publishReliable(`production:${run.batchId}`, inspectionTopic(this.config), payload);
  }

  publishEvent(code: string, level: 'INFO' | 'WARNING' | 'CRITICAL' | 'FATAL', msg: string): Promise<boolean> {
    const timestamp = Date.now();
    const payload = {
      header: { device_id: this.config.deviceId, timestamp, data_type: 'REALTIME' },
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

  private updateOutboxHealth(): void {
    const status = this.outbox.status();
    if (!status.persistenceHealthy && status.lastError) this.lastError = status.lastError;
    if (status.backlogWarning && !this.backlogWarningLogged) {
      this.backlogWarningLogged = true;
      console.warn(`[MQTT Server] 待上传生产/检测结果已积压 ${status.pending} 条；队列不会自动丢弃，请检查 Broker/网络。`);
    }
    if (!status.backlogWarning) this.backlogWarningLogged = false;
  }

  private async publishReliable(key: string, topic: string, payload: unknown): Promise<boolean> {
    const success = await this.publish(topic, payload);
    if (success) {
      this.outbox.delete(key);
      this.updateOutboxHealth();
      return true;
    }
    this.outbox.set(key, { topic, payload, queuedAt: Date.now() });
    this.updateOutboxHealth();
    return false;
  }

  private async flushReliableMessages(): Promise<void> {
    if (this.flushingReliableMessages || !this.connected) return;
    this.flushingReliableMessages = true;
    try {
      for (const [key, message] of this.outbox.entries()) {
        if (!this.connected) break;
        const success = await this.publish(message.topic, message.payload);
        if (success) {
          this.outbox.delete(key);
          this.updateOutboxHealth();
        }
      }
    } finally {
      this.flushingReliableMessages = false;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => { void this.publishFlameStatus(); }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }
}

export default MQTTPublisher;
