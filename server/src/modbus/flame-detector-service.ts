/**
 * 火焰探测器现场服务。
 *
 * 连接池和顺序轮询沿用当前项目的现场只读边界；设备寄存器、协议画像、
 * 波形解码和七步自动检测复用旧上位机的实现语义。
 */

import ModbusRTU from 'modbus-serial';
import { EventEmitter } from 'events';
import { DEFAULT_FLAME_POLL_INTERVAL_MS, MAX_FLAME_POLL_INTERVAL_MS, FlameConfig, FlameUnitConfig } from '../config.js';
import { FlameDetectorUnitState, FlameDetectorState, FlameFeature, FlameSample } from '../types.js';
import {
  FlameDetectorDevice,
  getRawTcpSocket,
  isRawTcpClient,
  SEND_MODE_BROADCAST_FRAME_HEX,
  SEND_MODE_BROADCAST_VALUE,
  SEND_MODE_FILTERED_VALUE,
  type FlameDetectorClient,
  type RawTcpSocket,
} from './flame-detector-device.js';
import { connectRawTcpClient } from './flame-detector-raw-client.js';
import {
  decodeCustomWaveformFrame,
  decodeModbusRealtimeFrame,
  extractCustomWaveformFrames,
  extractModbusRealtimeFrames,
  summarizeWaveformChannels,
  type DecodedFeatureBlock,
} from './flame-data-decoder.js';
import { FLAME_PROTOCOLS } from './flame-protocol.js';
import {
  acquireFlameDetectorProcessLock,
  defaultFlameDetectorProcessLockPath,
  type FlameDetectorProcessLock,
} from './flame-detector-process-lock.js';

// 尚未解析到合法波形时持续重发发送模式帧，避免设备只回 ACK 但仍不推流。
const SEND_MODE_BROADCAST_RETRY_INTERVAL_MS = 250;
const TCP_RECONNECT_INTERVAL_MS = 250;
const TCP_CONNECT_TIMEOUT_MS = 750;
const DEVICE_REQUEST_TIMEOUT_MS = 700;
const CLIENT_CLOSE_TIMEOUT_MS = 1000;
const AUTO_TEST_RECONNECT_WAIT_MS = 1000;
const AUTO_TEST_MAX_ATTEMPTS = 4;
// 现场探测器在确认模式切换后可能需要数秒才进入稳定连续推流。
// 过早重发 FF 会再次打断启动过程，形成“切换成功但始终无波形”的循环。
const WAVEFORM_STALE_TIMEOUT_MS = 10000;
const WAVEFORM_STATE_BROADCAST_INTERVAL_MS = 50;
const TCP_INITIALIZE_STAGGER_MS = 250;
const SEND_MODE_RETRY_MAX_INTERVAL_MS = 5000;

interface SocketBinding {
  socket: RawTcpSocket;
  onData: (chunk: Buffer) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

function connKey(unit: FlameUnitConfig, global: FlameConfig): string {
  if (unit.connMode === 'RTU') return `rtu:${unit.serialPath}:${unit.baudRate ?? global.baudRate ?? 115200}`;
  if (unit.connMode === 'TCP') return `tcp:${unit.tcpHost}:${unit.tcpPort ?? 502}`;
  if (global.mode === 'RTU') return `rtu:${global.serialPath}:${global.baudRate ?? 115200}`;
  return `tcp:${global.ip}:${global.port}`;
}

const SEND_MODE_ACK = Buffer.from('0110300000024ec8', 'hex');

function removeSendModeAck(buffer: Buffer): Buffer {
  let result = buffer;
  let offset = result.indexOf(SEND_MODE_ACK);
  while (offset >= 0) {
    result = Buffer.concat([result.subarray(0, offset), result.subarray(offset + SEND_MODE_ACK.length)]);
    offset = result.indexOf(SEND_MODE_ACK);
  }
  return result;
}

async function createClient(unit: FlameUnitConfig, global: FlameConfig): Promise<FlameDetectorClient> {
  const mode = unit.connMode ?? global.mode;
  if (mode === 'TCP') {
    const host = unit.tcpHost ?? global.ip;
    const port = unit.tcpPort ?? global.port;
    // 火焰探测器端口是串口服务器的原始 RTU 字节流，不能使用
    // modbus-serial.connectTCP()，否则请求会被自动加上 MBAP 头。
    return connectRawTcpClient(host, port, TCP_CONNECT_TIMEOUT_MS);
  }

  const client = new ModbusRTU();
  try {
    const path = unit.serialPath ?? global.serialPath ?? '';
    if (!path) throw new Error('未配置火焰探测器串口');
    await client.connectRTUBuffered(path, {
      baudRate: unit.baudRate ?? global.baudRate ?? 115200,
      dataBits: (unit.dataBits ?? global.dataBits ?? 8) as 5 | 6 | 7 | 8,
      stopBits: (unit.stopBits ?? global.stopBits ?? 1) as 1 | 2,
      parity: (unit.parity ?? global.parity ?? 'none') as 'none' | 'even' | 'odd',
    });
    client.setTimeout(DEVICE_REQUEST_TIMEOUT_MS);
    return client;
  } catch (error) {
    await closeClient(client);
    throw error;
  }
}

async function closeClient(client: FlameDetectorClient | undefined): Promise<void> {
  if (!client) return;
  if (isRawTcpClient(client)) {
    await client.close();
    return;
  }
  const socket = (client as any)._port?._client as { destroyed?: boolean; destroy?: () => void } | undefined;
  if (socket?.destroyed) return;
  if (!client.isOpen) {
    if (socket?.destroy && !socket.destroyed) socket.destroy();
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        socket?.destroy?.();
        finish();
      }, CLIENT_CLOSE_TIMEOUT_MS);
      try {
        client.close(() => finish());
      } catch {
        socket?.destroy?.();
        finish();
      }
    });
  } catch {
    socket?.destroy?.();
  }
}

export type AutoTestStepStatus = 'running' | 'success' | 'error';

export interface AutoTestProgress {
  unitIndex: number;
  stepIndex: number;
  stepKey: string;
  stepName: string;
  status: AutoTestStepStatus;
  data?: unknown;
}

export interface AutoTestReport {
  startTime: string;
  endTime: string;
  devices: Record<string, {
    address: number;
    passed: boolean;
    steps: Array<{ step: number; key: string; name: string; passed: boolean; data?: unknown; error?: string }>;
  }>;
  summary: { total: number; passed: number };
  passed: boolean;
}

