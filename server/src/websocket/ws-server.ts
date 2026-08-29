/**
 * WebSocket 服务器
 * 实现实时数据推送和双向通信
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { EventEmitter } from 'events';
import {
  WSMessage,
  WSMessageType,
  IOState,
  ConnectionStatus,
  SetDORequest,
  SetDOMultiRequest,
  type FlameDetectorState,
  type FlameDetectorUnitState,
  type FlameDetectorWaveformDelta,
  type FlameDetectorWaveformDeltaUnit,
} from '../types.js';
import { type PLCProcessStatus } from '../process-status.js';
import { type ClosureCommandResult, type ClosureState } from '../closure/types.js';

const MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;
const REALTIME_UI_PUBLISH_INTERVAL_MS = 200;

function historySampleTotal(unit: FlameDetectorUnitState): number | null {
  const total = Number(unit.historySampleTotal);
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : null;
}

function createFlameWaveformDelta(
  state: FlameDetectorState,
  previousTotals: ReadonlyMap<number, number>,
): FlameDetectorWaveformDelta | null {
  if (!state || !Array.isArray(state.units)) return null;

  const units: FlameDetectorWaveformDeltaUnit[] = [];
  for (const unit of state.units) {
    if (!unit || typeof unit !== 'object') return null;

    const currentTotal = historySampleTotal(unit);
    const previousTotal = previousTotals.get(unit.index);
    const historySamples = Array.isArray(unit.historySamples) ? unit.historySamples : [];
    const rawHistorySamples = Array.isArray(unit.rawHistorySamples) ? unit.rawHistorySamples : [];
    if (currentTotal === null || previousTotal === undefined) return null;

    const historyReset = currentTotal < previousTotal;
    const deltaCount = historyReset ? currentTotal : currentTotal - previousTotal;
    // If a producer skipped more samples than the retained history can expose,
    // fall back to one full snapshot so the browser never silently loses data.
    if (deltaCount > historySamples.length || deltaCount > rawHistorySamples.length) return null;

    const {
      historySamples: _historySamples,
      rawHistorySamples: _rawHistorySamples,
      ...metadata
    } = unit;
    units.push({
      ...metadata,
      historyReset,
      historyDelta: deltaCount > 0 ? historySamples.slice(-deltaCount) : [],
      rawHistoryDelta: deltaCount > 0 ? rawHistorySamples.slice(-deltaCount) : [],
    });
  }

  return {
    units,
    onlineCount: state.onlineCount,
    fireCount: state.fireCount,
    faultCount: state.faultCount,
    timestamp: state.timestamp,
  };
}

export class WSServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private flameHistoryTotals = new Map<number, number>();
  private hasFlameHistoryBaseline = false;
  private latestFlameState: FlameDetectorState | null = null;
  private flameClientsNeedingResync = new Set<WebSocket>();
  private pendingFlameState: FlameDetectorState | null = null;
  private flamePublishTimer: NodeJS.Timeout | null = null;
  private lastFlamePublishedAt = 0;
  private pendingFieldSummary: unknown;
  private fieldSummaryPublishTimer: NodeJS.Timeout | null = null;
  private lastFieldSummaryPublishedAt = 0;

  /**
   * 初始化 WebSocket 服务器
   */
  init(server: Server): void {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[WS] 新客户端连接');
      this.clients.add(ws);

      // 发送欢迎消息
      this.sendToClient(ws, {
        type: WSMessageType.CONNECTION_STATUS,
        payload: { message: '连接成功' },
        timestamp: Date.now()
      });

      // 处理客户端消息
      ws.on('message', (data: Buffer) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          console.error('[WS] 解析消息失败:', error);
          this.sendError(ws, '消息格式错误');
        }
      });

      // 处理断开连接
      ws.on('close', () => {
        console.log('[WS] 客户端断开连接');
        this.clients.delete(ws);
        this.flameClientsNeedingResync.delete(ws);
      });

      // 处理错误
      ws.on('error', (error: Error) => {
        console.error('[WS] 客户端错误:', error);
        this.clients.delete(ws);
        this.flameClientsNeedingResync.delete(ws);
      });

      // 通知有新客户端连接
      this.emit('client_connected', ws);
    });

    console.log('[WS] WebSocket 服务器已启动');
  }

  /**
   * 处理客户端消息
   */
  private handleClientMessage(ws: WebSocket, message: WSMessage): void {
    console.log(`[WS] 收到消息: ${message.type}`);

    switch (message.type) {
      case WSMessageType.SET_DO:
        this.emit('set_do', message.payload as SetDORequest);
        break;

      case WSMessageType.SET_DO_MULTI:
        this.emit('set_do_multi', message.payload as SetDOMultiRequest);
        break;

      case WSMessageType.SET_ALL_DO:
        // payload: { values: boolean[] } - 8个布尔值
        this.emit('set_all_do', message.payload);
        break;

      case WSMessageType.SET_ONLY_ONE_DO:
        // payload: { channel: number } - 通道号 1-8
        this.emit('set_only_one_do', message.payload);
        break;

      case WSMessageType.DISCONNECT_ALL_DO:
        this.emit('disconnect_all_do', message.payload);
        break;

      case WSMessageType.UPDATE_CONFIG:
        this.emit('update_config', message.payload);
        break;

      case WSMessageType.CLOSURE_COMMAND:
        this.emit('closure_command', message.payload);
        break;

      default:
        console.warn(`[WS] 未知消息类型: ${message.type}`);
    }
  }

  /**
   * 发送消息到单个客户端
   */
  private sendToClient(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * 广播消息到所有客户端
   */
  broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * 广播 IO 状态
   */
  broadcastIOState(state: IOState): void {
    this.broadcast({
      type: WSMessageType.IO_STATE,
      payload: state,
      timestamp: Date.now()
    });
  }

  private rememberFlameHistoryTotals(state: FlameDetectorState): void {
    this.flameHistoryTotals.clear();
    if (!state || !Array.isArray(state.units)) {
      this.hasFlameHistoryBaseline = false;
      return;
    }

    for (const unit of state.units) {
      const total = historySampleTotal(unit);
      if (total === null) {
        this.hasFlameHistoryBaseline = false;
        return;
      }
      this.flameHistoryTotals.set(unit.index, total);
    }
    this.hasFlameHistoryBaseline = this.flameHistoryTotals.size === state.units.length;
  }

  private sendFlameSnapshot(ws: WebSocket, state: FlameDetectorState, timestamp = Date.now()): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      this.flameClientsNeedingResync.add(ws);
      return;
    }
    this.sendToClient(ws, {
      type: WSMessageType.FLAME_STATE,
      payload: state,
      timestamp,
    });
    this.flameClientsNeedingResync.delete(ws);
  }

  private broadcastFlameSnapshot(state: FlameDetectorState, timestamp: number): void {
    const data = JSON.stringify({
      type: WSMessageType.FLAME_STATE,
      payload: state,
      timestamp,
    });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        this.flameClientsNeedingResync.add(client);
        continue;
      }
      client.send(data);
      this.flameClientsNeedingResync.delete(client);
    }
  }

  private broadcastFlameWaveformDelta(delta: FlameDetectorWaveformDelta): void {
    const data = JSON.stringify({
      type: WSMessageType.FLAME_WAVEFORM_DELTA,
      payload: delta,
      timestamp: delta.timestamp,
    });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      if (this.flameClientsNeedingResync.has(client)) {
        if (this.latestFlameState && client.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES) {
          this.sendFlameSnapshot(client, this.latestFlameState, delta.timestamp);
        }
        continue;
      }
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        this.flameClientsNeedingResync.add(client);
        continue;
      }
      client.send(data);
    }
  }

  private publishFlameState(state: FlameDetectorState): void {
    this.lastFlamePublishedAt = Date.now();
    const timestamp = this.lastFlamePublishedAt;

    if (!this.hasFlameHistoryBaseline) {
      this.rememberFlameHistoryTotals(state);
      this.broadcastFlameSnapshot(state, timestamp);
      return;
    }

    const delta = createFlameWaveformDelta(state, this.flameHistoryTotals);
    this.rememberFlameHistoryTotals(state);
    if (!delta) {
      this.broadcastFlameSnapshot(state, timestamp);
      return;
    }
    this.broadcastFlameWaveformDelta(delta);
  }

  private flushPendingFlameState(): void {
    this.flamePublishTimer = null;
    const state = this.pendingFlameState;
    this.pendingFlameState = null;
    if (state) this.publishFlameState(state);
  }

  /**
   * 向单个客户端发送完整火焰状态。用于首次连接或断线重连，保留服务端完整历史窗口。
   */
  sendFlameState(ws: WebSocket, state: FlameDetectorState): void {
    this.latestFlameState = state;
    // A reconnecting client must not move the global cursor forward for
    // already-connected clients that may still be receiving the same stream.
    if (!this.hasFlameHistoryBaseline) this.rememberFlameHistoryTotals(state);
    this.sendFlameSnapshot(ws, state);
  }

  /**
   * 广播火焰探测器状态。首次同步发送完整历史，后续仅发送新增采样点。
   */
  broadcastFlameState(state: FlameDetectorState): void {
    this.latestFlameState = state;
    this.pendingFlameState = state;
    const elapsed = Date.now() - this.lastFlamePublishedAt;
    if (!this.flamePublishTimer && elapsed >= REALTIME_UI_PUBLISH_INTERVAL_MS) {
      this.flushPendingFlameState();
      return;
    }
    if (this.flamePublishTimer) return;
    this.flamePublishTimer = setTimeout(
      () => this.flushPendingFlameState(),
      Math.max(0, REALTIME_UI_PUBLISH_INTERVAL_MS - elapsed),
    );
  }

  private publishFieldSummary(payload: unknown): void {
    this.lastFieldSummaryPublishedAt = Date.now();
    this.broadcast({
      type: WSMessageType.FIELD_SUMMARY,
      payload,
      timestamp: this.lastFieldSummaryPublishedAt,
    });
  }

  private flushPendingFieldSummary(): void {
    this.fieldSummaryPublishTimer = null;
    const payload = this.pendingFieldSummary;
    this.pendingFieldSummary = undefined;
    if (payload !== undefined) this.publishFieldSummary(payload);
  }

  /** 合并高频分析状态，避免 WebView 主线程消息与 React 渲染积压。 */
  broadcastFieldSummary(payload: unknown): void {
    this.pendingFieldSummary = payload;
    const elapsed = Date.now() - this.lastFieldSummaryPublishedAt;
    if (!this.fieldSummaryPublishTimer && elapsed >= REALTIME_UI_PUBLISH_INTERVAL_MS) {
      this.flushPendingFieldSummary();
      return;
    }
    if (this.fieldSummaryPublishTimer) return;
    this.fieldSummaryPublishTimer = setTimeout(
      () => this.flushPendingFieldSummary(),
      Math.max(0, REALTIME_UI_PUBLISH_INTERVAL_MS - elapsed),
    );
  }

  broadcastClosureState(state: ClosureState): void {
    this.broadcast({
      type: WSMessageType.CLOSURE_STATE,
      payload: state,
      timestamp: Date.now(),
    });
  }

  broadcastClosureCommandResult(result: ClosureCommandResult): void {
    this.broadcast({
      type: WSMessageType.CLOSURE_COMMAND_RESULT,
      payload: result,
      timestamp: Date.now(),
    });
  }

  broadcastPLCProcessStatus(status: PLCProcessStatus): void {
    this.broadcast({
      type: WSMessageType.PLC_PROCESS_STATUS,
      payload: status,
      timestamp: status.timestamp,
    });
  }

  /**
   * 广播连接状态
   */
  broadcastConnectionStatus(status: ConnectionStatus): void {
    this.broadcast({
      type: WSMessageType.CONNECTION_STATUS,
      payload: status,
      timestamp: Date.now()
    });
  }

  /**
   * 发送错误消息
   */
  sendError(ws: WebSocket, error: string): void {
    this.sendToClient(ws, {
      type: WSMessageType.ERROR,
      payload: { error },
      timestamp: Date.now()
    });
  }

  /**
   * 广播错误消息
   */
  broadcastError(error: string): void {
    this.broadcast({
      type: WSMessageType.ERROR,
      payload: { error },
      timestamp: Date.now()
    });
  }

  /**
   * 获取连接的客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 关闭服务器
   */
  close(): void {
    if (this.flamePublishTimer) clearTimeout(this.flamePublishTimer);
    if (this.fieldSummaryPublishTimer) clearTimeout(this.fieldSummaryPublishTimer);
    this.flamePublishTimer = null;
    this.fieldSummaryPublishTimer = null;
    this.pendingFlameState = null;
    this.pendingFieldSummary = undefined;
    this.lastFlamePublishedAt = 0;
    this.lastFieldSummaryPublishedAt = 0;
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.flameClientsNeedingResync.clear();
    this.flameHistoryTotals.clear();
    this.hasFlameHistoryBaseline = false;
    this.latestFlameState = null;

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    console.log('[WS] WebSocket 服务器已关闭');
  }
}

export default WSServer;
