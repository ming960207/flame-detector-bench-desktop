import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';
import { config } from '../config.js';
import { WSMessageType } from '../types.js';
import { WSServer } from '../websocket/ws-server.js';
import { FileOfflineAuditStore, type OfflineAuditStore } from './offline-audit-store.js';
import { OfflineClosureService } from './offline-closure-service.js';
import {
  type ClosureAuditEvent,
  type Clock,
  type ClosureCommand,
  type ClosureCommandResult,
  type ClosureCommandSource,
  type ClosureState,
} from './types.js';

export interface OfflineRuntime {
  readonly closure: OfflineClosureService;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export interface OfflineRuntimeOptions {
  now?: Clock;
  auditStore?: OfflineAuditStore;
}

const COMMAND_TYPES = new Set<ClosureCommand['type']>(['START', 'STOP', 'RESET', 'SUBMIT_BATCH']);
const COMMAND_SOURCES = new Set<ClosureCommandSource>(['UI', 'API', 'TEST']);

class OfflineAuditWriteError extends Error {}

export function createOfflineRuntime(options: OfflineRuntimeOptions = {}): OfflineRuntime {
  const app = express();
  app.use(cors({ origin: ['null', 'file://', 'http://127.0.0.1:3000', 'http://localhost:3000'] }));
  app.use(express.json({ limit: '50kb' }));

  const server = createServer(app);
  const wsServer = new WSServer();
  wsServer.init(server);
  const closure = new OfflineClosureService({ now: options.now });
  const auditStore = options.auditStore ?? new FileOfflineAuditStore();
  const now = options.now ?? Date.now;
  let operations: Promise<void> = Promise.resolve();

  const serialise = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };

  const publishState = (state: ClosureState): ClosureState => {
    wsServer.broadcastClosureState(state);
    return state;
  };
  const publishResult = (result: ClosureCommandResult): ClosureCommandResult => {
    wsServer.broadcastClosureCommandResult(result);
    publishState(result.state);
    return result;
  };
  const record = (event: ClosureAuditEvent): Promise<void> => auditStore.append(event);
  const recordCommand = (result: ClosureCommandResult): Promise<void> => record({
    schemaVersion: 1,
    eventType: 'command',
    occurredAt: now(),
    batchId: result.state.activeBatchId ?? result.command.batchId,
    state: closure.getState(),
    command: result.command,
    commandResult: result,
  });
  const recordSimulationInput = (state: ClosureState, input: ClosureAuditEvent['simulationInput']): Promise<void> => record({
    schemaVersion: 1,
    eventType: 'simulation_input',
    occurredAt: now(),
    batchId: state.activeBatchId,
    state,
    simulationInput: input,
  });
  const submitAndRecord = (command: ClosureCommand): Promise<ClosureCommandResult> => serialise(async () => {
    const checkpoint = closure.createCheckpoint();
    const result = closure.submit(command);
    try {
      await recordCommand(result);
    } catch {
      closure.restoreCheckpoint(checkpoint);
      throw new OfflineAuditWriteError();
    }
    return publishResult(result);
  });
  const simulateAndRecord = (
    input: ClosureAuditEvent['simulationInput'],
    transition: () => ClosureState,
  ): Promise<ClosureState> => serialise(async () => {
    const checkpoint = closure.createCheckpoint();
    const state = transition();
    try {
      await recordSimulationInput(state, input);
    } catch {
      closure.restoreCheckpoint(checkpoint);
      throw new OfflineAuditWriteError();
    }
    return publishState(state);
  });
  const getRecordedState = (): Promise<ClosureState> => serialise(() => closure.getState());

