import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FlameConfig, PLCDeviceConfigLocal } from './config.js';
import type { ProductDetectionConfig } from './product-profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE_PATH = process.env.APP_DATA_DIR
  ? join(process.env.APP_DATA_DIR, 'system-config.json')
  : join(__dirname, '..', 'system-config.json');

export interface SystemConfigStore {
  steps: unknown[];
  modbusConfig?: unknown;
  plcConfig?: PLCDeviceConfigLocal;
  flameConfig?: FlameConfig;
  tempConfig?: unknown;
  wateringConfig?: unknown;
  doRelations?: unknown;
  mqttConfig?: unknown;
  productDetectionConfig?: ProductDetectionConfig;
  lastUpdated: number;
}

export async function loadSystemConfig(): Promise<SystemConfigStore | null> {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
    const store = JSON.parse(data) as SystemConfigStore;
    return store;
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('[SystemConfigStore] 加载配置失败:', error.message);
    }
    return null;
  }
}

export async function saveSystemConfig(store: SystemConfigStore): Promise<void> {
  const temporaryPath = `${CONFIG_FILE_PATH}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(store, null, 2)}\n`;
  try {
    await fs.writeFile(temporaryPath, content, 'utf-8');
    await fs.rename(temporaryPath, CONFIG_FILE_PATH);
  } catch (error: any) {
    try { await fs.unlink(temporaryPath); } catch { /* no temporary file */ }
    console.error('[SystemConfigStore] 保存配置失败:', error.message);
    throw error;
  }
}

export function createDefaultSystemConfig(): SystemConfigStore {
  return {
    steps: [],
    lastUpdated: Date.now(),
  };
}
