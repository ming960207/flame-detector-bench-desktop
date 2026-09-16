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
const MAX_INCOMING_MESSAGE_BYTES = 1024 * 1024;
const REALTIME_UI_PUBLISH_INTERVAL_MS = 200;
const WAVEFORM_DIAGNOSTIC_INTERVAL_MS = 1000;
const CLIENT_MESSAGE_TYPES = new Set<WSMessageType>([
  WSMessageType.SET_DO,
  WSMessageType.SET_DO_MULTI,
  WSMessageType.SET_ALL_DO,
  WSMessageType.SET_ONLY_ONE_DO,
  WSMessageType.DISCONNECT_ALL_DO,
  WSMessageType.UPDATE_CONFIG,
  WSMessageType.CLOSURE_COMMAND,
]);
const FIELD_PUSH_ONLY_MESSAGES = new Set<WSMessageType>();

export interface WSServerOptions {
  /** Undefined preserves legacy behavior except field mode, which is push-only by default. */
  allowedClientMessageTypes?: ReadonlySet<WSMessageType>;
  rejectedClientMessageCode?: string;
}

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
  private lastFlameDiagnosticAt = 0;
  private pendingFieldSummary: unknown;
  private fieldSummaryPublishTimer: NodeJS.Timeout | null = null;
  private lastFieldSummaryPublishedAt = 0;
  private readonly allowedClientMessageTypes?: ReadonlySet<WSMessageType>;
  private readonly rejectedClientMessageCode: string;

  constructor(options: WSServerOptions = {}) {
    super();
    const fieldDefault = process.env.CLOSURE_MODE === 'field' ? FIELD_PUSH_ONLY_MESSAGES : undefined;
    this.allowedClientMessageTypes = options.allowedClientMessageTypes ?? fieldDefault;
    this.rejectedClientMessageCode = options.rejectedClientMessageCode
      ?? (process.env.CLOSURE_MODE === 'field' ? 'FIELD_STATUS_READONLY' : 'WS_CLIENT_COMMAND_DISABLED');
  }

  init(server: Server): void {
    if (this.wss) throw new Error('WS_SERVER_ALREADY_INITIALIZED');
    this.wss = new WebSocketServer({ server, maxPayload: MAX_INCOMING_MESSAGE_BYTES });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[WS] 新客户端连接');
      this.clients.add(ws);

      this.sendToClient(ws, {
        type: WSMessageType.CONNECTION_STATUS,
        payload: { message: '连接成功' },
        timestamp: Date.now(),
      });

      ws.on('message', (data: Buffer) => {
        try {
          const raw = JSON.parse(data.toString()) as unknown;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            this.sendErrorCode(ws, 'WS_MESSAGE_INVALID');
            return;
          }
          const message = raw as Partial<WSMessage>;
          if (typeof message.type !== 'string' || !CLIENT_MESSAGE_TYPES.has(message.type as WSMessageType)) {
            this.sendErrorCode(ws, 'WS_MESSAGE_TYPE_INVALID');
            return;
          }
          this.handleClientMessage(ws, message as WSMessage);
        } catch (error) {
          console.error('[WS] 解析消息失败:', error);
          this.sendErrorCode(ws, 'WS_MESSAGE_INVALID_JSON');
        }
      });

      ws.on('close', () => {
        console.log('[WS] 客户端断开连接');
        this.clients.delete(ws);
        this.flameClientsNeedingResync.delete(ws);
      });

      ws.on('error', (error: Error) => {
        console.error('[WS] 客户端错误:', error);
        this.clients.delete(ws);
        this.flameClientsNeedingResync.delete(ws);
      });

      this.emit('client_connected', ws);
    });

    console.log('[WS] WebSocket 服务器已启动');
  }

  private handleClientMessage(ws: WebSocket, message: WSMessage): void {
    if (this.allowedClientMessageTypes && !this.allowedClientMessageTypes.has(message.type)) {
      console.warn(`[WS] 已拒绝客户端命令: ${message.type}`);
      this.sendErrorCode(ws, this.rejectedClientMessageCode, message.type);
      return;
    }

    console.log(`[WS] 收到消息: ${message.type}`);
    switch (message.type) {
      case WSMessageType.SET_DO:
        this.emit('set_do', message.payload as SetDORequest);
        break;
      case WSMessageType.SET_DO_MULTI:
        this.emit('set_do_multi', message.payload as SetDOMultiRequest);
        break;
      case WSMessageType.SET_ALL_DO:
        this.emit('set_all_do', message.payload);
        break;
      case WSMessageType.SET_ONLY_ONE_DO:
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
        this.sendErrorCode(ws, 'WS_MESSAGE_TYPE_INVALID');
    }
  }

  private sendToClient(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private sendErrorCode(ws: WebSocket, code: string, rejectedType?: unknown): void {
    this.sendToClient(ws, {
      type: WSMessageType.ERROR,
      payload: { code, ...(rejectedType === undefined ? {} : { rejectedType }) },
      timestamp: Date.now(),
    });
  }

  broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES) client.send(data);
    }
  }

  broadcastIOState(state: IOState): void {
    this.broadcast({ type: WSMessageType.IO_STATE, payload: state, timestamp: Date.now() });
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

  private logFlameDiagnostic(state: FlameDetectorState, delta: FlameDetectorWaveformDelta | null, mode: 'snapshot' | 'delta'): void {
    const now = Date.now();
    if (now - this.lastFlameDiagnosticAt < WAVEFORM_DIAGNOSTIC_INTERVAL_MS) return;
    this.lastFlameDiagnosticAt = now;
    const deltaByIndex = new Map((delta?.units ?? []).map((unit) => [unit.index, unit]));
    let maxBuffered = 0;
    for (const client of this.clients) maxBuffered = Math.max(maxBuffered, Number(client.bufferedAmount) || 0);
    const units = state.units.map((unit) => {
      const deltaUnit = deltaByIndex.get(unit.index);
      const lastAge = unit.lastUpdate > 0 ? Math.max(0, now - unit.lastUpdate) : -1;
      const startup = unit.startup;
      const firstFrameAge = startup?.firstFrameAt ? Math.max(0, now - startup.firstFrameAt) : -1;
      const readyAge = startup?.testReadyAt ? Math.max(0, now - startup.testReadyAt) : -1;
      return `D${unit.index}{on=${unit.online ? 1 : 0},ready=${unit.sourceReady ? 1 : 0},sync=${unit.syncOk ? 1 : 0},startup=${startup?.state ?? '-'},attempts=${startup?.modeSwitchAttempts ?? 0},streak=${startup?.channelValidStreak ?? 0},firstAgeMs=${firstFrameAge},readyAgeMs=${readyAge},total=${historySampleTotal(unit) ?? '-'},delta=${deltaUnit ? deltaUnit.historyDelta.length : '-'},hist=${unit.historySamples?.length ?? 0},lastAgeMs=${lastAge},reset=${deltaUnit?.historyReset ? 1 : 0}}`;
    }).join(' ');
    console.log(`[WaveformDiag][WS] mode=${mode} clients=${this.clients.size} resync=${this.flameClientsNeedingResync.size} maxBuffered=${maxBuffered} stateAgeMs=${Math.max(0, now - state.timestamp)} ${units}`);
  }

  private sendFlameSnapshot(ws: WebSocket, state: FlameDetectorState, timestamp = Date.now()): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      this.flameClientsNeedingResync.add(ws);
      return;
    }
    this.sendToClient(ws, { type: WSMessageType.FLAME_STATE, payload: state, timestamp });
    this.flameClientsNeedingResync.delete(ws);
  }

  private broadcastFlameSnapshot(state: FlameDetectorState, timestamp: number): void {
    const data = JSON.stringify({ type: WSMessageType.FLAME_STATE, payload: state, timestamp });
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
    const data = JSON.stringify({ type: WSMessageType.FLAME_WAVEFORM_DELTA, payload: delta, timestamp: delta.timestamp });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (this.flameClientsNeedingResync.has(client)) {
        if (this.latestFlameState && client.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES) this.sendFlameSnapshot(client, this.latestFlameState, delta.timestamp);
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
      this.logFlameDiagnostic(state, null, 'snapshot');
      this.broadcastFlameSnapshot(state, timestamp);
      return;
    }
    const delta = createFlameWaveformDelta(state, this.flameHistoryTotals);
    this.rememberFlameHistoryTotals(state);
    if (!delta) {
      this.logFlameDiagnostic(state, null, 'snapshot');
      this.broadcastFlameSnapshot(state, timestamp);
      return;
    }
    this.logFlameDiagnostic(state, delta, 'delta');
    this.broadcastFlameWaveformDelta(delta);
  }

  private flushPendingFlameState(): void {
    this.flamePublishTimer = null;
    const state = this.pendingFlameState;
    this.pendingFlameState = null;
    if (state) this.publishFlameState(state);
  }

  sendFlameState(ws: WebSocket, state: FlameDetectorState): void {
    this.latestFlameState = state;
    if (!this.hasFlameHistoryBaseline) this.rememberFlameHistoryTotals(state);
    this.sendFlameSnapshot(ws, state);
  }

  broadcastFlameState(state: FlameDetectorState): void {
    this.latestFlameState = state;
    this.pendingFlameState = state;
    const elapsed = Date.now() - this.lastFlamePublishedAt;
    if (!this.flamePublishTimer && elapsed >= REALTIME_UI_PUBLISH_INTERVAL_MS) {
      this.flushPendingFlameState();
      return;
    }
    if (this.flamePublishTimer) return;
    this.flamePublishTimer = setTimeout(() => this.flushPendingFlameState(), Math.max(0, REALTIME_UI_PUBLISH_INTERVAL_MS - elapsed));
  }

  private publishFieldSummary(payload: unknown): void {
    this.lastFieldSummaryPublishedAt = Date.now();
    this.broadcast({ type: WSMessageType.FIELD_SUMMARY, payload, timestamp: this.lastFieldSummaryPublishedAt });
  }

  private flushPendingFieldSummary(): void {
    this.fieldSummaryPublishTimer = null;
    const payload = this.pendingFieldSummary;
    this.pendingFieldSummary = undefined;
    if (payload !== undefined) this.publishFieldSummary(payload);
  }

  broadcastFieldSummary(payload: unknown): void {
    this.pendingFieldSummary = payload;
    const elapsed = Date.now() - this.lastFieldSummaryPublishedAt;
    if (!this.fieldSummaryPublishTimer && elapsed >= REALTIME_UI_PUBLISH_INTERVAL_MS) {
      this.flushPendingFieldSummary();
      return;
    }
    if (this.fieldSummaryPublishTimer) return;
    this.fieldSummaryPublishTimer = setTimeout(() => this.flushPendingFieldSummary(), Math.max(0, REALTIME_UI_PUBLISH_INTERVAL_MS - elapsed));
  }

  broadcastClosureState(state: ClosureState): void {
    this.broadcast({ type: WSMessageType.CLOSURE_STATE, payload: state, timestamp: Date.now() });
  }

  broadcastClosureCommandResult(result: ClosureCommandResult): void {
    this.broadcast({ type: WSMessageType.CLOSURE_COMMAND_RESULT, payload: result, timestamp: Date.now() });
  }

  broadcastPLCProcessStatus(status: PLCProcessStatus): void {
    this.broadcast({ type: WSMessageType.PLC_PROCESS_STATUS, payload: status, timestamp: status.timestamp });
  }

  broadcastConnectionStatus(status: ConnectionStatus): void {
    this.broadcast({ type: WSMessageType.CONNECTION_STATUS, payload: status, timestamp: Date.now() });
  }

  sendError(ws: WebSocket, error: string): void {
    this.sendToClient(ws, { type: WSMessageType.ERROR, payload: { error }, timestamp: Date.now() });
  }

  broadcastError(error: string): void {
    this.broadcast({ type: WSMessageType.ERROR, payload: { error }, timestamp: Date.now() });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.flamePublishTimer) clearTimeout(this.flamePublishTimer);
    if (this.fieldSummaryPublishTimer) clearTimeout(this.fieldSummaryPublishTimer);
    this.flamePublishTimer = null;
    this.fieldSummaryPublishTimer = null;
    this.pendingFlameState = null;
    this.pendingFieldSummary = undefined;
    this.lastFlamePublishedAt = 0;
    this.lastFlameDiagnosticAt = 0;
    this.lastFieldSummaryPublishedAt = 0;
    for (const client of this.clients) client.close();
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
