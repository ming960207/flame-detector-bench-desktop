import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FlameConfig, PLCDeviceConfigLocal } from './config.js';
import type { ProductDetectionConfig } from './product-profile.js';
import type { RelayFunctionalTestConfig } from './relay-functional-test.js';
import type { ProductionInspectionRecordConfig } from './production-inspection-record.js';
import type { MESConfig } from './mes-publisher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE_PATH = process.env.APP_DATA_DIR
  ? join(process.env.APP_DATA_DIR, 'system-config.json')
  : join(__dirname, '..', 'system-config.json');

const BASE_SNAPSHOT = Symbol('system-config-base-snapshot');

type SnapshottedSystemConfigStore = SystemConfigStore & {
  [BASE_SNAPSHOT]?: SystemConfigStore;
};

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
  mesConfig?: MESConfig;
  lastUpdated: number;
}

export type SystemConfigUpdater = (
  current: SystemConfigStore,
) => SystemConfigStore | Promise<SystemConfigStore>;

function clonePlain(store: SystemConfigStore): SystemConfigStore {
  return JSON.parse(JSON.stringify(store)) as SystemConfigStore;
}

function withSnapshot(store: SystemConfigStore, base: SystemConfigStore = store): SystemConfigStore {
  Object.defineProperty(store as SnapshottedSystemConfigStore, BASE_SNAPSHOT, {
    value: clonePlain(base),
    enumerable: true,
    configurable: true,
  });
  return store;
}

function plainDefaultSystemConfig(): SystemConfigStore {
  return {
    steps: [],
    lastUpdated: Date.now(),
  };
}

export function createDefaultSystemConfig(): SystemConfigStore {
  const store = plainDefaultSystemConfig();
  return withSnapshot(store, store);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

  private async loadRaw(): Promise<SystemConfigStore | null> {
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

  async load(): Promise<SystemConfigStore | null> {
    const store = await this.loadRaw();
    return store ? withSnapshot(store, store) : null;
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

  /**
   * Compatibility save for existing API handlers. load()/createDefaultSystemConfig()
   * attach an enumerable Symbol snapshot that survives object spread. If another
   * handler has already saved a newer snapshot, only fields changed by this caller
   * relative to its own base snapshot are merged into the latest file.
   */
  save(store: SystemConfigStore): Promise<void> {
    return this.enqueue(async () => {
      const snapshotted = store as SnapshottedSystemConfigStore;
      const base = snapshotted[BASE_SNAPSHOT];
      if (!base) {
        await this.write(store);
        return;
      }

      const latest = await this.loadRaw() ?? plainDefaultSystemConfig();
      const merged = { ...latest } as Record<string, unknown>;
      const submitted = store as unknown as Record<string, unknown>;
      const original = base as unknown as Record<string, unknown>;
      const keys = new Set([...Object.keys(original), ...Object.keys(submitted)]);

      for (const key of keys) {
        const before = original[key];
        const after = submitted[key];
        if (sameValue(before, after)) continue;
        if (Object.prototype.hasOwnProperty.call(submitted, key)) merged[key] = after;
        else delete merged[key];
      }

      await this.write(merged as unknown as SystemConfigStore);
    });
  }

  /**
   * Atomically load the latest snapshot, apply one mutation, and persist it while
   * holding the repository queue. New API code should prefer this method directly.
   */
  update(updater: SystemConfigUpdater): Promise<SystemConfigStore> {
    return this.enqueue(async () => {
      const current = await this.loadRaw() ?? plainDefaultSystemConfig();
      const next = await updater(clonePlain(current));
      await this.write(next);
      return withSnapshot(next, next);
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
