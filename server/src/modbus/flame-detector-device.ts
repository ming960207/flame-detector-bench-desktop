import ModbusRTU from 'modbus-serial';
import { Socket } from 'node:net';
import { RawTcpModbusClient } from './flame-detector-raw-client.js';
import {
  calculateModbusCRC16,
  decodeFeatureBlock,
  decodeRealtime,
  limitSamples,
  type DecodedFeatureBlock,
  type FlameSample,
} from './flame-data-decoder.js';
import { FLAME_PROTOCOLS, resolveFlameProtocol, type FlameProtocolProfile } from './flame-protocol.js';
import type { FlameConfig, FlameUnitConfig } from '../config.js';

export const FLAME_DETECTOR_REGISTERS = Object.freeze({
  SENSITIVITY: 0x0000,
  PROBE_COUNT: 0x1000,
  SEND_MODE: 0x3000,
  FLAME_MODE_BASE: 0x4000,
  ALARM_RECORD_BASE: 0x5000,
  REALTIME_BASE: 0x6000,
  INSPECTION_MODE: 0x2000,
  SW_VERSION: 0x7000,
  RUNTIME_HI: 0x7002,
  COMM_ADDRESS: 0x8000,
  MIRROR_BASE: 0x9000,
  FIRE_ALARM_STATUS: 0xA000,
  FAULT_STATUS: 0xA001,
  LATCHED_ALARM_STATUS: 0xB000,
  LATCHED_FAULT_STATUS: 0xB001,
  SYSTEM_RESET: 0xF000,
});

/** 连接探测器后使用的发送模式切换帧常量（Modbus RTU 原始帧）。 */
export const SEND_MODE_BROADCAST_VALUE = 1;
export const SEND_MODE_FILTERED_VALUE = 2;
export const SEND_MODE_BROADCAST_FRAME_HEX = 'FF10300000020400010008C043';
export const SEND_MODE_BROADCAST_MAX_ATTEMPTS = 3;
export const SEND_MODE_BROADCAST_RETRY_DELAY_MS = 100;
// Mode confirmation must not consume the one-second reconnect/status budget.
export const SEND_MODE_BROADCAST_RESPONSE_TIMEOUT_MS = 700;
export const SEND_MODE_BROADCAST_ADDRESS = 0xFF;

/** Build the raw RTU mode frame; continuous waveform startup uses FF broadcast. */
export function buildSendModeFrame(address = SEND_MODE_BROADCAST_ADDRESS, mode = SEND_MODE_BROADCAST_VALUE): Buffer {
  const targetAddress = Number.isInteger(address) && address >= 1 && address <= 247
    ? address
    : SEND_MODE_BROADCAST_ADDRESS;
  if (mode !== SEND_MODE_BROADCAST_VALUE && mode !== SEND_MODE_FILTERED_VALUE) {
    throw new Error('波形发送模式必须为主动发送(1)或滤波发送(2)');
  }
  const body = Buffer.from([targetAddress, 0x10, 0x30, 0x00, 0x00, 0x02, 0x04, 0x00, mode, 0x00, 0x08]);
  const crc = calculateModbusCRC16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >>> 8) & 0xFF])]);
}

export function buildSendModeFrameHex(address = SEND_MODE_BROADCAST_ADDRESS, mode = SEND_MODE_BROADCAST_VALUE): string {
  return buildSendModeFrame(address, mode).toString('hex').toUpperCase();
}

export type FlameDetectorClient = ModbusRTU | RawTcpModbusClient;

export type RawTcpSocket = {
  destroyed?: boolean;
  writable?: boolean;
  write: (data: Buffer | Uint8Array, callback?: (error?: Error | null) => void) => boolean;
  on?: (event: string, listener: (...args: any[]) => unknown) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => unknown) => unknown;
};

export function isRawTcpClient(client: unknown): client is RawTcpModbusClient {
  return client instanceof RawTcpModbusClient;
}

export function getRawTcpSocket(client: unknown): RawTcpSocket | undefined {
  if (isRawTcpClient(client)) return client.socket;
  if (client instanceof Socket) return client;
  return (client as any)?._port?._client as RawTcpSocket | undefined;
}

