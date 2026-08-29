/**
 * PLC一体机 Modbus 控制器（S7-200 SMART）
 *
 * Modbus地址映射：
 *   DI (I0.0~I2.1): FC02 Discrete Inputs, 地址 0~17，共18点
 *   DO 读 (Q0.0~Q1.3): FC01 Coils, 地址 0~11，共12点
 *   DO 写单点: FC05, 地址 0~11
 *   DO 写多点: FC15, 起始地址 0，数量 12
 *
 * 支持 TCP（以太网）和 RTU（RS485串口）两种连接方式
 */

import ModbusRTU from 'modbus-serial';
import { EventEmitter } from 'events';
import { PLCDeviceConfigLocal } from '../config.js';
import { IOState } from '../types.js';

export class PLCController extends EventEmitter {
  private client: ModbusRTU;
  private config: PLCDeviceConfigLocal;
  private connected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastError: string = '';
  private reconnectAttempts: number = 0;

  private readonly diCount: number;
  private readonly doCount: number;

  private diState: boolean[] = [];
  private doState: boolean[] = [];

  constructor(config: PLCDeviceConfigLocal) {
    super();
    this.config = config;
    this.diCount = config.diCount || 18;
    this.doCount = config.doCount || 12;
    this.diState = new Array(this.diCount).fill(false);
    this.doState = new Array(this.doCount).fill(false);
    this.client = new ModbusRTU();
  }