export class FlameDetectorService extends EventEmitter {
  private config: FlameConfig;
  private pool: Map<string, { client: FlameDetectorClient; ok: boolean }> = new Map();
  private devices: Map<number, FlameDetectorDevice> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private unitReconnectTimers: Map<number, NodeJS.Timeout> = new Map();
  private reconnectingUnits = new Set<number>();
  private polling = false;
  private autoTesting = false;
  private disposed = false;
  private closing = false;
  private lastError = '';
  private units: Map<number, FlameDetectorUnitState> = new Map();
  private baselines: Map<number, Partial<FlameSample>> = new Map();
  private pushBuffers: Map<number, Buffer> = new Map();
  private modbusPushBuffers: Map<number, Buffer> = new Map();
  private lastPushAt: Map<number, number> = new Map();
  private initializingUnits = new Map<number, FlameDetectorClient>();
  private broadcastModeUnits = new Set<number>();
  private broadcastModeRetryTimers: Map<number, NodeJS.Timeout> = new Map();
  private broadcastModeRetryAttempts: Map<number, number> = new Map();
  private broadcastModeRequestingUnits = new Set<number>();
  private broadcastModeRequestInFlight: Map<number, FlameDetectorClient> = new Map();
  private waveformRecoveryRequestedUnits = new Set<number>();
  private waveformWatchdogTimers: Map<number, NodeJS.Timeout> = new Map();
  private socketBindings: Map<number, SocketBinding> = new Map();
  private stateBroadcastTimer: NodeJS.Timeout | null = null;
  private stateBroadcastPending = false;
  private lastStateBroadcastAt = 0;
  private processLock: FlameDetectorProcessLock | null = null;
  private readonly processLockPath: string;
  private lifecycleGeneration = 0;

  constructor(config: FlameConfig, options: { lockPath?: string } = {}) {
    super();
    this.config = config;
    this.processLockPath = options.lockPath ?? defaultFlameDetectorProcessLockPath();
    this.initUnits();
  }

  private initUnits(): void {
    const configured = new Map(this.config.units.map((unit) => [unit.index, unit]));
    for (let index = 1; index <= 6; index += 1) {
      const unit = configured.get(index) ?? { index, address: index, enabled: false };
      const existing = this.units.get(index);
      this.units.set(index, existing ? { ...existing, address: unit.address } : this.defaultUnitState(unit));
    }
  }

  private defaultUnitState(unit: FlameUnitConfig): FlameDetectorUnitState {
    return {
      index: unit.index,
      address: unit.address,
      online: false,
      fire: false,
      fault: false,
      sourceReady: false,
      syncOk: false,
      probe1: 0,
      probe2: 0,
      probe3: 0,
      probe4: undefined,
      probe1Absolute: 0,
      probe2Absolute: 0,
      probe3Absolute: 0,
      probe4Absolute: 0,
      probe1Fluctuation: 0,
      probe2Fluctuation: 0,
      probe3Fluctuation: 0,
      probe4Fluctuation: 0,
      snr21: 0,
      snr23: 0,
      snr31: 0,
      sensitivity: 0,
      sendMode: 0,
      version: '00.00.00.00',
      address_r: unit.address,
      runTime: 0,
      probeCount: 3,
      lastUpdate: 0,
      protocol: unit.protocol ?? this.config.protocol ?? 'standard',
      features: [],
      samples: [],
      rawSamples: [],
      historySamples: [],
      rawHistorySamples: [],
      historySampleTotal: 0,
    };
  }

  getConfig(): FlameConfig {
    return JSON.parse(JSON.stringify(this.config)) as FlameConfig;
  }

  clearWaveformHistory(): void {
    for (const state of this.units.values()) {
      state.samples = [];
      state.rawSamples = [];
      state.historySamples = [];
      state.rawHistorySamples = [];
      state.historySampleTotal = 0;
      state.probe1Fluctuation = 0;
      state.probe2Fluctuation = 0;
      state.probe3Fluctuation = 0;
      state.probe4Fluctuation = state.probeCount === 4 ? 0 : undefined;
      state.probe1Absolute = 0;
      state.probe2Absolute = 0;
      state.probe3Absolute = 0;
      state.probe4Absolute = state.probeCount === 4 ? 0 : undefined;
      this.baselines.delete(state.index);
    }
    this.emit('flame_state', this.getCurrentState());
  }

  async connect(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.disposed = false;
    if (!this.processLock && this.config.units.some((unit) => unit.enabled)) {
      const acquiredLock = await acquireFlameDetectorProcessLock(this.processLockPath);
      if (generation !== this.lifecycleGeneration || this.disposed) {
        await acquiredLock.release();
        return;
      }
      this.processLock = acquiredLock;
    }
    await this.closePool();
    if (generation !== this.lifecycleGeneration || this.disposed) return;
    this.devices.clear();
    const errors: string[] = [];

    for (const unit of this.config.units) {
      if (!unit.enabled) continue;
      const result = await this.connectUnit(unit, generation);
      if (!result.ok) errors.push(`${result.key}: ${result.error}`);
      if (generation !== this.lifecycleGeneration || this.disposed) return;
    }

    if (generation !== this.lifecycleGeneration || this.disposed) return;
    const anyOk = [...this.pool.values()].some((entry) => entry.ok);
    if (anyOk) {
      this.lastError = errors.join('; ');
      this.emit('connected');
      this.startPolling();
    } else {
      this.lastError = errors.join('; ') || '无可用连接';
      this.emit('error', this.lastError);
    }
  }

  async disconnect(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.disposed = true;
    this.stopPolling();
    try {
      await this.closePool();
      this.devices.clear();
    } finally {
      const lock = this.processLock;
      this.processLock = null;
      await lock?.release();
    }
  }

  private async closePool(): Promise<void> {
    this.closing = true;
    if (this.stateBroadcastTimer) clearTimeout(this.stateBroadcastTimer);
    this.stateBroadcastTimer = null;
    this.stateBroadcastPending = false;
    this.lastStateBroadcastAt = 0;
    for (const timer of this.broadcastModeRetryTimers.values()) clearTimeout(timer);
    this.broadcastModeRetryTimers.clear();
    this.broadcastModeRetryAttempts.clear();
    for (const timer of this.waveformWatchdogTimers.values()) clearTimeout(timer);
    this.waveformWatchdogTimers.clear();
    for (const timer of this.unitReconnectTimers.values()) clearTimeout(timer);
    this.unitReconnectTimers.clear();
    this.reconnectingUnits.clear();
    this.broadcastModeRequestingUnits.clear();
    this.broadcastModeRequestInFlight.clear();
    this.waveformRecoveryRequestedUnits.clear();
    for (const index of [...this.socketBindings.keys()]) this.detachPushListener(index);
    for (const { client } of this.pool.values()) {
      await closeClient(client);
    }
    this.pool.clear();
    this.pushBuffers.clear();
    this.modbusPushBuffers.clear();
    this.lastPushAt.clear();
    this.initializingUnits.clear();
    this.broadcastModeUnits.clear();
    this.closing = false;
  }

