import { config } from './config.js';
import { assertSupportedRuntimeMode } from './field-runtime-gate.js';
import { checkActiveMESConnectivity, getActiveMESPublicStatus } from './mes-publisher.js';
import {
  DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
  normalizeProductionInspectionRecordConfig,
} from './production-inspection-record.js';
import { loadSystemConfig } from './system-config-store.js';

export interface ConfiguredServerRuntime {
  close(): Promise<void>;
}

async function closeAll(runtimes: Array<{ close(): Promise<void> } | undefined>): Promise<void> {
  const results = await Promise.allSettled(runtimes.filter(Boolean).map((runtime) => runtime!.close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => failure.reason), '一个或多个后端子服务关闭失败');
  }
}

export async function startConfiguredServer(): Promise<ConfiguredServerRuntime> {
  assertSupportedRuntimeMode(config.closureMode);

  if (config.closureMode === 'field') {
    const [
      { startProductAwareFieldStatusServer },
      { startUnifiedAuxiliaryServices },
      { startDiagnosticLogAutoUpload },
      { startRelayStatusLightsService },
    ] = await Promise.all([
      import('./product-aware-field-runtime.js'),
      import('./unified-services.js'),
      import('./diagnostic-log-auto-upload.js'),
      import('./relay-status-lights-service.js'),
    ]);

    const fieldRuntime = await startProductAwareFieldStatusServer();

    fieldRuntime.app.get('/api/mes/status', async (_req, res) => {
      try {
        await checkActiveMESConnectivity();
        const status = getActiveMESPublicStatus();
        if (!status) {
          return res.status(503).json({
            enabled: false,
            apiKeyConfigured: false,
            operatorConfigured: false,
            operatorName: '',
            pendingJobs: 0,
            connectivity: {
              state: 'UNKNOWN',
              checkedAt: null,
              httpStatus: null,
            },
            lastSuccessAt: null,
            lastError: 'MES_PUBLISHER_NOT_READY',
            connectionState: 'UNAVAILABLE',
            timestamp: Date.now(),
          });
        }

        const store = await loadSystemConfig();
        const recordConfig = normalizeProductionInspectionRecordConfig(
          store?.productionInspectionRecordConfig,
          DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
        );
        const effectiveOperator = recordConfig.inspector.trim() || status.operatorName.trim();
        const operatorConfigured = Boolean(effectiveOperator);
        const lastSuccessAt = status.lastUploadedAt ?? null;
        const lastError = status.lastError || null;
        const connectivity = status.connectivity;
        const connectionState = !status.enabled
          ? 'DISABLED'
          : connectivity.state === 'UNREACHABLE'
            ? 'UNREACHABLE'
            : connectivity.state === 'UNKNOWN'
              ? 'CHECKING'
              : !status.apiKeyConfigured || !operatorConfigured
                ? 'MISCONFIGURED'
                : lastError
                  ? 'ERROR'
                  : status.pendingJobs > 0
                    ? 'PENDING'
                    : lastSuccessAt
                      ? 'HEALTHY'
                      : 'READY';

        return res.json({
          enabled: status.enabled,
          apiKeyConfigured: status.apiKeyConfigured,
          operatorConfigured,
          operatorName: effectiveOperator,
          pendingJobs: status.pendingJobs,
          connectivity,
          lastSuccessAt,
          lastError,
          connectionState,
          baseUrl: status.baseUrl,
          requestTimeoutMs: status.requestTimeoutMs,
          timestamp: Date.now(),
          display: {
            enabled: status.enabled ? '已启用' : '未启用',
            endpoint: status.baseUrl,
            connectivity: connectivity.state === 'REACHABLE'
              ? `可达${connectivity.httpStatus === null ? '' : `（HTTP ${connectivity.httpStatus}）`}`
              : connectivity.state === 'UNREACHABLE'
                ? `不可达${connectivity.error ? `：${connectivity.error}` : ''}`
                : '检测中',
            apiKey: status.apiKeyConfigured ? '已配置' : '未配置',
            operator: operatorConfigured ? `已配置（${effectiveOperator}）` : '未配置',
            pendingJobs: String(status.pendingJobs),
            lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : '暂无',
            lastError: lastError || '无',
          },
        });
      } catch (error) {
        return res.status(500).json({
          code: 'MES_STATUS_READ_FAILED',
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      }
    });

    let auxiliaryRuntime: Awaited<ReturnType<typeof startUnifiedAuxiliaryServices>> | undefined;
    try {
      auxiliaryRuntime = await startUnifiedAuxiliaryServices(fieldRuntime);
    } catch (error) {
      try {
        await fieldRuntime.close();
      } catch (closeError) {
        console.error('[统一后端] 启动失败后的清理也失败:', closeError);
      }
      throw error;
    }

    // The original status-light endpoint intentionally reports relay feedback as
    // unknown. Add a read-only DIO-backed endpoint for the production UI while
    // keeping the formal relay-test coordinator unchanged.
    const relayStatusLightsRuntime = startRelayStatusLightsService(fieldRuntime);

    // A completed field test is persisted by FileFieldTestResultLogger as one
    // append to test-results-*.log. Watching that durable completion artifact
    // keeps automatic release-source upload inside the unified backend process and avoids
    // coupling upload/network failures back into the inspection verdict path.
    const diagnosticUploadRuntime = startDiagnosticLogAutoUpload();

    let closed = false;
    return {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await closeAll([
          diagnosticUploadRuntime,
          relayStatusLightsRuntime,
          auxiliaryRuntime,
          fieldRuntime,
        ]);
      },
    };
  }

  const { startOfflineServer } = await import('./closure/offline-server.js');
  return startOfflineServer();
}

if (process.env.DESKTOP_EMBEDDED_SERVER !== '1') {
  void startConfiguredServer().catch((error) => {
    console.error('启动失败:', error);
    process.exit(1);
  });
}