  async connect(): Promise<void> {
    try {
      // 必须在 connect 之前设置请求超时
      this.client.setTimeout(5000);

      if (this.config.mode === 'RTU' && this.config.serialPath) {
        console.log(`[PLCController:${this.config.id}] RTU 连接: ${this.config.serialPath} @${this.config.baudRate}`);
        await this.client.connectRTUBuffered(this.config.serialPath, {
          baudRate: this.config.baudRate || 9600,
          dataBits: (this.config.dataBits as 5|6|7|8) || 8,
          stopBits: (this.config.stopBits as 1|2) || 1,
          parity: (this.config.parity as 'none'|'even'|'odd') || 'none',
        });
      } else {
        // TCP 连接：必须传 timeout 参数，否则 Windows 下可能等待 20s+ 才超时
        console.log(`[PLCController:${this.config.id}] TCP 连接: ${this.config.ip}:${this.config.port} slaveId=${this.config.slaveId}`);
        await this.client.connectTCP(this.config.ip, {
          port: this.config.port,
          timeout: 5000,   // ← 5 秒 TCP 连接超时（参考实现标准）
        });
      }

      this.client.setID(this.config.slaveId);
      this.connected = true;
      this.lastError = '';
      this.reconnectAttempts = 0;
      const addr = this.config.mode === 'RTU' && this.config.serialPath
        ? this.config.serialPath
        : `${this.config.ip}:${this.config.port}`;
      console.log(`[PLCController:${this.config.id}] 连接成功 (${addr}) slaveId=${this.config.slaveId} DI=${this.diCount} DO=${this.doCount}`);
      this.emit('connected');
      this.startPolling();
    } catch (err: any) {
      this.connected = false;
      this.lastError = err.message || '连接失败';
      const errCode = err.code ? ` [${err.code}]` : '';
      console.error(`[PLCController:${this.config.id}] 连接失败${errCode}: ${this.lastError}`);
      if (err.code === 'ECONNREFUSED') {
        console.error(`  → 端口 ${this.config.port} 被拒绝。请确认 PLC Modbus TCP 已启用，或检查端口号。`);
      } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        console.error(`  → 连接超时。请确认 IP ${this.config.ip} 可达且 PLC 已上电运行。`);
      } else if (err.code === 'ENETUNREACH' || err.code === 'EHOSTUNREACH') {
        console.error(`  → 网络不可达。请检查网络配置和 IP 地址。`);
      }
      this.emit('error', this.lastError);
      this.scheduleReconnect();
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (this.client.isOpen) await this.client.close(() => {});
    } catch {}
    this.connected = false;
    this.emit('disconnected');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // 指数退避: 3s → 6s → 12s → 24s → 30s (max)
    this.reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`[PLCController:${this.config.id}] ${delay / 1000}s 后尝试重连 (第${this.reconnectAttempts}次)...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected) this.connect();
    }, delay);
  }

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs || 200;
    this.pollTimer = setInterval(() => this.poll(), interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.connected) return;
    try {
      // 读 DI: FC02 Discrete Inputs, addr 0, count diCount (I0.0~I2.1)
      const diResult = await this.client.readDiscreteInputs(0, this.diCount);
      this.diState = diResult.data.slice(0, this.diCount).map(Boolean);

      // 读 DO: FC01 Coils, addr 0, count doCount (Q0.0~Q1.3)
      const doResult = await this.client.readCoils(0, this.doCount);
      this.doState = doResult.data.slice(0, this.doCount).map(Boolean);

      // 连续成功时清除上次错误
      if (this.lastError) {
        this.lastError = '';
        console.log(`[PLCController:${this.config.id}] 轮询恢复正常`);
      }

      const state: IOState = {
        relayId: this.config.id,
        di: [...this.diState],
        do: [...this.doState],
        timestamp: Date.now(),
      };
      this.emit('data', state);
    } catch (err: any) {
      const msg = err.message || '轮询失败';
      if (msg !== this.lastError) {
        this.lastError = msg;
        // 输出详细的 Modbus 错误诊断
        if (err.modbusCode !== undefined) {
          const codeMap: Record<number, string> = {
            1: '非法功能码 (FC02/FC01 不受支持)',
            2: '非法数据地址 (地址超出范围)',
            3: '非法数据值',
            4: '设备故障',
          };
          console.error(`[PLCController:${this.config.id}] Modbus 异常 #${err.modbusCode}: ${codeMap[err.modbusCode] || msg}`);
        } else {
          console.error(`[PLCController:${this.config.id}] 轮询错误 [${err.code || '?'}]: ${msg}`);
        }
      }
      this.connected = false;
      this.stopPolling();
      this.emit('error', msg);
      this.emit('disconnected');
      this.scheduleReconnect();
    }
  }

  async writeDO(channel: number, value: boolean): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    const addr = channel - 1;
    if (addr < 0 || addr >= this.doCount) throw new Error(`DO通道 ${channel} 超出范围 (1-${this.doCount})`);
    await this.client.writeCoil(addr, value);
    this.doState[addr] = value;
  }

  async writeDOMulti(channels: { channel: number; value: boolean }[]): Promise<void> {
    for (const ch of channels) {
      await this.writeDO(ch.channel, ch.value);
    }
  }

  async writeAllDO(values: boolean[]): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    const coils = new Array(this.doCount).fill(false);
    values.slice(0, this.doCount).forEach((v, i) => { coils[i] = v; });
    await this.client.writeCoils(0, coils);
    this.doState = [...coils];
  }

  async setOnlyOneDO(channel: number): Promise<void> {
    const coils = new Array(this.doCount).fill(false);
    const idx = channel - 1;
    if (idx >= 0 && idx < this.doCount) coils[idx] = true;
    await this.writeAllDO(coils);
  }

  async disconnectAllDO(): Promise<void> {
    await this.writeAllDO(new Array(this.doCount).fill(false));
  }

  getCurrentState(): IOState {
    return {
      relayId: this.config.id,
      di: [...this.diState],
      do: [...this.doState],
      timestamp: Date.now(),
    };
  }

  isConnected(): boolean { return this.connected; }
  getLastError(): string { return this.lastError; }
  getConfig(): PLCDeviceConfigLocal { return this.config; }
  getId(): string { return this.config.id; }

  getStatus() {
    return {
      id: this.config.id,
      name: this.config.name,
      connected: this.connected,
      mode: this.config.mode,
      ip: this.config.ip,
      port: this.config.port,
      serialPath: this.config.serialPath,
      lastError: this.lastError || undefined,
    };
  }
}
