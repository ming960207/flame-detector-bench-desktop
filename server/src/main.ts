import { config } from './config.js';
import { assertSupportedRuntimeMode } from './field-runtime-gate.js';

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
    // Install detector startup/recovery semantics before the field runtime creates
    // ProductAwareFlameDetectorService. Import order matters: the relay policy wraps
    // the already-stabilized waveform watchdog implementation; the inspection policy
    // then adds stage-level fresh-frame gating on top of the same service instance.
    await import('./modbus/flame-detector-waveform-startup-policy.js');
    await import('./product-aware-relay-verification-policy.js');
    await import('./inspection-waveform-freshness-policy.js');

    const [{ startProductAwareFieldStatusServer }, { startUnifiedAuxiliaryServices }] = await Promise.all([
      import('./product-aware-field-runtime.js'),
      import('./unified-services.js'),
    ]);

    const fieldRuntime = await startProductAwareFieldStatusServer();
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

    let closed = false;
    return {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await closeAll([auxiliaryRuntime, fieldRuntime]);
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