  private async connectUnit(
    unit: FlameUnitConfig,
    generation = this.lifecycleGeneration,
  ): Promise<{ ok: boolean; key: string; error: string }> {
    const key = connKey(unit, this.config);
    const isTcp = (unit.connMode ?? this.config.mode) === 'TCP';
    const cancelled = () => generation !== this.lifecycleGeneration || this.disposed || this.closing;
    const existing = this.pool.get(key);
    if (existing?.ok) {
      try {
        if (isTcp && !this.socketBindings.has(unit.index)) {
          if (!this.attachPushListener(unit, existing.client)) throw new Error('探测器 TCP 原始监听器创建失败');
        }
        this.markTransportConnected(unit);
        if (isTcp) void this.initializeUnit(unit, existing.client);
        return { ok: true, key, error: '' };
      } catch (error: any) {
        existing.ok = false;
        const message = error?.message || String(error);
        this.setUnitOffline(unit, message);
        this.scheduleUnitReconnect(unit);
        return { ok: false, key, error: message };
      }
    }

    let createdClient: FlameDetectorClient | undefined;
    try {
      const client = await createClient(unit, this.config);
      createdClient = client;
      if (cancelled()) {
        await closeClient(client);
        return { ok: false, key, error: '连接操作已取消' };
      }
      this.pool.set(key, { client, ok: true });
      if (isTcp && !this.attachPushListener(unit, client)) {
        throw new Error('探测器 TCP 原始监听器创建失败');
      }
      this.markTransportConnected(unit);
      if (isTcp) void this.initializeUnit(unit, client);
      console.log(`[FlameService] 连接成功: ${key}`);
      return { ok: true, key, error: '' };
    } catch (error: any) {
      const message = error?.message || String(error);
      await closeClient(createdClient);
      if (cancelled()) return { ok: false, key, error: '连接操作已取消' };
      this.pool.set(key, { client: new ModbusRTU(), ok: false });
      this.setUnitOffline(unit, message);
      this.scheduleUnitReconnect(unit);
      console.error(`[FlameService] 连接失败: ${key}`, message);
      return { ok: false, key, error: message };
    }
  }

  private markTransportConnected(unit: FlameUnitConfig): void {
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    state.lastError = undefined;
    state.lastUpdate = Date.now();
    this.units.set(unit.index, state);
    this.broadcastStateNow();
  }

  private scheduleUnitReconnect(unit: FlameUnitConfig): void {
    if (this.disposed || this.closing || this.unitReconnectTimers.has(unit.index)) return;
    console.log(`[FlameService] 设备 ${unit.index} 安排重连，延迟 ${TCP_RECONNECT_INTERVAL_MS}ms`);
    const timer = setTimeout(() => {
      this.unitReconnectTimers.delete(unit.index);
      void this.reconnectUnit(unit);
    }, TCP_RECONNECT_INTERVAL_MS);
    this.unitReconnectTimers.set(unit.index, timer);
  }

  private async reconnectUnit(unit: FlameUnitConfig): Promise<void> {
    if (this.disposed || this.closing || this.reconnectingUnits.has(unit.index)) return;
    const generation = this.lifecycleGeneration;
    this.reconnectingUnits.add(unit.index);
    const key = connKey(unit, this.config);
    try {
      console.log(`[FlameService] 开始重连设备 ${unit.index}`);
      const entry = this.pool.get(key);
      if (entry?.ok) return;
      await closeClient(entry?.client);
      this.pool.delete(key);
      this.devices.delete(unit.index);
      this.detachPushListener(unit.index);
      this.stopBroadcastModeRequests(unit.index);
      this.broadcastModeUnits.delete(unit.index);
      this.initializingUnits.delete(unit.index);
      this.broadcastModeRequestInFlight.delete(unit.index);
      this.waveformRecoveryRequestedUnits.delete(unit.index);
      this.baselines.delete(unit.index);
      console.log(`[FlameService] 设备 ${unit.index} 已清理旧连接，开始建立新连接`);
      const result = await this.connectUnit(unit, generation);
      console.log(`[FlameService] 设备 ${unit.index} 重连结果: ${result.ok ? '成功' : '失败 - ' + result.error}`);
      if (result.ok && generation === this.lifecycleGeneration && !this.disposed) this.emit('connected');
    } finally {
      this.reconnectingUnits.delete(unit.index);
    }
  }

  private startPolling(): void {
    this.stopPolling();
    const configured = Number(this.config.pollIntervalMs);
    const interval = Number.isFinite(configured)
      ? Math.min(Math.max(Math.floor(configured), 100), MAX_FLAME_POLL_INTERVAL_MS)
      : DEFAULT_FLAME_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => { void this.pollAll(); }, interval);
    void this.pollAll();
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private getDevice(unit: FlameUnitConfig, client: FlameDetectorClient): FlameDetectorDevice {
    const existing = this.devices.get(unit.index);
    if (existing?.isUsingClient(client)) return existing;
    const device = new FlameDetectorDevice(client, unit, this.config);
    this.devices.set(unit.index, device);
    return device;
  }

  private configuredWaveformSendMode(): number {
    return this.config.waveformSendMode === 'filtered'
      ? SEND_MODE_FILTERED_VALUE
      : SEND_MODE_BROADCAST_VALUE;
  }

  private async pollAll(): Promise<void> {
    if (this.polling || this.autoTesting) return;
    this.polling = true;
    try {
      for (const unit of this.config.units) {
        if (!unit.enabled) continue;
        const entry = this.pool.get(connKey(unit, this.config));
        if (!entry?.ok) continue;
        await this.pollUnit(unit, entry.client);
      }
      this.broadcastState();
    } finally {
      this.polling = false;
    }
  }

