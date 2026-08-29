import { config } from './config.js';
import { MQTTPublisher } from './mqtt-publisher.js';
import { createTestProgramRuntime, type TestProgramRuntime } from './test-program/test-program-server.js';
import type { ConnectionStatus, FlameDetectorState } from './types.js';

interface FieldSummaryPayload {
  plcConnected?: boolean;
  detectorConnected?: boolean;
  detectorTransportConnected?: boolean;
  detectorDataStreamConnected?: boolean;
}

export interface UnifiedAuxiliaryRuntime {
  readonly testProgram: TestProgramRuntime;
  close(): Promise<void>;
}

function localBackendUrl(): string {
  return `http://127.0.0.1:${config.serverPort}`;
}

function mqttEnabled(): boolean {
  return process.env.MQTT_ENABLED !== 'false';
}

function testProgramPort(): number {
  const configured = Number(process.env.TEST_PROGRAM_PORT);
  if (Number.isInteger(configured) && configured > 0 && configured <= 65535) return configured;
  return config.serverPort + 1;
}

function buildConnectionStatus(summary: FieldSummaryPayload): ConnectionStatus {
  return {
    relay: {
      connected: summary.plcConnected === true,
      mode: 'S7',
      ip: config.plc.ip,
      port: config.plc.port,
    },
    flame: {
      connected: summary.detectorConnected === true,
      transportConnected: summary.detectorTransportConnected === true,
      dataStreamConnected: summary.detectorDataStreamConnected === true,
      mode: config.flame.mode,
    },
  };
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${localBackendUrl()}${path}`, {
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`UNIFIED_BACKEND_HTTP_${response.status}`);
  return response.json() as Promise<T>;
}

/**
 * Starts non-controlling services inside the same Node.js backend process.
 *
 * The test observer remains read-only and consumes the field backend through
 * localhost. MQTT publishing consumes the same authoritative field state, so
 * neither service opens a second PLC/Modbus connection or writes PLC I/O.
 */
export async function startUnifiedAuxiliaryServices(): Promise<UnifiedAuxiliaryRuntime> {
  const backendUrl = localBackendUrl();
  const testProgram = createTestProgramRuntime({
    formalBackendUrl: backendUrl,
    formalBackendWsUrl: backendUrl.replace(/^http:/i, 'ws:'),
  });
  const observerPort = await testProgram.listen(testProgramPort());

  const publisher = new MQTTPublisher({
    ...(config.mqttConfig ?? {}),
    mqttEnabled: mqttEnabled(),
  });
  if (mqttEnabled()) publisher.connect();

  let stopped = false;
  let pollInFlight = false;

  const forwardFieldState = async (): Promise<void> => {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    try {
      const [state, summary] = await Promise.all([
        fetchJson<FlameDetectorState>('/api/flame/devices'),
        fetchJson<FieldSummaryPayload>('/api/field/summary'),
      ]);
      publisher.handleFlameState(state, buildConnectionStatus(summary));
    } catch (error) {
      // Field runtime owns device connectivity. Auxiliary services must never
      // make backend startup fail merely because equipment is temporarily down.
      console.warn('[统一后端] MQTT 状态同步暂不可用:', error instanceof Error ? error.message : String(error));
    } finally {
      pollInFlight = false;
    }
  };

  await forwardFieldState();
  const pollTimer = setInterval(() => { void forwardFieldState(); }, 1_000);
  pollTimer.unref?.();

  console.log(`[统一后端] 测试监听已并入当前 Node 进程，兼容 API: http://127.0.0.1:${observerPort}`);
  console.log(`[统一后端] MQTT 上传: ${mqttEnabled() ? '已启用' : '已禁用(MQTT_ENABLED=false)'}`);

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
