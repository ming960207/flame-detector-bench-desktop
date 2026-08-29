import express, { type Express } from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { TestProgramArchiveStore } from './test-program-archive.js';
import { TestProgramObserver, type TestProgramObserverOptions } from './test-program-observer.js';

export interface TestProgramRuntimeOptions extends TestProgramObserverOptions {
  port?: number;
  observer?: TestProgramObserver;
}

export interface TestProgramRuntime {
  readonly app: Express;
  readonly observer: TestProgramObserver;
  readonly archiveStore: TestProgramArchiveStore;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null' || origin === 'file://') return true;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin);
}

export function createTestProgramRuntime(options: TestProgramRuntimeOptions = {}): TestProgramRuntime {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(cors({ origin: (origin, callback) => callback(null, allowedOrigin(origin) ? origin ?? true : false) }));

  const archiveStore = options.observer?.archiveStore ?? options.archiveStore ?? new TestProgramArchiveStore();
  const observer = options.observer ?? new TestProgramObserver({ ...options, archiveStore });
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();
  let started = false;

  const broadcast = (message: unknown) => {
    const data = JSON.stringify({ type: 'test_snapshot', payload: message, timestamp: Date.now() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };
  observer.on('snapshot', (snapshot) => broadcast(snapshot));
  observer.on('archive', (archive) => broadcast(observer.snapshot()));
  observer.on('source_error', (error) => {
    const data = JSON.stringify({ type: 'test_source_error', payload: { error }, timestamp: Date.now() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  });

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'test_snapshot', payload: observer.snapshot(), timestamp: Date.now() }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    // This server is intentionally observation-only for equipment. Incoming
    // messages are ignored; no PLC or detector control route exists here.
    socket.on('message', () => undefined);
  });

  app.get('/api/test-program/health', (_req, res) => res.json({
    status: 'ok',
    mode: 'test-program-readonly-observer',
    source: observer.snapshot().source,
    archiveDirectory: archiveStore.directory,
    timestamp: Date.now(),
  }));
  app.get('/api/test-program/snapshot', (_req, res) => res.json(observer.snapshot()));
  app.get('/api/test-program/config', (_req, res) => res.json({
    ...observer.configuration(),
  }));
  app.put('/api/test-program/config', (req, res) => {
    try {
      res.json(observer.updatePlan(req.body?.plan));
    } catch (error) {
      res.status(400).json({
        code: 'TEST_PROGRAM_PLAN_INVALID',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get('/api/test-program/archives', (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ items: archiveStore.list(limit) });
  });
  app.get('/api/test-program/archives/:runId', (req, res) => {
    const archive = archiveStore.get(req.params.runId);
    if (!archive) return res.status(404).json({ code: 'TEST_PROGRAM_ARCHIVE_NOT_FOUND' });
    res.json(archive);
  });
  app.get('/api/test-program/archives/:runId/report', (req, res) => {
    const report = archiveStore.report(req.params.runId);
    if (report === null) return res.status(404).json({ code: 'TEST_PROGRAM_REPORT_NOT_FOUND' });
    res.type('text/markdown').send(report);
  });
  app.all('/api/test-program/*', (_req, res) => res.status(405).json({ code: 'TEST_PROGRAM_READONLY' }));

  return {
    app,
    observer,
    archiveStore,
    async listen(port = options.port ?? Number(process.env.TEST_PROGRAM_PORT || 3004)): Promise<number> {
      if (started) {
        const address = server.address();
        return typeof address === 'object' && address ? address.port : port;
      }
      const actualPort = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
      started = true;
      observer.start();
      return actualPort;
    },
    async close(): Promise<void> {
      await observer.stop();
      for (const client of clients) {
        try { client.close(); } catch { /* already closed */ }
      }
      clients.clear();
      await new Promise<void>((resolve) => {
        if (!wss) return resolve();
        wss.close(() => resolve());
      });
      if (!started) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      started = false;
    },
  };
}

export async function startTestProgramServer(): Promise<TestProgramRuntime> {
  const runtime = createTestProgramRuntime();
  const port = await runtime.listen();
  console.log(`[测试观察器] 已启动只读测试程序：http://127.0.0.1:${port}`);
  console.log(`[测试观察器] 正式状态源：${runtime.observer.formalBackendUrl}`);
  return runtime;
}