  private async pollUnit(unit: FlameUnitConfig, client: FlameDetectorClient): Promise<void> {
    if (this.initializingUnits.has(unit.index)) return;
    if ((unit.connMode ?? this.config.mode) === 'TCP') {
      if (!this.broadcastModeUnits.has(unit.index)) void this.initializeUnit(unit, client);
      // 现场 TCP 端口是串口服务器的原始字节流：发送 FF 切换指令后，
      // 后续以 5A A5 推流为唯一实时数据来源。不能在同一 socket 上再发
      // Modbus TCP/MBAP 轮询，否则会把错误协议写入波形流并触发超时。
      return;
    }
    if (Date.now() - (this.lastPushAt.get(unit.index) ?? 0) < 5000) return;
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    const device = this.getDevice(unit, client);
    try {
      const params = await device.readAllBasicParams();
      const alarm = await device.readAlarmStatus();
      state.online = true;
      state.fire = alarm.fireAlarm;
      state.fault = alarm.fault;
      // 旧探测器协议以 A000/A001 提供报警/故障，不提供当前项目早期的线圈位。
      // 读取到完整实时块即视为光源与同步链路已建立，未知状态不会被提升为 PASS。
      state.sourceReady = true;
      state.syncOk = true;
      state.sensitivity = params.sensitivity;
      state.probeCount = params.probeCount;
      state.sendMode = params.sendMode;
      state.address_r = params.commAddr;
      state.protocol = params.protocol.id;
      state.version = params.version;
      state.runTime = params.runtime;
      const realtime = params.sendMode === 0 ? await device.readRealtimeFeatures() : null;
      if (realtime) this.applyRealtimeState(state, realtime, device);
      state.lastError = undefined;
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
    } catch (error: any) {
      // 设备处于主动波形推送时，Modbus 参数轮询可能被固件暂时拒绝/超时。
      // 只要最近仍收到合法推流，就以推流作为在线与同步状态来源，不能用轮询超时覆盖它。
      const lastPush = this.lastPushAt.get(unit.index) ?? 0;
      const pushGrace = Math.max(15_000, (this.config.pollIntervalMs ?? 2000) * 3);
      const pushIsRecent = lastPush > 0 && Date.now() - lastPush <= pushGrace;
      if (pushIsRecent && (state.historySampleTotal ?? 0) > 0) {
        state.online = true;
        state.sourceReady = true;
        state.syncOk = true;
        state.lastError = undefined;
      } else {
        state.online = false;
        state.sourceReady = false;
        state.syncOk = false;
        state.lastError = error?.message || String(error);
      }
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
    }
    this.emit('unit_update', state);
  }

  private waveformStaleTimeoutMs(): number {
    return WAVEFORM_STALE_TIMEOUT_MS;
  }

  private stopBroadcastModeRequests(unitIndex: number): void {
    this.broadcastModeRequestingUnits.delete(unitIndex);
    const retryTimer = this.broadcastModeRetryTimers.get(unitIndex);
    if (retryTimer) clearTimeout(retryTimer);
    this.broadcastModeRetryTimers.delete(unitIndex);
  }

  private scheduleBroadcastModeRetry(unit: FlameUnitConfig, client: FlameDetectorClient): void {
    if (this.disposed || this.closing || !this.broadcastModeRequestingUnits.has(unit.index) || !this.isCurrentClient(unit, client)) return;
    if (this.broadcastModeRetryTimers.has(unit.index) || this.broadcastModeRequestInFlight.has(unit.index)) return;
    const attempt = (this.broadcastModeRetryAttempts.get(unit.index) ?? 0) + 1;
    this.broadcastModeRetryAttempts.set(unit.index, attempt);
    const retryDelay = Math.min(
      SEND_MODE_BROADCAST_RETRY_INTERVAL_MS * (2 ** Math.min(attempt - 1, 5)),
      SEND_MODE_RETRY_MAX_INTERVAL_MS,
    );
    const timer = setTimeout(() => {
      this.broadcastModeRetryTimers.delete(unit.index);
      void this.sendBroadcastModeRequest(unit, client);
    }, retryDelay);
    this.broadcastModeRetryTimers.set(unit.index, timer);
  }

  private async sendBroadcastModeRequest(unit: FlameUnitConfig, client: FlameDetectorClient): Promise<boolean> {
    if (this.disposed || this.closing || !this.broadcastModeRequestingUnits.has(unit.index) || !this.isCurrentClient(unit, client)) return false;
    const inFlightClient = this.broadcastModeRequestInFlight.get(unit.index);
    if (inFlightClient === client) return false;
    if (inFlightClient && !this.isCurrentClient(unit, inFlightClient)) this.broadcastModeRequestInFlight.delete(unit.index);
    if (this.broadcastModeRequestInFlight.has(unit.index)) return false;
    this.broadcastModeRequestInFlight.set(unit.index, client);
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    const sendMode = this.configuredWaveformSendMode();
    console.log(`[FlameService] 设备 ${unit.index} 发送波形模式切换请求 (模式 ${sendMode}, 尝试 ${(this.broadcastModeRetryAttempts.get(unit.index) ?? 0) + 1})`);
    try {
      const device = this.getDevice(unit, client);
      // ACK 只证明设备收到了写入请求，不证明已经开始推送波形；在解析到
      // 合法波形前必须保留重试状态，才能覆盖“有 ACK、无波形”的现场情况。
      await device.sendBroadcastSendMode({
        mode: sendMode,
        attempts: 1,
        retryDelayMs: 0,
        waitForResponse: true,
      });
      if (!this.isCurrentClient(unit, client)) return false;
      console.log(`[FlameService] 设备 ${unit.index} 波形模式切换已确认，继续等待波形数据`);
      state.sendMode = sendMode;
      state.lastError = undefined;
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
      this.scheduleWaveformWatchdog(unit, client);
      return true;
    } catch (error: any) {
      console.error(`[FlameService] 设备 ${unit.index} 波形模式切换请求失败:`, error?.message || String(error));
      if (!this.isCurrentClient(unit, client)) return false;
      const lastPush = this.lastPushAt.get(unit.index) ?? 0;
      const waveformIsRecent = lastPush > 0 && Date.now() - lastPush <= this.waveformStaleTimeoutMs();
      if (waveformIsRecent) {
        // 现场设备可能不会返回发送模式写入的 Modbus ACK。
        // 已经收到合法波形时，ACK 超时只能说明模式确认缺失，不能覆盖真实数据流状态。
        state.sendMode = sendMode;
        state.online = true;
        state.sourceReady = true;
        state.syncOk = true;
        state.lastError = undefined;
      } else {
        state.sendMode = 0;
        state.online = false;
        state.sourceReady = false;
        state.syncOk = false;
        state.lastError = error?.message || String(error);
      }
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
      return false;
    } finally {
      if (this.broadcastModeRequestInFlight.get(unit.index) === client) this.broadcastModeRequestInFlight.delete(unit.index);
      if (this.broadcastModeRequestingUnits.has(unit.index) && this.isCurrentClient(unit, client)) this.scheduleBroadcastModeRetry(unit, client);
      this.emit('unit_update', state);
    }
  }

