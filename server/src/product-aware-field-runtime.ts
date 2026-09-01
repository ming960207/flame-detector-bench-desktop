import { config } from './config.js';
import {
  createFieldStatusRuntime,
  normalizeFlameConfig,
  selectFieldPLCProcessObserver,
  type FieldStatusRuntime,
} from './closure/field-status-server.js';
import { FileFieldTestResultLogger } from './closure/field-test-result-log.js';
import { loadPLCConfigs, mergeWithDefaults } from './plc-config-store.js';
import { PLCProcessMonitor } from './plc-process-monitor.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
} from './product-profile.js';
import { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
import {
  DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  normalizeRelayFunctionalTestConfig,
  relayDioConfigReady,
  relayFunctionalTestMissingMappings,
} from './relay-functional-test.js';
import { DioModbusTcpInputSource, RelayFeedbackDioError } from './relay-feedback-dio.js';
import {
  DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
  normalizeProductionInspectionRecordConfig,
} from './production-inspection-record.js';
import { ProductionRunCoordinator } from './production-run-coordinator.js';
import { LabelPrintQueueStore } from './label-print-queue.js';
import { requireDesktopMutation } from './request-security.js';
import { createDefaultSystemConfig, loadSystemConfig, saveSystemConfig } from './system-config-store.js';

export interface ProductAwareFieldStatusRuntime extends FieldStatusRuntime {
  readonly productionRuns: ProductionRunCoordinator;
  readonly labelPrintQueue: LabelPrintQueueStore;
}

function safeDownloadName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'production-record';
}