function requireModbusClient(client: FlameDetectorClient): ModbusRTU {
  if (isRawTcpClient(client) || typeof (client as any)?.readHoldingRegisters !== 'function') {
    throw new Error('当前探测器连接不支持 Modbus 寄存器请求');
  }
  return client as ModbusRTU;
}

interface BroadcastWriteResponseWaiter {
  promise: Promise<void>;
  cancel: () => void;
}

function isValidModbusFrame(frame: Buffer): boolean {
  if (frame.length < 3) return false;
  const received = (frame[frame.length - 1]! << 8) | frame[frame.length - 2]!;
  return calculateModbusCRC16(frame.subarray(0, -2)) === received;
}

function findBroadcastWriteResponse(buffer: Buffer, request: Buffer): { response?: Buffer; error?: Error } | null {
  const expectedAddress = request[0] ?? SEND_MODE_BROADCAST_ADDRESS;
  const expectedStart = request.readUInt16BE(2);
  const expectedQuantity = request.readUInt16BE(4);
  for (let offset = 0; offset <= buffer.length - 5; offset += 1) {
    const functionCode = buffer[offset + 1];
    const frameLength = functionCode === 0x10 ? 8 : functionCode === 0x90 ? 5 : 0;
    if (!frameLength) continue;
    if (buffer.length - offset < frameLength) return null;
    const candidate = buffer.subarray(offset, offset + frameLength);
    if (!isValidModbusFrame(candidate)) continue;
    if (expectedAddress !== SEND_MODE_BROADCAST_ADDRESS && candidate[0] !== expectedAddress) continue;
    if (functionCode === 0x90) {
      return { error: new Error(`探测器拒绝发送模式指令，异常码 0x${(candidate[2] ?? 0).toString(16).padStart(2, '0')}`) };
    }
    const start = candidate.readUInt16BE(2);
    const quantity = candidate.readUInt16BE(4);
    if (start === expectedStart && quantity === expectedQuantity) return { response: Buffer.from(candidate) };
  }
  return null;
}

function waitForBroadcastWriteResponse(
  socket: RawTcpSocket,
  request: Buffer,
  timeoutMs: number,
): BroadcastWriteResponseWaiter {
  if (typeof socket.on !== 'function' || typeof socket.removeListener !== 'function') {
    throw new Error('探测器 TCP 连接不支持等待发送模式回包');
  }

  let buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  let settle: (() => void) | undefined;
  let fail: ((reason?: unknown) => void) | undefined;
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (timer) clearTimeout(timer);
    socket.removeListener!('data', onData);
  };
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const finish = (error?: Error) => {
    cleanup();
    if (error) fail?.(error);
    else settle?.();
  };
  const onData = (chunk: Buffer) => {
    if (!active) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    const found = findBroadcastWriteResponse(buffer, request);
    if (found?.error) finish(found.error);
    else if (found?.response) finish();
    else if (buffer.length > 4096) buffer = buffer.subarray(-32);
  };

  socket.on('data', onData);
  timer = setTimeout(() => finish(new Error(`等待探测器发送模式回包超时（${timeoutMs}ms）`)), timeoutMs);
  return { promise, cancel: cleanup };
}

export interface FlameAlarmStatus {
  fireAlarm: boolean;
  fault: boolean;
  rawFire: number;
  rawFault: number;
}

export interface FlameMirrorStatus {
  enabled: boolean;
  interval: number;
  threshold: number;
  intervalCount: number;
  power: number;
  exceedCount: number;
  started: boolean;
  timing: number;
  normal: boolean;
}

export interface FlameBasicParams {
  sensitivity: number;
  probeCount: number;
  sendMode: number;
  commAddr: number;
  protocol: FlameProtocolProfile;
  version: string;
  runtime: number;
}

export class FlameDetectorDevice {
  private profile: FlameProtocolProfile;
  private readonly protocolExplicit: boolean;

  constructor(
    private readonly client: FlameDetectorClient,
    private readonly unit: FlameUnitConfig,
    globalConfig: FlameConfig,
  ) {
    this.profile = resolveFlameProtocol(unit.protocol ?? globalConfig.protocol ?? 'standard');
    this.protocolExplicit = unit.protocol !== undefined || globalConfig.protocol !== undefined;
  }

