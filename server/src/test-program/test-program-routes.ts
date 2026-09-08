import type { Express } from 'express';
import { requireDesktopMutation } from '../request-security.js';
import { TestProgramArchiveStore } from './test-program-archive.js';
import { TestProgramObserver, type TestProgramObserverOptions } from './test-program-observer.js';

export type TestProgramBroadcast = (type: 'test_snapshot' | 'test_source_error', payload: unknown) => void;

export interface EmbeddedTestProgramOptions extends TestProgramObserverOptions {
  observer?: TestProgramObserver;
  broadcast?: TestProgramBroadcast;
}

export interface EmbeddedTestProgramRuntime {
  readonly observer: TestProgramObserver;
  readonly archiveStore: TestProgramArchiveStore;
  start(): void;
  close(): Promise<void>;
}

/**
 * Mount the test observer on the existing field Express application.
 * It never creates another HTTP/WebSocket server and never opens PLC/Modbus connections.
 */
export function mountTestProgramRoutes(app: Express, options: EmbeddedTestProgramOptions = {}): EmbeddedTestProgramRuntime {
  const archiveStore = options.observer?.archiveStore ?? options.archiveStore ?? new TestProgramArchiveStore();
  const observer = options.observer ?? new TestProgramObserver({ ...options, archiveStore });
  const broadcast = options.broadcast ?? (() => undefined);

  const onSnapshot = (snapshot: unknown) => broadcast('test_snapshot', snapshot);
  const onArchive = () => broadcast('test_snapshot', observer.snapshot());
  const onSourceError = (error: unknown) => broadcast('test_source_error', { error });

  observer.on('snapshot', onSnapshot);
  observer.on('archive', onArchive);
  observer.on('source_error', onSourceError);

  app.get('/api/test-program/health', (_req, res) => {
    const diagnostics = observer.diagnostics();
    const configuration = observer.configuration();
    res.json({
      status: diagnostics.started && diagnostics.sourceConnected && !diagnostics.stale ? 'ok' : 'degraded',
      mode: 'embedded-readonly-observer',
      source: observer.snapshot().source,
      runtime: configuration.runtime,
      diagnostics,
      timestamp: Date.now(),
    });
  });
  app.get('/api/test-program/snapshot', (_req, res) => res.json(observer.snapshot()));
  app.get('/api/test-program/config', (_req, res) => res.json(observer.configuration()));
  app.put('/api/test-program/config', requireDesktopMutation, (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      let payload = observer.configuration();
      if (Object.prototype.hasOwnProperty.call(body, 'runtime')) payload = observer.updateRuntimeConfig(body.runtime);
      if (Object.prototype.hasOwnProperty.call(body, 'plan')) payload = observer.updatePlan(body.plan);
      res.json(payload);
    } catch (error) {
      res.status(400).json({
        code: 'TEST_PROGRAM_CONFIG_INVALID',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get('/api/test-program/archives', (req, res) => {
    const requested = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.floor(requested))) : 50;
    res.json({ items: archiveStore.list(limit) });
  });
  app.get('/api/test-program/archives/:runId', (req, res) => {
    const archive = archiveStore.get(req.params.runId);
    if (!archive) return res.status(404).json({ code: 'TEST_PROGRAM_ARCHIVE_NOT_FOUND' });
    return res.json(archive);
  });
  app.get('/api/test-program/archives/:runId/report', (req, res) => {
    const report = archiveStore.report(req.params.runId);
    if (report === null) return res.status(404).json({ code: 'TEST_PROGRAM_REPORT_NOT_FOUND' });
    return res.type(archiveStore.reportContentType(req.params.runId) === 'html' ? 'html' : 'text/markdown').send(report);
  });
  app.all('/api/test-program/*', (_req, res) => res.status(405).json({ code: 'TEST_PROGRAM_EQUIPMENT_WRITE_DISABLED' }));

  let started = false;
  return {
    observer,
    archiveStore,
    start(): void {
      if (started) return;
      started = true;
      observer.start();
    },
    async close(): Promise<void> {
      if (!started) return;
      started = false;
      observer.removeListener('snapshot', onSnapshot);
      observer.removeListener('archive', onArchive);
      observer.removeListener('source_error', onSourceError);
      await observer.stop();
    },
  };
}
