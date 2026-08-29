/**
 * S7 协议 PLC 控制器（S7-200 SMART 兼容）
 *
 * 通信方式：S7/ISO-on-TCP，端口 102
 * 地址映射（nodes7 位寻址格式）：
 *   DI (I0.0~I2.1) → E0.0~E2.1  共 18 点
 *   DO (Q0.0~Q1.3) → A0.0~A1.3  共 12 点
 *
 * 库：nodes7（纯 JavaScript，无需 native 编译，兼容 Node.js 22）
 */

import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { PLCDeviceConfigLocal } from '../config.js';
import { IOState } from '../types.js';

const _require = createRequire(import.meta.url);
const NodeS7 = _require('nodes7');

// S7-200 SMART 固定连接参数
const RACK = 0;
const SLOT = 1;

/** 生成 DI 位地址列表：E0.0, E0.1, ..., E2.1 */
function diTags(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `E${Math.floor(i / 8)}.${i % 8}`);
}

/** 生成 DO 位地址列表：A0.0, A0.1, ..., A1.3 */
function doTags(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `A${Math.floor(i / 8)}.${i % 8}`);
}

// ── Controller ─────────────────────────────────────────────────────────────────

export class PLCController extends EventEmitter {
  private conn: any;
  private config: PLCDeviceConfigLocal;
  private connected        = false;
  private reconnectTimer:  NodeJS.Timeout | null = null;
  private pollTimer:       NodeJS.Timeout | null = null;
  private lastError        = '';
  private reconnectAttempts = 0;
  private polling          = false;

  private readonly diCount: number;
  private readonly doCount: number;
  private readonly diTagList: string[];
  private readonly doTagList: string[];
  private readonly writeTagList: string[];

  private diState: boolean[] = [];
  private doState: boolean[] = [];

  constructor(config: PLCDeviceConfigLocal) {
    super();
    this.config     = config;
    this.diCount    = config.diCount || 18;
    this.doCount    = config.doCount || 12;
    this.diTagList  = diTags(this.diCount);  // ['E0.0','E0.1',…,'E2.1']
    this.doTagList  = doTags(this.doCount);  // ['A0.0','A0.1',…,'A1.3']
    this.writeTagList = Array.from({ length: this.doCount }, (_, i) => {
      const idx = i;
      if (idx >= 0 && idx < 8) return `M30.${idx}`;
      if (idx >= 8 && idx < this.doCount) return `M29.${idx - 8}`;
      return `A${Math.floor(idx / 8)}.${idx % 8}`;
    });
    this.diState    = new Array(this.diCount).fill(false);
    this.doState    = new Array(this.doCount).fill(false);
    this.conn       = new NodeS7({ silent: true });
  }