  private scheduleWaveformWatchdog(unit: FlameUnitConfig, client: FlameDetectorClient): void {
    // 不要在每个高频波形帧上清除并创建新定时器；只保留一个检查点，
    // 回调按 lastPushAt 计算剩余时间，既降低事件循环压力，也不会放宽
    // “ACK 后或最后一帧后 750ms 内判定断流”的时限。
    if (!this.isCurrentClient(unit, client) || this.waveformWatchdogTimers.has(unit.index)) return;
    const timeout = this.waveformStaleTimeoutMs();
    const timer = setTimeout(() => {
      this.waveformWatchdogTimers.delete(unit.index);
      if (!this.isCurrentClient(unit, client)) return;
      const lastPush = this.lastPushAt.get(unit.index) ?? 0;
      const age = lastPush > 0 ? Date.now() - lastPush : timeout;
      if (lastPush > 0 && age < timeout) {
        const nextTimer = setTimeout(() => {
          this.waveformWatchdogTimers.delete(unit.index);
          if (!this.isCurrentClient(unit, client)) return;
          const latestPush = this.lastPushAt.get(unit.index) ?? 0;
          if (latestPush > 0 && Date.now() - latestPush < timeout) {
            this.scheduleWaveformWatchdog(unit, client);
          } else {
            this.handleWaveformStale(unit, client);
          }
        }, Math.max(1, timeout - age));
        this.waveformWatchdogTimers.set(unit.index, nextTimer);
        return;
      }
      this.handleWaveformStale(unit, client);
    }, timeout);
    this.waveformWatchdogTimers.set(unit.index, timer);
  }

  private handleWaveformStale(unit: FlameUnitConfig, client: FlameDetectorClient): void {
    if (this.disposed || this.closing || !this.isCurrentClient(unit, client)) return;
    // 探测器断电/重接时，串口服务器的 TCP 会话可能不断开。
    // 此时必须在当前 socket 上重新切换连续发送模式；请求会
    // 串行执行，并在解析到新波形后停止重试。
    this.stopBroadcastModeRequests(unit.index);
    this.broadcastModeRequestingUnits.add(unit.index);
    this.setUnitOffline(unit, '实时波形流超时，正在重新切换发送模式');
    void this.initializeUnit(unit, client);
  }

  /** 连接成功后发送一次受确认的模式切换握手，再监听 TCP 原始波形流。 */
  private async initializeUnit(unit: FlameUnitConfig, client: FlameDetectorClient): Promise<void> {
    if (!this.isCurrentClient(unit, client)) return;
    if (this.initializingUnits.get(unit.index) === client) return;
    this.initializingUnits.set(unit.index, client);
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    this.broadcastModeUnits.add(unit.index);
    this.broadcastModeRequestingUnits.add(unit.index);
    try {
      const confirmed = await this.sendBroadcastModeRequest(unit, client);
      if (confirmed) {
        console.log(`[FlameService] 设备 ${unit.index} 发送模式切换指令已确认`);
      } else if (state.lastError) {
        console.warn(`[FlameService] 设备 ${unit.index} 发送模式切换指令未确认: ${state.lastError}`);
      }
    } catch (error: any) {
      console.error(`[FlameService] 设备 ${unit.index} 初始化异常:`, error?.message || String(error));
      state.sendMode = 0;
      state.lastError = error?.message || String(error);
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
    } finally {
      if (this.initializingUnits.get(unit.index) === client) this.initializingUnits.delete(unit.index);
      this.emit('unit_update', state);
    }
  }

  private attachPushListener(unit: FlameUnitConfig, client: FlameDetectorClient): boolean {
    if ((unit.connMode ?? this.config.mode) !== 'TCP') return true;
    const socket = getRawTcpSocket(client);
    if (!socket?.on) {
      console.error(`[FlameService] 设备 ${unit.index} 无法获取 TCP Socket`);
      return false;
    }
    this.detachPushListener(unit.index);
    const onData = (chunk: Buffer) => {
      if (!this.isCurrentClient(unit, client)) return;
      const currentChunk = Buffer.from(chunk);
      const combined = Buffer.concat([this.pushBuffers.get(unit.index) ?? Buffer.alloc(0), currentChunk]);
      const cleaned = removeSendModeAck(combined);
      const extracted = extractCustomWaveformFrames(cleaned, [27, 29, 35, 170]);
      this.pushBuffers.set(unit.index, extracted.remainder);
      for (const frame of extracted.frames) {
        try {
          this.applyPushFrame(unit, client, frame);
        } catch (error: any) {
          const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
          state.lastError = error?.message || String(error);
          state.lastUpdate = Date.now();
          this.units.set(unit.index, state);
          console.error(`[FlameService] 推流帧解析失败（${unit.index}）:`, state.lastError);
          this.emit('unit_update', state);
        }
      }

      const modbusCombined = Buffer.concat([this.modbusPushBuffers.get(unit.index) ?? Buffer.alloc(0), currentChunk]);
      const modbusExtracted = extractModbusRealtimeFrames(modbusCombined, [0x86, 0xA6, 0xC6]);
      this.modbusPushBuffers.set(unit.index, modbusExtracted.remainder);
      for (const frame of modbusExtracted.frames) {
        try {
          this.applyModbusPushFrame(unit, client, frame);
        } catch (error: any) {
          const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
          state.lastError = error?.message || String(error);
          state.lastUpdate = Date.now();
          this.units.set(unit.index, state);
          console.error(`[FlameService] Modbus 推流帧解析失败（${unit.index}）:`, state.lastError);
          this.emit('unit_update', state);
        }
      }
      if (extracted.frames.length > 0 || modbusExtracted.frames.length > 0) this.broadcastState();
    };
    const onError = (error: Error) => this.handleTcpSocketUnavailable(unit, client, error?.message || 'TCP连接错误');
    const onClose = () => this.handleTcpSocketUnavailable(unit, client, 'TCP连接已关闭');
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    this.socketBindings.set(unit.index, { socket, onData, onError, onClose });
    return true;
  }

  private detachPushListener(unitIndex: number): void {
    const binding = this.socketBindings.get(unitIndex);
    if (!binding) return;
    binding.socket.removeListener?.('data', binding.onData);
    binding.socket.removeListener?.('error', binding.onError);
    binding.socket.removeListener?.('close', binding.onClose);
    this.socketBindings.delete(unitIndex);
    this.pushBuffers.delete(unitIndex);
    this.modbusPushBuffers.delete(unitIndex);
    const watchdog = this.waveformWatchdogTimers.get(unitIndex);
    if (watchdog) clearTimeout(watchdog);
    this.waveformWatchdogTimers.delete(unitIndex);
  }

  /** 仅处理串口服务器 TCP 会话本身异常；波形流超时不会进入这里。 */
  private handleTcpSocketUnavailable(unit: FlameUnitConfig, client: FlameDetectorClient, error: string): void {
    if (this.disposed || this.closing) return;
    console.log(`[FlameService] 设备 ${unit.index} TCP Socket 不可用: ${error}`);
    const key = connKey(unit, this.config);
    const entry = this.pool.get(key);
    if (entry && entry.client !== client) return;
    if (entry) entry.ok = false;
    this.detachPushListener(unit.index);
    this.stopBroadcastModeRequests(unit.index);
    const watchdog = this.waveformWatchdogTimers.get(unit.index);
    if (watchdog) clearTimeout(watchdog);
    this.waveformWatchdogTimers.delete(unit.index);
    this.broadcastModeUnits.delete(unit.index);
    this.setUnitOffline(unit, error);
    this.scheduleUnitReconnect(unit);
  }

