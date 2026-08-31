import { config } from './config.js';
import type { FieldStatusRuntime, FieldStatusSummary } from './closure/field-status-server.js';
import { MQTTPublisher, normalizeMQTTConfig } from './mqtt-publisher.js';
import { requireDesktopMutation } from './request-security.js';
import { createDefaultSystemConfig, loadSystemConfig, saveSystemConfig } from './system-config-store.js';
import { selectedProductProfile } from './product-profile.js';
import { ProductCodeStore, type ProductCodeAllocation } from './product-code-store.js';
import { mountTestProgramRoutes, type EmbeddedTestProgramRuntime } from './test-program/test-program-routes.js';
import type { TestProgramArchive } from './test-program/test-program-types.js';
import type { ConnectionStatus } from './types.js';

export interface UnifiedAuxiliaryRuntime {
  readonly testProgram: EmbeddedTestProgramRuntime;
  close(): Promise<void>;
}

function localBackendUrl(): string {
  return `http://127.0.0.1:${config.serverPort}`;
}

function buildConnectionStatus(summary: FieldStatusSummary): ConnectionStatus {
  const plc = config.plcs[0] ?? config.plc;
  return {
    relay: {
      connected: summary.plcConnected,
      mode: 'S7',
      ip: plc.ip,
      port: plc.port,
    },
    flame: {
      connected: summary.detectorConnected,
      transportConnected: summary.detectorTransportConnected,
      dataStreamConnected: summary.detectorDataStreamConnected,
      mode: config.flame.mode,
    },
  };
}

function explicitEnvMQTTOverrides(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (process.env.MQTT_ENABLED !== undefined) result.mqttEnabled = process.env.MQTT_ENABLED === 'true';
  if (process.env.MQTT_BROKER_URL) result.brokerUrl = process.env.MQTT_BROKER_URL;
  if (process.env.MQTT_TOPIC) result.topic = process.env.MQTT_TOPIC;
  if (process.env.MQTT_CLIENT_ID) result.clientId = process.env.MQTT_CLIENT_ID;
  if (process.env.MQTT_USERNAME) result.username = process.env.MQTT_USERNAME;
  if (process.env.MQTT_PASSWORD) result.password = process.env.MQTT_PASSWORD;
  if (process.env.MQTT_FACTORY_ID) result.factoryId = process.env.MQTT_FACTORY_ID;
  if (process.env.MQTT_LINE_ID) result.lineId = process.env.MQTT_LINE_ID;
  if (process.env.MQTT_DEVICE_ID) result.deviceId = process.env.MQTT_DEVICE_ID;
  return result;
}

