import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  generateProductCode,
  productCodeRuleMissingFields,
  productMonthlySerialKey,
  type ProductCodeGenerationStatus,
  type ProductCodeRule,
} from './product-code.js';

interface PersistedAllocation {
  batchId: string;
  status: 'GENERATED';
  productModel: string;
  monthKey: string;
  productionDate: number;
  items: ProductCodeAllocationItem[];
  allocatedAt: number;
}

interface ProductCodeCounterState {
  version: 1;
  counters: Record<string, number>;
  allocations: Record<string, PersistedAllocation>;
  updatedAt: number;
}

export interface ProductCodeAllocationItem {
  slot: number;
  serial: number | null;
  productCode: string | null;
}

export interface ProductCodeAllocation {
  batchId: string | null;
  status: ProductCodeGenerationStatus;
  productModel: string;
  monthKey: string | null;
  productionDate: number;
  items: ProductCodeAllocationItem[];
  reason?: string;
}

const DEFAULT_STATE: ProductCodeCounterState = { version: 1, counters: {}, allocations: {}, updatedAt: 0 };

function defaultStorePath(): string {
  return join(process.env.APP_DATA_DIR || process.cwd(), 'product-code-state.json');
}

export class ProductCodeStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = defaultStorePath()) {}

  private async load(): Promise<ProductCodeCounterState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProductCodeCounterState>;
      return {
        version: 1,
        counters: parsed.counters && typeof parsed.counters === 'object' ? { ...parsed.counters } : {},
        allocations: parsed.allocations && typeof parsed.allocations === 'object' ? { ...parsed.allocations } : {},
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      return { ...DEFAULT_STATE, counters: {}, allocations: {} };
    }
  }

  private async save(state: ProductCodeCounterState): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const body = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await fs.writeFile(temporary, body, 'utf8');
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  async getBatchAllocation(batchId: string): Promise<ProductCodeAllocation | null> {
    const normalized = batchId.trim();
    if (!normalized) return null;
    const state = await this.load();
    const found = state.allocations[normalized];
    if (!found) return null;
    return {
      batchId: found.batchId,
      status: 'GENERATED',
      productModel: found.productModel,
      monthKey: found.monthKey,
      productionDate: found.productionDate,
      items: found.items.map((item) => ({ ...item })),
    };
  }

  /**
   * 一次性预占本批次流水号。已经预占的编号即使后续批次中止也不回收。
   * batchId 已经分配过时返回原分配结果，确保轮询、重连和重复事件不会二次占号。
   */
  async allocateBatch(
    productModel: string,
    rule: ProductCodeRule,
    productionDate: Date,
    count = 6,
    batchId: string | null = null,
  ): Promise<ProductCodeAllocation> {
    const task = async (): Promise<ProductCodeAllocation> => {
      const timestamp = productionDate.getTime();
      if (!Number.isFinite(timestamp)) throw new Error('PRODUCT_CODE_DATE_INVALID');
      const model = productModel.trim();
      const normalizedBatchId = batchId?.trim() || null;
      if (!model) {
        return {
          batchId: normalizedBatchId,
          status: 'RULE_MISSING',
          productModel: '',
          monthKey: null,
          productionDate: timestamp,
          items: [],
          reason: 'PRODUCT_MODEL_MISSING',
        };
      }
      if (!rule.enabled) {
        return {
          batchId: normalizedBatchId,
          status: 'DISABLED',
          productModel: model,
          monthKey: null,
          productionDate: timestamp,
          items: [],
          reason: 'PRODUCT_CODE_DISABLED',
        };
      }
      const missing = productCodeRuleMissingFields(rule);
      if (missing.length > 0) {
        return {
          batchId: normalizedBatchId,
          status: 'RULE_MISSING',
          productModel: model,
          monthKey: null,
          productionDate: timestamp,
          items: [],
          reason: `PRODUCT_CODE_RULE_MISSING:${missing.join(',')}`,
        };
      }
      if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error(`PRODUCT_CODE_BATCH_COUNT_INVALID:${count}`);

      const monthKey = productMonthlySerialKey(model, productionDate);
      const state = await this.load();
      if (normalizedBatchId) {
        const existing = state.allocations[normalizedBatchId];
        if (existing) {
          return {
            batchId: existing.batchId,
            status: 'GENERATED',
            productModel: existing.productModel,
            monthKey: existing.monthKey,
            productionDate: existing.productionDate,
            items: existing.items.map((item) => ({ ...item })),
          };
        }
      }

      const previous = Number(state.counters[monthKey]) || 0;
      const nextLast = previous + count;
      if (nextLast > 99999) throw new Error(`PRODUCT_CODE_SERIAL_EXHAUSTED:${monthKey}`);

      const items: ProductCodeAllocationItem[] = [];
      for (let offset = 1; offset <= count; offset += 1) {
        const serial = previous + offset;
        const generated = generateProductCode(rule, productionDate, serial);
        if (generated.status !== 'GENERATED' || !generated.code) {
          throw new Error(generated.reason || 'PRODUCT_CODE_GENERATION_FAILED_AFTER_ALLOCATION');
        }
        items.push({ slot: offset, serial, productCode: generated.code });
      }

      // 计数器和 batchId -> 编号绑定一次原子保存；后续业务失败不得回滚。
      state.counters[monthKey] = nextLast;
      if (normalizedBatchId) {
        state.allocations[normalizedBatchId] = {
          batchId: normalizedBatchId,
          status: 'GENERATED',
          productModel: model,
          monthKey,
          productionDate: timestamp,
          items,
          allocatedAt: Date.now(),
        };
      }
      state.updatedAt = Date.now();
      await this.save(state);

      return {
        batchId: normalizedBatchId,
        status: 'GENERATED',
        productModel: model,
        monthKey,
        productionDate: timestamp,
        items,
      };
    };

    // 同一进程内严格串行化占号，避免两个批次同时读取相同计数器。
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