  isUsingClient(client: FlameDetectorClient): boolean {
    return this.client === client;
  }

  getProtocolProfile(): FlameProtocolProfile {
    return this.profile;
  }

  setProtocolProfile(profile: FlameProtocolProfile): void {
    if (!this.protocolExplicit) this.profile = profile;
  }

  isFourWavelength(): boolean {
    return this.profile.isFourWavelength;
  }

  async readRegisters(startAddress: number, quantity: number): Promise<number[]> {
    if (isRawTcpClient(this.client)) {
      const result = await this.client.readHoldingRegisters(this.unit.address, startAddress, quantity);
      if (!Array.isArray(result.data) || result.data.length !== quantity) {
        throw new Error(`寄存器数量不一致: 期望${quantity}个，实际收到${result.data?.length ?? 0}个 (addr=0x${startAddress.toString(16)})`);
      }
      return result.data.map((value) => Number(value) & 0xFFFF);
    }
    const client = requireModbusClient(this.client);
    client.setID(this.unit.address);
    const result = await client.readHoldingRegisters(startAddress, quantity);
    if (!Array.isArray(result.data) || result.data.length !== quantity) {
      throw new Error(`寄存器数量不一致: 期望${quantity}个，实际收到${result.data?.length ?? 0}个 (addr=0x${startAddress.toString(16)})`);
    }
    return result.data.map((value) => Number(value) & 0xFFFF);
  }

  async writeRegisters(startAddress: number, values: number[]): Promise<void> {
    if (isRawTcpClient(this.client)) {
      await this.client.writeRegisters(this.unit.address, startAddress, values);
      return;
    }
    const client = requireModbusClient(this.client);
    client.setID(this.unit.address);
    await client.writeRegisters(startAddress, values.map((value) => Number(value) & 0xFFFF));
  }