  wsServer.on('client_connected', () => {
    void serialise(() => wsServer.broadcastClosureState(closure.getState()));
  });
  wsServer.on('closure_command', async (payload: unknown) => {
    const command = parseClosureCommand(payload);
    if (!command) {
      wsServer.broadcast({
        type: WSMessageType.ERROR,
        payload: { code: 'INVALID_CLOSURE_COMMAND' },
        timestamp: Date.now(),
      });
      return;
    }
    try {
      await submitAndRecord(command);
    } catch (error) {
      wsServer.broadcast({
        type: WSMessageType.ERROR,
        payload: { code: error instanceof OfflineAuditWriteError ? 'OFFLINE_AUDIT_WRITE_FAILED' : 'OFFLINE_CLOSURE_COMMAND_FAILED' },
        timestamp: now(),
      });
    }
  });
  for (const event of ['set_do', 'set_do_multi', 'set_all_do', 'set_only_one_do', 'disconnect_all_do']) {
    wsServer.on(event, () => {
      wsServer.broadcast({
        type: WSMessageType.ERROR,
        payload: { code: 'OFFLINE_DIRECT_IO_DISABLED' },
        timestamp: Date.now(),
      });
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'offline', timestamp: Date.now(), externalConnections: 'disabled' });
  });
  app.get('/api/status', (_req, res) => {
    res.json({ mode: 'offline', wsClients: wsServer.getClientCount(), externalConnections: 'disabled' });
  });
  app.get('/api/closure/state', async (_req, res) => res.json(await getRecordedState()));
  app.get('/api/closure/audit', async (req, res) => {
    const limit = parseAuditLimit(req.query.limit);
    if (limit === undefined) return res.status(400).json({ code: 'INVALID_AUDIT_LIMIT' });
    const batchId = parseAuditBatchId(req.query.batchId);
    if (batchId === undefined && req.query.batchId !== undefined) return res.status(400).json({ code: 'INVALID_AUDIT_BATCH_ID' });
    try {
      await serialise(() => undefined);
      const events = batchId ? await auditStore.listByBatchId(batchId, limit) : await auditStore.list(limit);
      res.json({ integrity: 'verified', events });
    } catch {
      res.status(500).json({ code: 'OFFLINE_AUDIT_READ_FAILED' });
    }
  });
  app.post('/api/closure/commands', async (req, res) => {
    const command = parseClosureCommand(req.body);
    if (!command) return res.status(400).json({ code: 'INVALID_CLOSURE_COMMAND' });
    try {
      res.json(await submitAndRecord(command));
    } catch {
      res.status(500).json({ code: 'OFFLINE_AUDIT_WRITE_FAILED' });
    }
  });
  app.post('/api/closure/test/advance-stage', async (_req, res) => {
    try {
      const state = await simulateAndRecord({ type: 'ADVANCE_STAGE' }, () => closure.advanceStage());
      res.json(state);
    } catch (error) {
      if (error instanceof OfflineAuditWriteError) return res.status(500).json({ code: 'OFFLINE_AUDIT_WRITE_FAILED' });
      return res.status(409).json({ code: error instanceof Error ? error.message : 'STAGE_ADVANCE_REJECTED' });
    }
  });
  app.post('/api/closure/test/safety', async (req, res) => {
    if (typeof req.body?.safetyReady !== 'boolean') {
      return res.status(400).json({ code: 'INVALID_SAFETY_STATE' });
    }
    try {
      const state = await simulateAndRecord({ type: 'SAFETY', safetyReady: req.body.safetyReady }, () => closure.setSafetyReady(req.body.safetyReady));
      res.json(state);
    } catch {
      res.status(500).json({ code: 'OFFLINE_AUDIT_WRITE_FAILED' });
    }
  });
  const rejectDirectIo = (_req: express.Request, res: express.Response) => {
    res.status(409).json({ code: 'OFFLINE_DIRECT_IO_DISABLED' });
  };
  app.all(['/api/do', '/api/do/*', '/api/relays/:relayId/do/:channel'], rejectDirectIo);
  app.post('/api/external/upload/report', (_req, res) => {
    res.status(409).json({ code: 'OFFLINE_EXTERNAL_REPORT_DISABLED' });
  });
  app.post('/api/mqtt/status', (_req, res) => {
    res.status(409).json({ code: 'OFFLINE_EXTERNAL_PUBLISH_DISABLED' });
  });

  return {
    closure,
    listen: (port = config.serverPort) => listen(server, port),
    close: () => close(server, wsServer),
  };
}

function parseAuditLimit(value: unknown): number | undefined {
  if (value === undefined) return 100;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) return undefined;
  return Math.min(limit, 1_000);
}

function parseAuditBatchId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return undefined;
  return value;
}

export async function startOfflineServer(): Promise<OfflineRuntime> {
  const runtime = createOfflineRuntime();
  const port = await runtime.listen();
  console.log('[离线闭环] 已启动本机服务；PLC、探测器、MQTT 与外部报告连接均未初始化。');
  console.log(`[离线闭环] HTTP/WS: http://127.0.0.1:${port}`);
  return runtime;
}

function parseClosureCommand(value: unknown): ClosureCommand | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ClosureCommand>;
  if (
    typeof candidate.requestId !== 'string' || candidate.requestId.length === 0 ||
    typeof candidate.sequence !== 'number' || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1 ||
    !COMMAND_TYPES.has(candidate.type as ClosureCommand['type']) ||
    !COMMAND_SOURCES.has(candidate.source as ClosureCommandSource) ||
    typeof candidate.issuedAt !== 'number' || !Number.isFinite(candidate.issuedAt) ||
    (candidate.batchId !== undefined && (typeof candidate.batchId !== 'string' || candidate.batchId.length === 0 || candidate.batchId.length > 200)) ||
    (candidate.type === 'SUBMIT_BATCH' && !Array.isArray(candidate.snapshots)) ||
    (candidate.type !== 'SUBMIT_BATCH' && candidate.snapshots !== undefined)
  ) return undefined;

  return candidate as ClosureCommand;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server, wsServer: WSServer): Promise<void> {
  wsServer.close();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
