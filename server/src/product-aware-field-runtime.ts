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
import type { PLCSignalDefinition } from './plc-program-contract.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
} from './product-profile.js';
import { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
import {
  DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  normalizeRelayFunctionalTestConfig,
  relayFunctionalTestMissingMappings,
  type RelayFunctionalTestConfig,
} from './relay-functional-test.js';
import {
  DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
  normalizeProductionInspectionRecordConfig,
} from './production-inspection-record.js';
import { ProductionRunCoordinator } from './production-run-coordinator.js';
import { requireDesktopMutation } from './request-security.js';
import { createDefaultSystemConfig, loadSystemConfig, saveSystemConfig } from './system-config-store.js';

export interface ProductAwareFieldStatusRuntime extends FieldStatusRuntime {
  readonly productionRuns: ProductionRunCoordinator;
}

function relayInputDefinitions(relayConfig: RelayFunctionalTestConfig): PLCSignalDefinition[] {
  const definitions: PLCSignalDefinition[] = [];
  for (const mapping of relayConfig.mappings) {
    if (mapping.alarmInputAddress) {
      definitions.push({
        key: mapping.alarmInputKey,
        address: mapping.alarmInputAddress,
        label: `探测器${mapping.detectorIndex}火警继电器反馈`,
      });
    }
    if (mapping.faultInputAddress) {
      definitions.push({
        key: mapping.faultInputKey,
        address: mapping.faultInputAddress,
        label: `探测器${mapping.detectorIndex}故障继电器反馈`,
      });
    }
  }
  return definitions;
}

function safeDownloadName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'production-record';
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

  const source = new PLCProcessMonitor(config.plcs[0]!, relayInputDefinitions(relayConfig));
  const detectors = new ProductAwareFlameDetectorService(config.flame);
  detectors.setRelayFunctionalTestConfig(relayConfig);
  detectors.setRelayFeedbackSource({ readInputs: () => source.getCurrent()?.io?.inputs });

  const runtime = createFieldStatusRuntime(
    source,
    detectors,
    new FileFieldTestResultLogger(),
    productConfig,
  );

  const productionRuns = new ProductionRunCoordinator(() => runtime.snapshot(), detectors);
  productionRuns.setRecordConfig(inspectionRecordConfig);
  source.on('status', (status) => productionRuns.observeStatus(status));

  runtime.app.get('/api/relay-functional-test-config', (_req, res) => {
    const indexes = detectors.enabledDetectorIndexes();
    const missingMappings = relayFunctionalTestMissingMappings(relayConfig, indexes);
    res.json({
      config: relayConfig,
      missingMappings,
      ready: relayConfig.enabled && missingMappings.length === 0,
    });
  });

  runtime.app.put('/api/relay-functional-test-config', requireDesktopMutation, async (req, res) => {
    if (runtime.snapshot().summary.productSelectionLocked) {
      return res.status(409).json({ code: 'RELAY_CONFIG_LOCKED_DURING_PROCESS' });
    }
    try {
      const next = normalizeRelayFunctionalTestConfig(req.body, relayConfig);
      relayConfig = next;
      detectors.setRelayFunctionalTestConfig(next);
      source.updateExtraInputs(relayInputDefinitions(next));
      const store = await loadSystemConfig() ?? createDefaultSystemConfig();
      await saveSystemConfig({ ...store, relayFunctionalTestConfig: next, lastUpdated: Date.now() });
      const indexes = detectors.enabledDetectorIndexes();
      const missingMappings = relayFunctionalTestMissingMappings(next, indexes);
      return res.json({
        success: true,
        config: next,
        missingMappings,
        ready: next.enabled && missingMappings.length === 0,
      });
    } catch (error) {
      return res.status(500).json({ code: 'RELAY_CONFIG_UPDATE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  });

  runtime.app.get('/api/production-inspection-config', (_req, res) => {
    res.json({ config: inspectionRecordConfig });
  });

  runtime.app.put('/api/production-inspection-config', requireDesktopMutation, async (req, res) => {
    if (runtime.snapshot().summary.productSelectionLocked) {
      return res.status(409).json({ code: 'INSPECTION_RECORD_CONFIG_LOCKED_DURING_PROCESS' });
    }
    try {
      inspectionRecordConfig = normalizeProductionInspectionRecordConfig(req.body, inspectionRecordConfig);
      productionRuns.setRecordConfig(inspectionRecordConfig);
      const store = await loadSystemConfig() ?? createDefaultSystemConfig();
      await saveSystemConfig({ ...store, productionInspectionRecordConfig: inspectionRecordConfig, lastUpdated: Date.now() });
      return res.json({ success: true, config: inspectionRecordConfig });
    } catch (error) {
      return res.status(500).json({ code: 'INSPECTION_RECORD_CONFIG_UPDATE_FAILED', error: error instanceof Error ? error.message : String(error) });
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
  return Object.assign(runtime, { productionRuns });
}