  /**
   * 原样发送现场要求的发送模式 RTU 帧。
   *
   * 火焰探测器 TCP 端口是串口服务器提供的原始 RTU 字节流，不能使用
   * modbus-serial.connectTCP()。这里直接写入原始 TCP socket；独立 TCP
   * 端口使用现场约定的 FF 广播帧。
   */
  async sendBroadcastSendMode(options: {
    /** Use FF only for an explicit broadcast/unknown-address operation. */
    address?: number;
    mode?: number;
    attempts?: number;
    retryDelayMs?: number;
    waitForResponse?: boolean;
    responseTimeoutMs?: number;
  } = {}): Promise<void> {
    const attempts = Number.isInteger(options.attempts) && Number(options.attempts) > 0
      ? Number(options.attempts)
      : SEND_MODE_BROADCAST_MAX_ATTEMPTS;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) && Number(options.retryDelayMs) >= 0
      ? Number(options.retryDelayMs)
      : SEND_MODE_BROADCAST_RETRY_DELAY_MS;
    const responseTimeoutMs = Number.isFinite(options.responseTimeoutMs) && Number(options.responseTimeoutMs) > 0
      ? Number(options.responseTimeoutMs)
      : SEND_MODE_BROADCAST_RESPONSE_TIMEOUT_MS;
    const request = buildSendModeFrame(options.address, options.mode ?? SEND_MODE_BROADCAST_VALUE);
    // Modbus RTU broadcast address 0xFF is intentionally one-way in the field setup:
    // the detector starts continuous waveform streaming but does not return a write ACK.
    // Waiting for an ACK here caused a false MODE_SWITCHING loop even while valid waveform
    // frames were already arriving. Addressed writes may still request and validate an ACK.
    const waitForResponse = options.waitForResponse === true && request[0] !== SEND_MODE_BROADCAST_ADDRESS;
    let lastError: unknown = new Error('探测器 TCP 发送模式帧发送失败');

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let responseWaiter: BroadcastWriteResponseWaiter | undefined;
      try {
        const socket = getRawTcpSocket(this.client);
        if (!socket || typeof socket.write !== 'function') {
          throw new Error('探测器连接不支持原始 TCP 发送模式帧');
        }
        if (socket.destroyed || socket.writable === false) {
          throw new Error('探测器 TCP 连接不可写');
        }

        if (waitForResponse) responseWaiter = waitForBroadcastWriteResponse(socket, request, responseTimeoutMs);

        await new Promise<void>((resolve, reject) => {
          try {
            socket.write(request, (error?: Error | null) => {
              if (error) reject(error);
              else resolve();
            });
          } catch (error) {
            reject(error);
          }
        });
        if (responseWaiter) await responseWaiter.promise;
        return;
      } catch (error) {
        responseWaiter?.cancel();
        lastError = error;
        if (attempt < attempts && retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async readSoftwareVersion(): Promise<string> {
    const regs = await this.readRegisters(FLAME_DETECTOR_REGISTERS.SW_VERSION, 2);
    return `${(regs[0] ?? 0).toString(16).padStart(4, '0')}${(regs[1] ?? 0).toString(16).padStart(4, '0')}`;
  }

  async readRuntime(): Promise<number> {
    const regs = await this.readRegisters(FLAME_DETECTOR_REGISTERS.RUNTIME_HI, 2);
    return (((regs[0] ?? 0) & 0xFFFF) * 0x10000) + ((regs[1] ?? 0) & 0xFFFF);
  }

  async readSensitivity(): Promise<number> {
    return (await this.readRegisters(FLAME_DETECTOR_REGISTERS.SENSITIVITY, 1))[0] ?? 0;
  }

  async setSensitivity(value: number): Promise<void> {
    const max = this.isFourWavelength() ? 4 : 5;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`灵敏度必须在 1-${max} 之间`);
    await this.writeRegisters(FLAME_DETECTOR_REGISTERS.SENSITIVITY, [value]);
  }

  async readProbeCount(): Promise<number> {
    const count = (await this.readRegisters(FLAME_DETECTOR_REGISTERS.PROBE_COUNT, 1))[0] ?? 0;
    if (!this.protocolExplicit) this.profile = count >= 4 ? FLAME_PROTOCOLS.FOUR_WAVELENGTH : FLAME_PROTOCOLS.STANDARD;
    return count;
  }

  async readSendMode(): Promise<number> {
    return (await this.readRegisters(FLAME_DETECTOR_REGISTERS.SEND_MODE, 1))[0] ?? 0;
  }

  async setSendMode(mode: number): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 2) throw new Error('发送模式必须为0、1或2');
    // 四波长新固件只接收模式寄存器；现场三波长固件沿用旧版保留字，
    // 必须写入 [mode, 0x0008] 才会真正恢复 5A A5 推流。
    await this.writeRegisters(FLAME_DETECTOR_REGISTERS.SEND_MODE, this.isFourWavelength() ? [mode] : [mode, 0x0008]);
  }

  async readInspectionMode(): Promise<number> {
    return (await this.readRegisters(FLAME_DETECTOR_REGISTERS.INSPECTION_MODE, 1))[0] ?? 0;
  }

  async setInspectionMode(mode: number): Promise<void> {
    if (mode !== 0 && mode !== 1) throw new Error('送检模式必须为0或1');
    await this.writeRegisters(FLAME_DETECTOR_REGISTERS.INSPECTION_MODE, [mode]);
  }

  async readCommAddress(): Promise<number> {
    return (await this.readRegisters(FLAME_DETECTOR_REGISTERS.COMM_ADDRESS, 1))[0] ?? 0;
  }

  async setCommAddress(address: number): Promise<void> {
    if (!Number.isInteger(address) || address < 1 || address > 247) throw new Error('通信地址必须在1-247之间');
    await this.writeRegisters(FLAME_DETECTOR_REGISTERS.COMM_ADDRESS, [address]);
  }

  async readAlarmStatus(): Promise<FlameAlarmStatus> {
    const regs = await this.readRegisters(FLAME_DETECTOR_REGISTERS.FIRE_ALARM_STATUS, 2);
    const rawFire = regs[0] ?? 0xFFFF;
    const rawFault = regs[1] ?? 0;
    const signedFire = rawFire > 0x7FFF ? rawFire - 0x10000 : rawFire;
    return { fireAlarm: signedFire >= 0, fault: rawFault !== 0, rawFire, rawFault };
  }

  async readMirrorStatus(): Promise<FlameMirrorStatus> {
    const regs = await this.readRegisters(FLAME_DETECTOR_REGISTERS.MIRROR_BASE, 11);
    return {
      enabled: regs[0] === 1,
      interval: ((regs[1] ?? 0) << 16) | (regs[2] ?? 0),
      threshold: regs[3] ?? 0,
      intervalCount: ((regs[4] ?? 0) << 16) | (regs[5] ?? 0),
      power: regs[6] ?? 0,
      exceedCount: regs[7] ?? 0,
      started: regs[8] === 1,
      timing: regs[9] ?? 0,
      normal: regs[10] === 1,
    };
  }

  async readRealtimeFeatures(): Promise<DecodedFeatureBlock> {
    const regs = await this.readRegisters(FLAME_DETECTOR_REGISTERS.REALTIME_BASE, this.profile.realtimeRegisterQuantity);
    return decodeRealtime(regs, this.profile);
  }

  async readAlarmRecordSnapshot(options: { fullWaveform?: boolean; waveformMaxSamples?: number } = {}): Promise<DecodedFeatureBlock & { source: string; queriedAt: string }> {
    const headerQuantity = this.profile.alarmHeaderRegisters;
    const registers = await this.readRegisters(FLAME_DETECTOR_REGISTERS.ALARM_RECORD_BASE, headerQuantity);
    let sampleRegisters: number[] = [];
    if (options.fullWaveform) {
      const reportedCount = Math.min(Math.max(Number(registers[1]) || 0, 0), this.profile.alarmMaxFeatureGroups);
      sampleRegisters.push(...registers.slice(3 + reportedCount * this.profile.featureRegistersPerGroup));
      const remaining = this.profile.alarmTotalRegisters - headerQuantity;
      const pageSize = this.profile.alarmPageQuantity;
      for (let offset = 0; offset < remaining; offset += pageSize) {
        const quantity = Math.min(pageSize, remaining - offset);
        sampleRegisters.push(...await this.readRegisters(FLAME_DETECTOR_REGISTERS.ALARM_RECORD_BASE + headerQuantity + offset, quantity));
      }
    }
    const decoded = decodeFeatureBlock(registers, {
      sampleRegisters,
      includeInlineSamples: !options.fullWaveform,
      maxFeatureGroups: this.profile.alarmMaxFeatureGroups,
      sampleOrder: this.profile.sampleOrder,
    });
    return {
      ...decoded,
      samples: options.waveformMaxSamples ? limitSamples(decoded.samples, options.waveformMaxSamples) : decoded.samples,
      source: 'alarm-record',
      queriedAt: new Date().toISOString(),
    };
  }

  async readAllBasicParams(): Promise<FlameBasicParams> {
    // RS485 为半双工总线，严格顺序读取，不能并发 Promise.all。
    const sensitivity = await this.readSensitivity();
    const probeCount = await this.readProbeCount();
    const sendMode = await this.readSendMode();
    const commAddr = await this.readCommAddress();
    const version = await this.readSoftwareVersion();
    const runtime = await this.readRuntime();
    return { sensitivity, probeCount, sendMode, commAddr, protocol: this.profile, version, runtime };
  }

  async systemReset(): Promise<void> {
    await this.writeRegisters(FLAME_DETECTOR_REGISTERS.SYSTEM_RESET, [0x1234]);
  }

  normalizeSamples(samples: FlameSample[], baseline: Partial<FlameSample> = {}): { samples: FlameSample[]; baseline: FlameSample } {
    const keys: Array<keyof FlameSample> = this.isFourWavelength() ? ['probe1', 'probe2', 'probe3', 'probe4'] : ['probe1', 'probe2', 'probe3'];
    const nextBaseline = { ...baseline } as Partial<FlameSample>;
    for (const key of keys) {
      const values = samples.map((sample) => Number(sample[key]) || 0);
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const previous = Number(nextBaseline[key]);
      nextBaseline[key] = Number.isFinite(previous) ? previous + 0.02 * (average - previous) : average;
    }
    return {
      baseline: nextBaseline as FlameSample,
      samples: samples.map((sample) => {
        const normalized: Record<string, number> = {};
        for (const key of keys) normalized[key] = Math.round((Number(sample[key]) || 0) - (Number(nextBaseline[key]) || 0));
        return normalized as unknown as FlameSample;
      }),
    };
  }
}