  private setUnitOffline(unit: FlameUnitConfig, error: string): void {
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    state.online = false;
    state.sourceReady = false;
    state.syncOk = false;
    state.sendMode = 0;
    state.lastError = error;
    state.lastUpdate = Date.now();
    this.units.set(unit.index, state);
    this.emit('unit_update', state);
    this.broadcastStateNow();
  }

  private applyPushFrame(unit: FlameUnitConfig, client: FlameDetectorClient, frame: Buffer): void {
    if (!this.isCurrentClient(unit, client)) return;
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    const device = this.getDevice(unit, client);
    if (frame.length === 35) device.setProtocolProfile(FLAME_PROTOCOLS.FOUR_WAVELENGTH);
    if (frame.length === 27) device.setProtocolProfile(FLAME_PROTOCOLS.STANDARD);
    state.protocol = device.getProtocolProfile().id;
    state.probeCount = device.getProtocolProfile().channels;
    const decoded = decodeCustomWaveformFrame(frame, device.getProtocolProfile());
    if (decoded.samples.length === 0) return;
    const normalized = device.normalizeSamples(decoded.samples, this.baselines.get(unit.index));
    this.baselines.set(unit.index, normalized.baseline);
    if (this.broadcastModeRequestingUnits.has(unit.index)) {
      this.stopBroadcastModeRequests(unit.index);
      this.broadcastModeRetryAttempts.delete(unit.index);
    }
    this.broadcastModeUnits.add(unit.index);
    const maxHistory = this.config.waveformMaxSamples || 1000;
    state.online = true;
    state.sourceReady = true;
    state.syncOk = true;
    state.rawSamples = decoded.samples;
    state.samples = normalized.samples;
    state.rawHistorySamples = [...(state.rawHistorySamples ?? []), ...decoded.samples].slice(-maxHistory);
    state.historySamples = [...(state.historySamples ?? []), ...normalized.samples].slice(-maxHistory);
    state.historySampleTotal = (state.historySampleTotal ?? 0) + decoded.samples.length;
    const latest = decoded.samples.at(-1);
    state.sendMode = state.sendMode || this.configuredWaveformSendMode();
    state.probe1 = latest?.probe1 ?? state.probe1;
    state.probe2 = latest?.probe2 ?? state.probe2;
    state.probe3 = latest?.probe3 ?? state.probe3;
    state.probe4 = latest?.probe4;
    const metrics = summarizeWaveformChannels(state.historySamples);
    const absoluteMetrics = summarizeWaveformChannels(state.rawHistorySamples);
    state.probe1 = metrics.probe1.fluctuation;
    state.probe2 = metrics.probe2.fluctuation;
    state.probe3 = metrics.probe3.fluctuation;
    state.probe4 = device.getProtocolProfile().isFourWavelength ? metrics.probe4.fluctuation : undefined;
    state.probe1Fluctuation = metrics.probe1.fluctuation;
    state.probe2Fluctuation = metrics.probe2.fluctuation;
    state.probe3Fluctuation = metrics.probe3.fluctuation;
    state.probe4Fluctuation = device.getProtocolProfile().isFourWavelength ? metrics.probe4.fluctuation : undefined;
    state.probe1Absolute = absoluteMetrics.probe1.absolute;
    state.probe2Absolute = absoluteMetrics.probe2.absolute;
    state.probe3Absolute = absoluteMetrics.probe3.absolute;
    state.probe4Absolute = device.getProtocolProfile().isFourWavelength ? absoluteMetrics.probe4.absolute : undefined;
    state.snr21 = metrics.probe1.fluctuation > 0 ? metrics.probe2.fluctuation / metrics.probe1.fluctuation : 0;
    state.snr23 = metrics.probe3.fluctuation > 0 ? metrics.probe2.fluctuation / metrics.probe3.fluctuation : 0;
    state.snr31 = metrics.probe1.fluctuation > 0 ? metrics.probe3.fluctuation / metrics.probe1.fluctuation : 0;
    state.lastError = undefined;
    state.lastUpdate = Date.now();
    this.lastPushAt.set(unit.index, state.lastUpdate);
    this.waveformRecoveryRequestedUnits.delete(unit.index);
    this.units.set(unit.index, state);
    this.scheduleWaveformWatchdog(unit, client);
    this.emit('unit_update', state);
  }

  private applyModbusPushFrame(unit: FlameUnitConfig, client: FlameDetectorClient, frame: Buffer): void {
    if (!this.isCurrentClient(unit, client)) return;
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    const device = this.getDevice(unit, client);
    const byteCount = frame[2] ?? 0;
    if (byteCount === 0xC6) device.setProtocolProfile(FLAME_PROTOCOLS.FOUR_WAVELENGTH);
    if (byteCount === 0x86 || byteCount === 0xA6) device.setProtocolProfile(FLAME_PROTOCOLS.STANDARD);
    const decoded = decodeModbusRealtimeFrame(frame, device.getProtocolProfile());
    if (decoded.samples.length === 0) return;

    state.protocol = device.getProtocolProfile().id;
    state.probeCount = device.getProtocolProfile().channels;
    state.online = true;
    state.sourceReady = true;
    state.syncOk = true;
    state.sendMode = state.sendMode || this.configuredWaveformSendMode();
    if (this.broadcastModeRequestingUnits.has(unit.index)) {
      this.stopBroadcastModeRequests(unit.index);
      this.broadcastModeRetryAttempts.delete(unit.index);
    }
    this.broadcastModeUnits.add(unit.index);
    this.applyRealtimeState(state, decoded, device);
    state.lastError = undefined;
    state.lastUpdate = Date.now();
    this.lastPushAt.set(unit.index, state.lastUpdate);
    this.waveformRecoveryRequestedUnits.delete(unit.index);
    this.units.set(unit.index, state);
    this.scheduleWaveformWatchdog(unit, client);
    this.emit('unit_update', state);
  }