export async function startUnifiedAuxiliaryServices(fieldRuntime: FieldStatusRuntime): Promise<UnifiedAuxiliaryRuntime> {
  const backendUrl = localBackendUrl();

  // The observer has always expected this endpoint, but the old field server
  // never exposed it. Return only the plan reference data it actually needs;
  // never expose detector/MQTT credentials from the full system store.
  fieldRuntime.app.get('/api/system-config', async (_req, res) => {
    const store = await loadSystemConfig();
    res.json({
      config: store ? {
        steps: Array.isArray(store.steps) ? store.steps : [],
        lastUpdated: store.lastUpdated,
      } : null,
    });
  });

  const testProgram = mountTestProgramRoutes(fieldRuntime.app, {
    formalBackendUrl: backendUrl,
    formalBackendWsUrl: backendUrl.replace(/^http:/i, 'ws:'),
    broadcast: (type, payload) => {
      fieldRuntime.wsServer.broadcast({ type, payload, timestamp: Date.now() } as any);
    },
  });

  const stored = await loadSystemConfig();
  const storedMQTT = normalizeMQTTConfig(stored?.mqttConfig, config.mqttConfig);
  const initialMQTT = normalizeMQTTConfig(explicitEnvMQTTOverrides(), storedMQTT);
  config.mqttConfig = initialMQTT;
  const publisher = new MQTTPublisher(initialMQTT);
  const productCodeStore = new ProductCodeStore();
  let productCodeAllocation: ProductCodeAllocation | null = null;
  let productCodeBatchId: string | null = null;
  let productCodeAllocationBusy = false;
  let productCodeAllocationError: string | null = null;

  const onTestArchive = (archive: TestProgramArchive) => {
    if (!publisher.getStatus().enabled) return;
    void publisher.publishInspectionResult(archive).catch((error) => {
      console.error('[统一后端] 检测结果 MQTT 上传异常:', error instanceof Error ? error.message : String(error));
    });
  };
  testProgram.observer.on('archive', onTestArchive);
  testProgram.start();
  if (initialMQTT.mqttEnabled) publisher.connect();

  let stopped = false;
  let forwarding = false;
  let mqttConfigBusy = false;
  let lastForwardError: string | null = null;
  let lastForwardAt: number | null = null;

  const ensureProductCodeAllocation = async (): Promise<void> => {
    if (stopped || productCodeAllocationBusy) return;
    const snapshot = fieldRuntime.snapshot();
    const batchId = snapshot.summary.waveformAnalysis.batchId;
    // 只在正式流程已锁定产品配置时占号；COMPLETE/IDLE 后不得为历史快照补占新号码。
    if (!batchId || !snapshot.summary.productSelectionLocked || productCodeBatchId === batchId) return;
    productCodeBatchId = batchId;
    productCodeAllocationBusy = true;
    productCodeAllocationError = null;
    try {
      const profile = selectedProductProfile(snapshot.summary.productConfig);
      const startedAt = snapshot.summary.waveformAnalysis.startedAt ?? Date.now();
      productCodeAllocation = await productCodeStore.allocateBatch(
        profile.productModel,
        profile.productCodeRule,
        new Date(startedAt),
        6,
        batchId,
      );
      if (productCodeAllocation.status === 'RULE_MISSING') {
        console.warn(`[统一后端] 批次 ${batchId} 编码规则未配置完整，不影响检测: ${productCodeAllocation.reason ?? 'RULE_MISSING'}`);
      } else if (productCodeAllocation.status === 'GENERATED') {
        console.log(`[统一后端] 批次 ${batchId} 已预占 6 个产品编号 (${productCodeAllocation.monthKey})`);
      }
    } catch (error) {
      productCodeAllocationError = error instanceof Error ? error.message : String(error);
      console.error(`[统一后端] 批次 ${batchId} 产品编号预占失败，不阻断检测:`, productCodeAllocationError);
      // 编号子系统失败不能影响检测台正式流程；保留错误供 UI/记录查询。
      productCodeAllocation = {
        batchId,
        status: 'RULE_MISSING',
        productModel: selectedProductProfile(snapshot.summary.productConfig).productModel,
        monthKey: null,
        productionDate: snapshot.summary.waveformAnalysis.startedAt ?? Date.now(),
        items: [],
        reason: `PRODUCT_CODE_ALLOCATION_FAILED:${productCodeAllocationError}`,
      };
    } finally {
      productCodeAllocationBusy = false;
    }
  };

  const forwardFieldState = (): void => {
    if (stopped || forwarding) return;
    forwarding = true;
    try {
      const snapshot = fieldRuntime.snapshot();
      publisher.handleFlameState(snapshot.flame, buildConnectionStatus(snapshot.summary));
      lastForwardAt = Date.now();
      lastForwardError = null;
      void ensureProductCodeAllocation();
    } catch (error) {
      lastForwardError = error instanceof Error ? error.message : String(error);
      console.warn('[统一后端] MQTT 状态同步暂不可用:', lastForwardError);
    } finally {
      forwarding = false;
    }
  };

  const publicMQTTStatus = () => {
    const { outboxFile: _outboxFile, ...status } = publisher.getStatus();
    return status;
  };

  fieldRuntime.app.get('/api/product-code/current', (_req, res) => {
    res.json({
      allocation: productCodeAllocation,
      busy: productCodeAllocationBusy,
      error: productCodeAllocationError,
      timestamp: Date.now(),
    });
  });
  fieldRuntime.app.get('/api/product-code/batch/:batchId', async (req, res) => {
    try {
      const allocation = await productCodeStore.getBatchAllocation(req.params.batchId);
      if (!allocation) return res.status(404).json({ code: 'PRODUCT_CODE_ALLOCATION_NOT_FOUND' });
      return res.json({ allocation });
    } catch (error) {
      return res.status(500).json({
        code: 'PRODUCT_CODE_ALLOCATION_READ_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fieldRuntime.app.get('/api/mqtt/status', (_req, res) => {
    res.json({
      ...publicMQTTStatus(),
      configBusy: mqttConfigBusy,
      lastForwardAt,
      lastForwardError,
      source: 'field-runtime-memory',
      timestamp: Date.now(),
    });
  });
  fieldRuntime.app.get('/api/mqtt/config', requireDesktopMutation, (_req, res) => {
    res.json({ success: true, config: publisher.getPublicConfig() });
  });
  fieldRuntime.app.put('/api/mqtt/config', requireDesktopMutation, async (req, res) => {
    if (mqttConfigBusy) return res.status(409).json({ code: 'MQTT_CONFIG_BUSY' });
    mqttConfigBusy = true;
    const previous = publisher.getConfig();
    try {
      const next = normalizeMQTTConfig(req.body, previous);
      const currentStore = await loadSystemConfig() ?? createDefaultSystemConfig();
      publisher.updateConfig(next);
      config.mqttConfig = next;
      await saveSystemConfig({ ...currentStore, mqttConfig: next, lastUpdated: Date.now() });
      forwardFieldState();
      return res.json({ success: true, config: publisher.getPublicConfig(), status: publicMQTTStatus() });
    } catch (error) {
      try {
        publisher.updateConfig(previous);
        config.mqttConfig = previous;
      } catch (rollback) {
        console.error('[统一后端] MQTT 配置回滚失败:', rollback);
      }
      return res.status(500).json({
        code: 'MQTT_CONFIG_UPDATE_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      mqttConfigBusy = false;
    }
  });

  forwardFieldState();
  const pollTimer = setInterval(forwardFieldState, 1_000);
  pollTimer.unref?.();

  console.log(`[统一后端] 测试监听 API 已并入正式端口: ${backendUrl}/api/test-program/*`);
  console.log(`[统一后端] MQTT 上传: ${publisher.getStatus().enabled ? '已启用' : '已禁用'}`);

  return {
    testProgram,
    async close(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      testProgram.observer.removeListener('archive', onTestArchive);
      publisher.disconnect();
      await testProgram.close();
    },
  };
}
