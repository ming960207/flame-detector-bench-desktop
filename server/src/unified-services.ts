import { config } from './config.js';
import type { FieldStatusRuntime, FieldStatusSummary } from './closure/field-status-server.js';
import { MQTTPublisher } from './mqtt-publisher.js';
import { mountTestProgramRoutes, type EmbeddedTestProgramRuntime } from './test-program/test-program-routes.js';
import type { ConnectionStatus } from './types.js';

export interface UnifiedAuxiliaryRuntime {
  readonly testProgram: EmbeddedTestProgramRuntime;
  close(): Promise<void>;
}

function localBackendUrl(): string {
  return `http://127.0.0.1:${config.serverPort}`;
}

function mqttEnabled(): boolean {
  if (process.env.MQTT_ENABLED !== undefined) return process.env.MQTT_ENABLED !== 'false';
  return config.mqttConfig?.mqttEnabled !== false;
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

/**
 * Start observation/upload services on the already-running field backend.
 * There is exactly one HTTP/WS listener and exactly one PLC/flame device stack.
 */
export async function startUnifiedAuxiliaryServices(fieldRuntime: FieldStatusRuntime): Promise<UnifiedAuxiliaryRuntime> {
  const backendUrl = localBackendUrl();
  const testProgram = mountTestProgramRoutes(fieldRuntime.app, {
    formalBackendUrl: backendUrl,
    formalBackendWsUrl: backendUrl.replace(/^http:/i, 'ws:'),
    broadcast: (type, payload) => {
      fieldRuntime.wsServer.broadcast({ type, payload, timestamp: Date.now() } as any);
    },
  });
  testProgram.start();

  const enabled = mqttEnabled();
  const publisher = new MQTTPublisher({
    ...(config.mqttConfig ?? {}),
    mqttEnabled: enabled,
  });
  if (enabled) {
    try {
      publisher.connect();
    } catch (error) {
      console.error('[统一后端] MQTT 初始化失败，将继续运行本地检测:', error instanceof Error ? error.message : String(error));
    }
  }

  let stopped = false;
  let forwarding = false;
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

  fieldRuntime.app.get('/api/mqtt/status', (_req, res) => {
    res.json({
      enabled,
      connected: publisher.isConnected(),
      lastForwardAt,
      lastForwardError,
      source: 'field-runtime-memory',
      timestamp: Date.now(),
    });
  });

  forwardFieldState();
  const pollTimer = setInterval(forwardFieldState, 1_000);
  pollTimer.unref?.();

  console.log(`[统一后端] 测试监听 API 已并入正式端口: ${backendUrl}/api/test-program/*`);
  console.log(`[统一后端] MQTT 上传: ${enabled ? '已启用' : '已禁用'}`);

  return {
    testProgram,
    async close(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      publisher.disconnect();
      await testProgram.close();
    },
  };
}