  // ── 连接管理 ─────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      console.log(`[S7:${this.config.id}] 连接 ${this.config.ip}:${this.config.port} rack=${RACK} slot=${SLOT}`);
      this.conn.initiateConnection(
        { host: this.config.ip, port: this.config.port, rack: RACK, slot: SLOT, timeout: 5000 },
        (err: any) => {
          if (err) {
            this.connected = false;
            this.lastError = err.message || String(err) || '连接失败';
            console.error(`[S7:${this.config.id}] 连接失败: ${this.lastError}`);
            this.emit('error', this.lastError);
            this.scheduleReconnect();
          } else {
            this.connected = true;
            this.lastError = '';
            this.reconnectAttempts = 0;
            console.log(`[S7:${this.config.id}] 连接成功 DI=${this.diCount} DO=${this.doCount}`);
            // 注册所有需要轮询和写入的标签
            this.conn.addItems([...this.diTagList, ...this.doTagList, ...this.writeTagList]);
            this.emit('connected');
            this.startPolling();
          }
          resolve();
        }
      );
    });
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.conn.dropConnection(); } catch {}
    this.connected = false;
    this.emit('disconnected');
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await new Promise(r => setTimeout(r, 500));
    this.reconnectAttempts = 0;
    this.conn = new NodeS7({ silent: true });
    await this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`[S7:${this.config.id}] ${delay / 1000}s 后重连 (第${this.reconnectAttempts}次)...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected) {
        this.conn = new NodeS7({ silent: true });
        this.connect();
      }
    }, delay);
  }

  // ── 轮询 ─────────────────────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs || 200;
    this.pollTimer = setInterval(() => this.poll(), interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private poll(): void {
    if (!this.connected || this.polling) return;
    this.polling = true;

    this.conn.readAllItems((err: any, vals: Record<string, any>) => {
      this.polling = false;

      if (err) {
        const msg = err.message || String(err) || '轮询失败';
        if (msg !== this.lastError) {
          this.lastError = msg;
          console.error(`[S7:${this.config.id}] 轮询错误: ${msg}`);
        }
        this.connected = false;
        this.stopPolling();
        this.emit('error', msg);
        this.emit('disconnected');
        this.scheduleReconnect();
        return;
      }

      // 从结果字典提取 DI / DO 位值
      this.diState = this.diTagList.map(tag => Boolean(vals[tag]));
      this.doState = this.doTagList.map(tag => Boolean(vals[tag]));

      if (this.lastError) {
        this.lastError = '';
        console.log(`[S7:${this.config.id}] 轮询恢复正常`);
      }

      this.emit('data', {
        relayId:   this.config.id,
        di:        [...this.diState],
        do:        [...this.doState],
        timestamp: Date.now(),
      } as IOState);
    });
  }

  // ── DO 写操作 ─────────────────────────────────────────────────────────────────

  private toWriteTag(channel: number): string {
    const idx = channel - 1;
    if (idx >= 0 && idx < 8) {
      return `M30.${idx}`;
    }
    if (idx >= 8 && idx < this.doCount) {
      return `M29.${idx - 8}`;
    }
    return this.doTagList[idx];
  }

  /** 写单个 DO 位，channel 1-based (1=Q0.0 … 12=Q1.3) */
  async writeDO(channel: number, value: boolean): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    const idx = channel - 1;
    if (idx < 0 || idx >= this.doCount) throw new Error(`DO通道 ${channel} 超出范围 (1-${this.doCount})`);
    const tag = this.toWriteTag(channel);
    console.log(`[S7:${this.config.id}] writeDO ch=${channel} tag=${tag} val=${value}`);
    await this._writeTag(tag, value);
    this.doState[idx] = value;
  }

  async writeDOMulti(channels: { channel: number; value: boolean }[]): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    for (const { channel, value } of channels) {
      await this.writeDO(channel, value);
    }
  }

  /**
   * 写所有 DO - 逐 bit 顺序写，避免 nodes7 批量写同字节时
   * read-modify-write 乱序导致错位激活的问题
   */
  async writeAllDO(values: boolean[]): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    const count = Math.min(values.length, this.doCount);
    for (let i = 0; i < count; i++) {
      const val = Boolean(values[i]);
      if (this.doState[i] !== val) {
        const tag = this.toWriteTag(i + 1);
        await this._writeTag(tag, val);
        this.doState[i] = val;
      }
    }
  }

  async setOnlyOneDO(channel: number): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    const target = channel - 1;
    const targetTag = this.toWriteTag(channel);
    console.log(`[S7:${this.config.id}] setOnlyOneDO ch=${channel} tag=${targetTag}`);
    // 逐 bit 写：先关闭所有非目标通道，再开启目标通道，顺序写避免竞争
    for (let i = 0; i < this.doCount; i++) {
      const val = (i === target);
      if (this.doState[i] !== val) {
        const tag = this.toWriteTag(i + 1);
        await this._writeTag(tag, val);
        this.doState[i] = val;
      }
    }
  }

  async disconnectAllDO(): Promise<void> {
    if (!this.connected) throw new Error('PLC未连接');
    for (let i = 0; i < this.doCount; i++) {
      if (this.doState[i]) {
        const tag = this.toWriteTag(i + 1);
        await this._writeTag(tag, false);
        this.doState[i] = false;
      }
    }
  }

  // ── nodes7 写辅助 ─────────────────────────────────────────────────────────────

  private _writeTag(tag: string, value: any): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.writeItems(tag, value, (err: any) => {
        if (err) reject(new Error(`写 ${tag} 失败: ${err.message || err}`));
        else     resolve();
      });
    });
  }

  private _writeTags(tags: string[], values: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.writeItems(tags, values, (err: any) => {
        if (err) reject(new Error(`批量写入失败: ${err.message || err}`));
        else     resolve();
      });
    });
  }

  // ── 状态查询 ─────────────────────────────────────────────────────────────────

  getCurrentState(): IOState {
    return {
      relayId:   this.config.id,
      di:        [...this.diState],
      do:        [...this.doState],
      timestamp: Date.now(),
    };
  }

  isConnected():  boolean              { return this.connected; }
  getLastError(): string               { return this.lastError; }
  getConfig():    PLCDeviceConfigLocal { return this.config; }
  getId():        string               { return this.config.id; }

  getStatus(): import('../types.js').PLCDeviceStatus {
    return {
      id:        this.config.id,
      name:      this.config.name,
      connected: this.connected,
      mode:      'S7' as const,
      ip:        this.config.ip,
      port:      this.config.port,
      lastError: this.lastError || undefined,
    };
  }

  updateConfig(cfg: Partial<PLCDeviceConfigLocal>): void {
    this.config = { ...this.config, ...cfg };
  }
}
