import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FlameConfig, PLCDeviceConfigLocal } from './config.js';
import type { ProductDetectionConfig } from './product-profile.js';
import type { RelayFunctionalTestConfig } from './relay-functional-test.js';
import type { ProductionInspectionRecordConfig } from './production-inspection-record.js';

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
  relayFunctionalTestConfig?: RelayFunctionalTestConfig;
  productionInspectionRecordConfig?: ProductionInspectionRecordConfig;
  lastUpdated: number;
}

export type SystemConfigUpdater = (
  current: SystemConfigStore,
) => SystemConfigStore | Promise<SystemConfigStore>;

export function createDefaultSystemConfig(): SystemConfigStore {
  return {
    steps: [],
    lastUpdated: Date.now(),
  };
}

/**
 * One repository owns all read-modify-write mutations for system-config.json.
 * The queue is process-local by design: the packaged application runs one unified
 * backend process, so serializing here prevents two API handlers from reading the
 * same old snapshot and later overwriting each other's changes.
 */
export class SystemConfigRepository {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = CONFIG_FILE_PATH) {}

  async load(): Promise<SystemConfigStore | null> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(data) as SystemConfigStore;
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('[SystemConfigStore] 加载配置失败:', error.message);
      }
      return null;
    }
  }

  private async write(store: SystemConfigStore): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const content = `${JSON.stringify(store, null, 2)}\n`;
    try {
      await fs.writeFile(temporaryPath, content, 'utf-8');
      await fs.rename(temporaryPath, this.filePath);
    } catch (error: any) {
      try { await fs.unlink(temporaryPath); } catch { /* no temporary file */ }
      console.error('[SystemConfigStore] 保存配置失败:', error.message);
      throw error;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(task, task);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Complete replacement for legacy callers. Prefer update() for API mutations. */
  save(store: SystemConfigStore): Promise<void> {
    return this.enqueue(async () => {
      await this.write(store);
    });
  }

  /**
   * Atomically load the latest snapshot, apply one mutation, and persist it while
   * holding the repository queue. Concurrent callers therefore compose instead of
   * replacing one another with stale snapshots.
   */
  update(updater: SystemConfigUpdater): Promise<SystemConfigStore> {
    return this.enqueue(async () => {
      const current = await this.load() ?? createDefaultSystemConfig();
      const next = await updater(current);
      await this.write(next);
      return next;
    });
  }
}

const defaultRepository = new SystemConfigRepository();

export function loadSystemConfig(): Promise<SystemConfigStore | null> {
  return defaultRepository.load();
}

export function saveSystemConfig(store: SystemConfigStore): Promise<void> {
  return defaultRepository.save(store);
}

export function updateSystemConfig(updater: SystemConfigUpdater): Promise<SystemConfigStore> {
  return defaultRepository.update(updater);
}
