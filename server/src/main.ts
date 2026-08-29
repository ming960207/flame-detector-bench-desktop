import { config } from './config.js';
import { assertSupportedRuntimeMode } from './field-runtime-gate.js';

export interface ConfiguredServerRuntime {
  close(): Promise<void>;
}

export async function startConfiguredServer(): Promise<ConfiguredServerRuntime> {
  assertSupportedRuntimeMode(config.closureMode);
  if (config.closureMode === 'field') {
    const { startFieldStatusServer } = await import('./closure/field-status-server.js');
    return startFieldStatusServer();
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
