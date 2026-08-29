/**
 * PLC配置持久化存储
 */

import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PLCDeviceConfigLocal } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE_PATH = process.env.APP_DATA_DIR
  ? join(process.env.APP_DATA_DIR, 'plc-configs.json')
  : join(__dirname, '..', 'plc-configs.json');

export interface PLCConfigStore {
  plcs: PLCDeviceConfigLocal[];
  lastUpdated: number;
}

export async function loadPLCConfigs(): Promise<PLCDeviceConfigLocal[]> {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
    const store: PLCConfigStore = JSON.parse(data);
    console.log(`[PLCConfigStore] 从文件加载了 ${store.plcs.length} 个PLC配置`);
    return store.plcs;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log('[PLCConfigStore] 配置文件不存在，将使用默认配置');
    } else {
      console.error('[PLCConfigStore] 加载配置失败:', error.message);
    }
    return [];
  }
}

export async function savePLCConfigs(plcs: PLCDeviceConfigLocal[]): Promise<void> {
  try {
    const store: PLCConfigStore = { plcs, lastUpdated: Date.now() };
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(store, null, 2), 'utf-8');
    console.log(`[PLCConfigStore] 已保存 ${plcs.length} 个PLC配置到文件`);
  } catch (error: any) {
    console.error('[PLCConfigStore] 保存配置失败:', error.message);
    throw error;
  }
}

export function getDefaultPLCConfig(): PLCDeviceConfigLocal {
  const mode = (process.env.PLC_MODE as PLCDeviceConfigLocal['mode']) || 'S7';
  return {
    id: 'plc-default',
    name: 'PLC一体机',
    enabled: true,
    mode,
    ip: process.env.PLC_IP || '192.168.2.1',
    port: parseInt(process.env.PLC_PORT || (mode === 'S7' ? '102' : '502'), 10),
    slaveId: parseInt(process.env.PLC_SLAVE_ID || '1', 10),
    diCount: 18,
    doCount: 12,
    pollIntervalMs: 200,
  };
}

export function mergeWithDefaults(configs: PLCDeviceConfigLocal[]): PLCDeviceConfigLocal[] {
  if (configs.length === 0) return [getDefaultPLCConfig()];
  return configs;
}

export default { loadPLCConfigs, savePLCConfigs, getDefaultPLCConfig, mergeWithDefaults };