function requestText(value: unknown, max = 128): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function startProductAwareFieldStatusServer(): Promise<ProductAwareFieldStatusRuntime> {
  const savedPLCs = await loadPLCConfigs();
  const mergedPLCs = mergeWithDefaults(savedPLCs.length > 0 ? savedPLCs : config.plcs);
  config.plcs = [selectFieldPLCProcessObserver(mergedPLCs)];

  const systemConfig = await loadSystemConfig();
  const savedFlameConfig = systemConfig?.flameConfig
    ? { ...config.flame, ...systemConfig.flameConfig }
    : config.flame;
  config.flame = normalizeFlameConfig(savedFlameConfig, config.flame);

  const productConfig = normalizeProductDetectionConfig(
    systemConfig?.productDetectionConfig,
    DEFAULT_PRODUCT_DETECTION_CONFIG,
  );
  let relayConfig = normalizeRelayFunctionalTestConfig(
    systemConfig?.relayFunctionalTestConfig,
    DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  );
  let inspectionRecordConfig = normalizeProductionInspectionRecordConfig(
    systemConfig?.productionInspectionRecordConfig,
    DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
  );

  const source = new PLCProcessMonitor(config.plcs[0]!);
  const relayFeedback = new DioModbusTcpInputSource(relayConfig.dio);
  const detectors = new ProductAwareFlameDetectorService(config.flame);
  detectors.setRelayFunctionalTestConfig(relayConfig);
  detectors.setRelayFeedbackSource(relayFeedback);

  const runtime = createFieldStatusRuntime(
    source,
    detectors,
    new FileFieldTestResultLogger(),
    productConfig,
  );
  const closeRuntime = runtime.close.bind(runtime);

  const productionRuns = new ProductionRunCoordinator(() => runtime.snapshot(), detectors);
  const labelPrintQueue = new LabelPrintQueueStore();
  productionRuns.setRecordConfig(inspectionRecordConfig);
  source.on('status', (status) => productionRuns.observeStatus(status));
  productionRuns.on('archive', (archive) => {
    void labelPrintQueue.enqueueProductionRecord(archive.inspectionRecord, archive.summary.detectorVerdict)
      .then((jobs) => {
        if (jobs.length > 0) {
          console.log(`[标签打印] 批次 ${archive.batchId} 已生成 ${jobs.length} 个标签任务（D1→D6）。`);
        }
      })
      .catch((error) => {
        console.error('[标签打印] 生成批次标签任务失败:', error instanceof Error ? error.message : String(error));
      });
  });

  const productionConfigPayload = () => {
    const indexes = detectors.enabledDetectorIndexes();
    const missingMappings = relayFunctionalTestMissingMappings(relayConfig, indexes);
    return {
      relay: {
        config: relayConfig,
        missingMappings,
        ready: relayConfig.enabled && relayDioConfigReady(relayConfig.dio) && missingMappings.length === 0,
      },
      dioReady: relayDioConfigReady(relayConfig.dio),
      mappingReady: missingMappings.length === 0,
      recordConfig: inspectionRecordConfig,
      labelPrinting: {
        template: 'FLAME_DETECTOR_60X40_HORIZONTAL',
        productName: '点型红外火焰探测器',
        qrMode: 'PRODUCT_CODE',
        copiesPerProduct: 1,
        passBehavior: 'PRODUCT_LABEL',
        failBehavior: 'NG_ISOLATION_LABEL',
      },
    };
  };

  runtime.app.get('/api/production-config', (_req, res) => {
    res.json(productionConfigPayload());
  });

  runtime.app.put('/api/production-config', requireDesktopMutation, async (req, res) => {
    if (runtime.snapshot().summary.productSelectionLocked) {
      return res.status(409).json({ code: 'PRODUCTION_CONFIG_LOCKED_DURING_PROCESS' });
    }
    try {
      const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const nextRelay = normalizeRelayFunctionalTestConfig(input.relayConfig, relayConfig);
      const nextRecord = normalizeProductionInspectionRecordConfig(input.recordConfig, inspectionRecordConfig);
      const store = await loadSystemConfig() ?? createDefaultSystemConfig();
      await saveSystemConfig({
        ...store,
        relayFunctionalTestConfig: nextRelay,
        productionInspectionRecordConfig: nextRecord,
        lastUpdated: Date.now(),
      });
      relayConfig = nextRelay;
      inspectionRecordConfig = nextRecord;
      detectors.setRelayFunctionalTestConfig(nextRelay);
      await relayFeedback.updateConfig(nextRelay.dio);
      productionRuns.setRecordConfig(nextRecord);
      return res.json({ success: true, ...productionConfigPayload() });
    } catch (error) {
      return res.status(500).json({ code: 'PRODUCTION_CONFIG_UPDATE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });

  runtime.app.post('/api/production-config/dio/test', requireDesktopMutation, async (req, res) => {
    if (runtime.snapshot().summary.productSelectionLocked) {
      return res.status(409).json({ code: 'PRODUCTION_CONFIG_LOCKED_DURING_PROCESS' });
    }
    const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const candidate = normalizeRelayFunctionalTestConfig({ dio: input.dio }, relayConfig).dio;
    const probe = new DioModbusTcpInputSource(candidate);
    try {
      const result = await probe.testConnection();
      return res.json({ success: true, ...result });
    } catch (error) {
      const code = error instanceof RelayFeedbackDioError ? error.code : 'DIO_CONNECTION_FAILED';
      return res.status(code === 'DIO_NOT_CONFIGURED' ? 400 : 503).json({
        success: false,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await probe.disconnect();
    }
  });

  const recordStore = productionRuns.getStore();
  runtime.app.get('/api/production-records', async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      return res.json({ records: await recordStore.list(limit) });
    } catch (error) {
      return res.status(500).json({ code: 'PRODUCTION_RECORD_LIST_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.get('/api/production-records/latest', async (_req, res) => {
    try {
      const record = await recordStore.loadLatest();
      return record ? res.json(record) : res.status(404).json({ code: 'PRODUCTION_RECORD_NOT_FOUND' });
    } catch (error) {
      return res.status(500).json({ code: 'PRODUCTION_RECORD_READ_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.get('/api/production-records/:batchId/html', async (req, res) => {
    try {
      const html = await recordStore.loadHtml(req.params.batchId);
      if (!html) return res.status(404).send('PRODUCTION_RECORD_NOT_FOUND');
      return res.type('html').send(html);
    } catch (error) {
      return res.status(500).json({ code: 'PRODUCTION_RECORD_HTML_READ_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.get('/api/production-records/:batchId/doc', async (req, res) => {
    try {
      const [html, record] = await Promise.all([
        recordStore.loadHtml(req.params.batchId),
        recordStore.load(req.params.batchId),
      ]);
      if (!html || !record) return res.status(404).send('PRODUCTION_RECORD_NOT_FOUND');
      const filename = `${safeDownloadName(record.productModel)}_${safeDownloadName(record.batchId)}_生产检验记录.doc`;
      res.setHeader('Content-Type', 'application/msword; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return res.send(html);
    } catch (error) {
      return res.status(500).json({ code: 'PRODUCTION_RECORD_DOC_READ_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.get('/api/production-records/:batchId', async (req, res) => {
    try {
      const record = await recordStore.load(req.params.batchId);
      return record ? res.json(record) : res.status(404).json({ code: 'PRODUCTION_RECORD_NOT_FOUND' });
    } catch (error) {
      return res.status(500).json({ code: 'PRODUCTION_RECORD_READ_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });

  runtime.app.get('/api/label-print/jobs', async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 60;
      return res.json(await labelPrintQueue.list(limit));
    } catch (error) {
      return res.status(500).json({ code: 'LABEL_PRINT_QUEUE_READ_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.post('/api/label-print/claim', requireDesktopMutation, async (req, res) => {
    try {
      const workerId = requestText((req.body as Record<string, unknown> | undefined)?.workerId, 96);
      if (!workerId) return res.status(400).json({ code: 'LABEL_PRINT_WORKER_REQUIRED' });
      const job = await labelPrintQueue.claimNext(workerId);
      return res.json({ job });
    } catch (error) {
      return res.status(500).json({ code: 'LABEL_PRINT_CLAIM_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.post('/api/label-print/jobs/:id/printed', requireDesktopMutation, async (req, res) => {
    try {
      const workerId = requestText((req.body as Record<string, unknown> | undefined)?.workerId, 96);
      if (!workerId) return res.status(400).json({ code: 'LABEL_PRINT_WORKER_REQUIRED' });
      const job = await labelPrintQueue.markPrinted(req.params.id, workerId);
      return job ? res.json({ success: true, job }) : res.status(404).json({ code: 'LABEL_PRINT_JOB_NOT_FOUND' });
    } catch (error) {
      return res.status(500).json({ code: 'LABEL_PRINT_COMPLETE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.post('/api/label-print/jobs/:id/failed', requireDesktopMutation, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const workerId = requestText(body.workerId, 96);
      if (!workerId) return res.status(400).json({ code: 'LABEL_PRINT_WORKER_REQUIRED' });
      const job = await labelPrintQueue.markFailed(req.params.id, workerId, requestText(body.error, 500) || 'PRINT_FAILED');
      return job ? res.json({ success: true, job }) : res.status(404).json({ code: 'LABEL_PRINT_JOB_NOT_FOUND' });
    } catch (error) {
      return res.status(500).json({ code: 'LABEL_PRINT_FAIL_UPDATE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });
  runtime.app.post('/api/label-print/jobs/:id/retry', requireDesktopMutation, async (req, res) => {
    try {
      const job = await labelPrintQueue.retry(req.params.id);
      return job ? res.json({ success: true, job }) : res.status(404).json({ code: 'LABEL_PRINT_JOB_NOT_FOUND' });
    } catch (error) {
      return res.status(500).json({ code: 'LABEL_PRINT_RETRY_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Product-code routes are views over the one formal allocation source owned by ProductAwareFlameDetectorService.
  runtime.app.get('/api/product-code/current', (_req, res) => {
    const summary = runtime.snapshot().summary;
    return res.json({
      batchId: summary.waveformAnalysis.batchId,
      allocation: summary.productPrecheck?.productCodeAllocation ?? null,
      busy: summary.productPrecheckBusy,
      timestamp: Date.now(),
    });
  });
  runtime.app.get('/api/product-code/batch/:batchId', (req, res) => {
    const context = detectors.getBatchContext(req.params.batchId);
    if (!context?.productCodeAllocation) return res.status(404).json({ code: 'PRODUCT_CODE_ALLOCATION_NOT_FOUND' });
    return res.json({ allocation: context.productCodeAllocation });
  });
  runtime.app.get('/api/product-batches/:batchId/context', (req, res) => {
    const context = detectors.getBatchContext(req.params.batchId);
    return context ? res.json(context) : res.status(404).json({ code: 'PRODUCT_BATCH_CONTEXT_NOT_FOUND' });
  });

  const port = await runtime.listen();
  console.log(`[现场状态] 已启动完整产品检测运行时：http://127.0.0.1:${port}`);
  return Object.assign(runtime, {
    productionRuns,
    labelPrintQueue,
    async close(): Promise<void> {
      await relayFeedback.disconnect();
      await closeRuntime();
    },
  });
}