  private applyRealtimeState(state: FlameDetectorUnitState, realtime: DecodedFeatureBlock, device: FlameDetectorDevice): void {
    const visible = realtime.samples.slice(-5);
    const normalized = device.normalizeSamples(visible, this.baselines.get(state.index));
    this.baselines.set(state.index, normalized.baseline);
    const maxHistory = this.config.waveformMaxSamples || 1000;
    const rawHistory = [...(state.rawHistorySamples ?? []), ...visible].slice(-maxHistory);
    const history = [...(state.historySamples ?? []), ...normalized.samples].slice(-maxHistory);
    const latest = visible[visible.length - 1];
    const latestFeature = realtime.features[realtime.features.length - 1];
    state.probe1 = latest?.probe1 ?? state.probe1;
    state.probe2 = latest?.probe2 ?? state.probe2;
    state.probe3 = latest?.probe3 ?? state.probe3;
    state.probe4 = latest?.probe4;
    state.snr21 = latestFeature?.snr21 ?? state.snr21;
    state.snr23 = latestFeature?.snr23 ?? state.snr23;
    state.snr31 = latestFeature?.snr31 ?? state.snr31;
    state.features = realtime.features as FlameFeature[];
    state.samples = normalized.samples;
    state.rawSamples = visible;
    state.historySamples = history;
    state.rawHistorySamples = rawHistory;
    state.historySampleTotal = (state.historySampleTotal ?? 0) + normalized.samples.length;
    const metrics = summarizeWaveformChannels(history);
    const rawMetrics = summarizeWaveformChannels(rawHistory);
    state.probe1 = metrics.probe1.fluctuation;
    state.probe2 = metrics.probe2.fluctuation;
    state.probe3 = metrics.probe3.fluctuation;
    state.probe4 = device.getProtocolProfile().isFourWavelength ? metrics.probe4.fluctuation : undefined;
    state.probe1Fluctuation = metrics.probe1.fluctuation;
    state.probe2Fluctuation = metrics.probe2.fluctuation;
    state.probe3Fluctuation = metrics.probe3.fluctuation;
    state.probe4Fluctuation = device.getProtocolProfile().isFourWavelength ? metrics.probe4.fluctuation : undefined;
    state.probe1Absolute = rawMetrics.probe1.absolute;
    state.probe2Absolute = rawMetrics.probe2.absolute;
    state.probe3Absolute = rawMetrics.probe3.absolute;
    state.probe4Absolute = device.getProtocolProfile().isFourWavelength ? rawMetrics.probe4.absolute : undefined;
    state.snr21 = metrics.probe1.fluctuation > 0 ? metrics.probe2.fluctuation / metrics.probe1.fluctuation : 0;
    state.snr23 = metrics.probe3.fluctuation > 0 ? metrics.probe2.fluctuation / metrics.probe3.fluctuation : 0;
    state.snr31 = metrics.probe1.fluctuation > 0 ? metrics.probe3.fluctuation / metrics.probe1.fluctuation : 0;
  }

  private createState(): FlameDetectorState {
    const units = Array.from(this.units.values()).sort((a, b) => a.index - b.index);
    return {
      units,
      onlineCount: units.filter((unit) => unit.online).length,
      fireCount: units.filter((unit) => unit.fire).length,
      faultCount: units.filter((unit) => unit.fault).length,
      timestamp: Date.now(),
    };
  }

  private emitCurrentState(): void {
    this.lastStateBroadcastAt = Date.now();
    this.emit('flame_state', this.createState());
  }

  /**
   * 波形帧可能高频到达；状态推送按 50ms 合并，每次发布该时刻的最新采样，
   * 六台设备的完整历史，阻塞采集线程和浏览器渲染线程。断连状态使用
   * broadcastStateNow()，因此仍会立即通知前端。
   */
  private broadcastState(): void {
    if (this.disposed || this.closing) return;
    const elapsed = Date.now() - this.lastStateBroadcastAt;
    if (!this.stateBroadcastTimer && elapsed >= WAVEFORM_STATE_BROADCAST_INTERVAL_MS) {
      this.emitCurrentState();
      return;
    }
    this.stateBroadcastPending = true;
    if (this.stateBroadcastTimer) return;
    const delay = Math.max(0, WAVEFORM_STATE_BROADCAST_INTERVAL_MS - elapsed);
    this.stateBroadcastTimer = setTimeout(() => {
      this.stateBroadcastTimer = null;
      if (!this.stateBroadcastPending) return;
      this.stateBroadcastPending = false;
      if (!this.disposed && !this.closing) this.emitCurrentState();
    }, delay);
  }

  private broadcastStateNow(): void {
    if (this.stateBroadcastTimer) clearTimeout(this.stateBroadcastTimer);
    this.stateBroadcastTimer = null;
    this.stateBroadcastPending = false;
    if (!this.disposed && !this.closing) this.emitCurrentState();
  }

  getCurrentState(): FlameDetectorState {
    return this.createState();
  }

  /** 串口服务器 TCP 会话是否存在；不代表探测器已经输出波形。 */
  isTransportConnected(): boolean {
    return this.config.units.some((unit) => unit.enabled && this.pool.get(connKey(unit, this.config))?.ok === true);
  }

  /** 探测器是否仍在输出最近的合法 5A A5 波形帧。 */
  isDataStreamConnected(): boolean {
    const now = Date.now();
    return this.config.units.some((unit) => {
      if (!unit.enabled) return false;
      const state = this.units.get(unit.index);
      if ((unit.connMode ?? this.config.mode) !== 'TCP') return state?.online === true;
      const lastPush = this.lastPushAt.get(unit.index) ?? 0;
      return state?.online === true
        && lastPush > 0
        && now - lastPush <= this.waveformStaleTimeoutMs();
    });
  }

  /** 对外的“探测器连接”状态严格按真实波形数据流判定。 */
  isConnected(): boolean { return this.isDataStreamConnected(); }
  getLastError(): string { return this.lastError; }

  getStatus(): {
    connected: boolean;
    transportConnected: boolean;
    dataStreamConnected: boolean;
    mode: FlameConfig['mode'];
    lastError?: string;
  } {
    const transportConnected = this.isTransportConnected();
    const dataStreamConnected = this.isDataStreamConnected();
    return {
      // 保持兼容：connected 表示探测器数据链路，不是串口服务器 TCP 会话。
      connected: dataStreamConnected,
      transportConnected,
      dataStreamConnected,
      mode: this.config.mode,
      lastError: this.lastError || undefined,
    };
  }

  updateConfig(newConfig: FlameConfig): void {
    this.config = newConfig;
    this.units.clear();
    this.baselines.clear();
    this.initUnits();
  }

  private isAutoTestTransportInterrupted(unit: FlameUnitConfig, client?: FlameDetectorClient): boolean {
    const entry = this.pool.get(connKey(unit, this.config));
    if (!entry?.ok || (client && entry.client !== client)) return true;
    if (!client) return true;
    const socket = getRawTcpSocket(client);
    return Boolean(socket?.destroyed || socket?.writable === false);
  }

  private isCurrentClient(unit: FlameUnitConfig, client: FlameDetectorClient): boolean {
    if (this.disposed || this.closing) return false;
    const entry = this.pool.get(connKey(unit, this.config));
    return !entry || (entry.ok && entry.client === client);
  }

  private isAutoTestTransportError(error: any): boolean {
    const message = String(error?.message ?? error).toLowerCase();
    return /(timed out|timeout|econnreset|econnaborted|epipe|not connected|socket|closed|destroyed)/.test(message);
  }

