import { config } from './config.js';
import { assertSupportedRuntimeMode } from './field-runtime-gate.js';

export interface ConfiguredServerRuntime {
  close(): Promise<void>;
}

export async function startConfiguredServer(): Promise<ConfiguredServerRuntime> {
  assertSupportedRuntimeMode(config.closureMode);

  if (config.closureMode === 'field') {
    const [{ startFieldStatusServer }, { startUnifiedAuxiliaryServices }] = await Promise.all([
      import('./closure/field-status-server.js'),
      import('./unified-services.js'),
    ]);

    const fieldRuntime = await startFieldStatusServer();
    let auxiliaryRuntime: Awaited<ReturnType<typeof startUnifiedAuxiliaryServices>> | undefined;
    try {
      auxiliaryRuntime = await startUnifiedAuxiliaryServices();
    } catch (error) {
      await fieldRuntime.close();
      throw error;
    }

    return {
      async close(): Promise<void> {
        await auxiliaryRuntime?.close();
        await fieldRuntime.close();
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
