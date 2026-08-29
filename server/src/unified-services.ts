import { config } from './config.js';
import type { FieldStatusRuntime, FieldStatusSummary } from './closure/field-status-server.js';
import { MQTTPublisher, normalizeMQTTConfig } from './mqtt-publisher.js';
import { requireDesktopMutation } from './request-security.js';
import { createDefaultSystemConfig, loadSystemConfig, saveSystemConfig } from './system-config-store.js';
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

  const forwardFieldState = (): void => {
    if (stopped || forwarding) return;
    forwarding = true;
    try {
      const snapshot = fieldRuntime.snapshot();
      publisher.handleFlameState(snapshot.flame, buildConnectionStatus(snapshot.summary));
      lastForwardAt = Date.now();
      lastForwardError = null;
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