  private async waitForAutoTestTransport(unit: FlameUnitConfig, previousClient?: FlameDetectorClient): Promise<boolean> {
    const deadline = Date.now() + AUTO_TEST_RECONNECT_WAIT_MS;
    while (Date.now() < deadline) {
      const entry = this.pool.get(connKey(unit, this.config));
      const socket = entry?.ok ? getRawTcpSocket(entry.client) : undefined;
      if (
        entry?.ok
        && (!previousClient || entry.client !== previousClient)
        && !this.initializingUnits.has(unit.index)
        && !this.broadcastModeRequestingUnits.has(unit.index)
        && !socket?.destroyed
        && socket?.writable !== false
      ) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const entry = this.pool.get(connKey(unit, this.config));
    const socket = entry?.ok ? getRawTcpSocket(entry.client) : undefined;
    return Boolean(
      entry?.ok
      && (!previousClient || entry.client !== previousClient)
      && !this.initializingUnits.has(unit.index)
      && !this.broadcastModeRequestingUnits.has(unit.index)
      && !socket?.destroyed
      && socket?.writable !== false,
    );
  }

  private async waitForUnitInitialization(unit: FlameUnitConfig): Promise<boolean> {
    const deadline = Date.now() + AUTO_TEST_RECONNECT_WAIT_MS;
    while (
      (this.initializingUnits.has(unit.index) || this.broadcastModeRequestingUnits.has(unit.index))
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !this.initializingUnits.has(unit.index) && !this.broadcastModeRequestingUnits.has(unit.index);
  }

  private async executeAutoTestStep(stepKey: string, device: FlameDetectorDevice): Promise<unknown> {
    switch (stepKey) {
      case 'connection': return { connected: true, reportedAddr: await device.readCommAddress() };
      case 'version': return { version: await device.readSoftwareVersion(), runtime: await device.readRuntime() };
      case 'params': return device.readAllBasicParams();
      case 'status': {
        const alarm = await device.readAlarmStatus();
        if (alarm.fault) throw new Error('设备存在故障指示');
        return alarm;
      }
      case 'realtime': {
        const realtime = await device.readRealtimeFeatures();
        if (realtime.features.length === 0) throw new Error('未读取到实时特征量');
        return { fifoCount: realtime.fifoCount, featureCount: realtime.features.length, samples: realtime.samples.length };
      }
      case 'mirror': {
        const mirror = await device.readMirrorStatus();
        if (mirror.enabled && !mirror.normal) throw new Error('镜面污染超标');
        return mirror;
      }
      case 'report': return { generated: true, timestamp: new Date().toISOString() };
      default: throw new Error(`未知自动检测项: ${stepKey}`);
    }
  }

  async runAutoTest(onProgress?: (progress: AutoTestProgress) => void, options: { enabledStepKeys?: string[] } = {}): Promise<AutoTestReport> {
    if (this.autoTesting) throw new Error('自动检测正在运行');
    const enabled = this.config.units.filter((unit) => unit.enabled);
    if (enabled.length === 0) throw new Error('没有启用的设备');
    const start = new Date();
    const report: AutoTestReport = {
      startTime: start.toISOString(),
      endTime: '',
      devices: {},
      summary: { total: enabled.length, passed: 0 },
      passed: false,
    };
    enabled.forEach((unit) => { report.devices[String(unit.index)] = { address: unit.address, passed: true, steps: [] }; });

    const allSteps = [
      { key: 'connection', name: '连接检测' },
      { key: 'version', name: '版本读取' },
      { key: 'params', name: '参数检测' },
      { key: 'status', name: '状态监控' },
      { key: 'realtime', name: '实时数据' },
      { key: 'mirror', name: '镜面检测' },
      { key: 'report', name: '生成报告' },
    ];
    const selectedKeys = Array.isArray(options.enabledStepKeys) && options.enabledStepKeys.length > 0 ? new Set(options.enabledStepKeys) : null;
    const steps = selectedKeys ? allSteps.filter((step) => selectedKeys.has(step.key)) : allSteps;
    if (steps.length === 0) throw new Error('没有启用的检测项');

    for (const unit of enabled) {
      if (!(await this.waitForUnitInitialization(unit))) {
        throw new Error(`设备${unit.index}发送模式初始化未在1秒内完成`);
      }
    }

    this.autoTesting = true;
    const wasPolling = this.pollTimer !== null;
    this.stopPolling();
    try {
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const step = steps[stepIndex]!;
        for (const unit of enabled) {
          const result = report.devices[String(unit.index)]!;
          const progressBase = { unitIndex: unit.index, stepIndex, stepKey: step.key, stepName: step.name };
          onProgress?.({ ...progressBase, status: 'running' });
          this.emit('auto_test_progress', { ...progressBase, status: 'running' } satisfies AutoTestProgress);
          let data: unknown;
          let lastError: any;
          let passed = false;
          for (let attempt = 0; attempt < AUTO_TEST_MAX_ATTEMPTS; attempt += 1) {
            if (!(await this.waitForUnitInitialization(unit))) {
              lastError = new Error(`设备${unit.index}发送模式初始化未在1秒内完成`);
              break;
            }
            const entry = this.pool.get(connKey(unit, this.config));
            const client = entry?.ok ? entry.client : undefined;
            try {
              if (!client) throw new Error('设备未连接');
              data = await this.executeAutoTestStep(step.key, this.getDevice(unit, client));
              passed = true;
              break;
            } catch (error: any) {
              lastError = error;
              if (attempt < AUTO_TEST_MAX_ATTEMPTS - 1 && (
                this.isAutoTestTransportInterrupted(unit, client)
                || this.isAutoTestTransportError(error)
              )) {
                await this.waitForAutoTestTransport(unit, client);
                continue;
              }
              break;
            }
          }
          if (passed) {
            result.steps.push({ step: stepIndex, key: step.key, name: step.name, passed: true, data });
            onProgress?.({ ...progressBase, status: 'success', data });
            this.emit('auto_test_progress', { ...progressBase, status: 'success', data } satisfies AutoTestProgress);
          } else {
            result.passed = false;
            const message = lastError?.message || String(lastError || '自动检测失败');
            result.steps.push({ step: stepIndex, key: step.key, name: step.name, passed: false, error: message });
            onProgress?.({ ...progressBase, status: 'error', data: { error: message } });
            this.emit('auto_test_progress', { ...progressBase, status: 'error', data: { error: message } } satisfies AutoTestProgress);
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      this.autoTesting = false;
      if (wasPolling && this.isTransportConnected()) this.startPolling();
    }

    const passed = enabled.filter((unit) => report.devices[String(unit.index)]?.passed).length;
    report.summary = { total: enabled.length, passed };
    report.passed = passed === enabled.length;
    report.endTime = new Date().toISOString();
    this.emit('auto_test_complete', report);
    return report;
  }
}
