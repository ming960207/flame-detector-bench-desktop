import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FieldDetectorBatchVerdict } from './closure/field-detector-verdict.js';
import type { ProductionInspectionRecord } from './production-inspection-record.js';

export type LabelPrintJobStatus = 'WAITING' | 'PRINTING' | 'PRINTED' | 'FAILED' | 'BLOCKED';
export type LabelVerdict = 'A类合格' | 'B类合格' | '不合格';

export interface ProductLabelPrintJob {
  id: string;
  batchId: string;
  slot: number;
  productName: '点型红外火焰探测器';
  productModel: string;
  productCode: string | null;
  qrContent: string | null;
  verdict: LabelVerdict;
  isolation: boolean;
  productionDate: number;
  noiseValues: number[];
  status: LabelPrintJobStatus;
  attempts: number;
  reprintCount: number;
  workerId: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  printedAt: number | null;
}

interface LabelPrintQueueState {
  schemaVersion: 1;
  jobs: ProductLabelPrintJob[];
}

export interface LabelPrintQueueSummary {
  waiting: number;
  printing: number;
  printed: number;
  failed: number;
  blocked: number;
  total: number;
}

const EMPTY_STATE: LabelPrintQueueState = { schemaVersion: 1, jobs: [] };
const DEFAULT_LEASE_MS = 45_000;
const MAX_HISTORY = 500;

function safeClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jobId(batchId: string, slot: number): string {
  return `${batchId}:D${slot}`;
}

function labelVerdict(record: ProductionInspectionRecord, slot: number, detectorVerdict: FieldDetectorBatchVerdict): LabelVerdict {
  const product = record.products.find((item) => item.slot === slot);
  if (!product || product.verdict === '不合格') return '不合格';
  const detector = detectorVerdict.units.find((item) => item.index === slot);
  if (detector?.grade === 'A_PASS') return 'A类合格';
  if (detector?.grade === 'B_PASS') return 'B类合格';
  return '不合格';
}

function summary(jobs: ProductLabelPrintJob[]): LabelPrintQueueSummary {
  const count = (status: LabelPrintJobStatus) => jobs.filter((job) => job.status === status).length;
  return {
    waiting: count('WAITING'),
    printing: count('PRINTING'),
    printed: count('PRINTED'),
    failed: count('FAILED'),
    blocked: count('BLOCKED'),
    total: jobs.length,
  };
}

export class LabelPrintQueueStore {
  private loaded = false;
  private state: LabelPrintQueueState = safeClone(EMPTY_STATE);
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file = join(process.env.APP_DATA_DIR || process.cwd(), 'label-print-queue.json'),
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LabelPrintQueueState>;
      this.state = {
        schemaVersion: 1,
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs as ProductLabelPrintJob[] : [],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { await fs.rename(this.file, backup); } catch { /* best effort */ }
        console.error('[标签打印] 队列文件读取失败，已使用空队列:', error instanceof Error ? error.message : String(error));
      }
      this.state = safeClone(EMPTY_STATE);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, this.file);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationChain = this.mutationChain.then(async () => {
      try {
        await this.ensureLoaded();
        const value = await operation();
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    }, async () => {
      try {
        await this.ensureLoaded();
        const value = await operation();
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  async enqueueProductionRecord(record: ProductionInspectionRecord, detectorVerdict: FieldDetectorBatchVerdict): Promise<ProductLabelPrintJob[]> {
    return this.mutate(async () => {
      const now = Date.now();
      const created: ProductLabelPrintJob[] = [];
      for (const product of [...record.products].sort((a, b) => a.slot - b.slot)) {
        const id = jobId(record.batchId, product.slot);
        if (this.state.jobs.some((job) => job.id === id)) continue;
        const verdict = labelVerdict(record, product.slot, detectorVerdict);
        const hasCode = Boolean(product.productCode);
        const job: ProductLabelPrintJob = {
          id,
          batchId: record.batchId,
          slot: product.slot,
          productName: '点型红外火焰探测器',
          productModel: record.productModel,
          productCode: product.productCode,
          qrContent: product.productCode,
          verdict,
          isolation: verdict === '不合格',
          productionDate: record.productionDate,
          noiseValues: [...product.amplitude.values],
          status: hasCode ? 'WAITING' : 'BLOCKED',
          attempts: 0,
          reprintCount: 0,
          workerId: null,
          leaseUntil: null,
          lastError: hasCode ? null : 'PRODUCT_CODE_NOT_GENERATED',
          createdAt: now,
          updatedAt: now,
          printedAt: null,
        };
        this.state.jobs.push(job);
        created.push(safeClone(job));
      }
      if (this.state.jobs.length > MAX_HISTORY) {
        const protectedJobs = this.state.jobs.filter((job) => job.status !== 'PRINTED');
        const printedJobs = this.state.jobs.filter((job) => job.status === 'PRINTED').sort((a, b) => b.updatedAt - a.updatedAt);
        this.state.jobs = [...protectedJobs, ...printedJobs.slice(0, Math.max(0, MAX_HISTORY - protectedJobs.length))]
          .sort((a, b) => a.createdAt - b.createdAt);
      }
      await this.save();
      return created;
    });
  }

  private recoverExpiredLeases(now: number): boolean {
    let changed = false;
    for (const job of this.state.jobs) {
      if (job.status === 'PRINTING' && job.leaseUntil !== null && job.leaseUntil <= now) {
        job.status = 'WAITING';
        job.workerId = null;
        job.leaseUntil = null;
        job.lastError = 'PRINT_LEASE_EXPIRED';
        job.updatedAt = now;
        changed = true;
      }
    }
    return changed;
  }

  async claimNext(workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<ProductLabelPrintJob | null> {
    return this.mutate(async () => {
      const now = Date.now();
      const recovered = this.recoverExpiredLeases(now);
      const job = this.state.jobs
        .filter((item) => item.status === 'WAITING')
        .sort((a, b) => a.createdAt - b.createdAt || a.slot - b.slot)[0];
      if (!job) {
        if (recovered) await this.save();
        return null;
      }
      job.status = 'PRINTING';
      job.workerId = workerId;
      job.leaseUntil = now + Math.max(15_000, leaseMs);
      job.attempts += 1;
      job.lastError = null;
      job.updatedAt = now;
      await this.save();
      return safeClone(job);
    });
  }

  async markPrinted(id: string, workerId: string): Promise<ProductLabelPrintJob | null> {
    return this.mutate(async () => {
      const job = this.state.jobs.find((item) => item.id === id);
      if (!job) return null;
      if (job.status !== 'PRINTING' || (job.workerId && job.workerId !== workerId)) return safeClone(job);
      const now = Date.now();
      job.status = 'PRINTED';
      job.workerId = null;
      job.leaseUntil = null;
      job.lastError = null;
      job.printedAt = now;
      job.updatedAt = now;
      await this.save();
      return safeClone(job);
    });
  }

  async markFailed(id: string, workerId: string, error: string): Promise<ProductLabelPrintJob | null> {
    return this.mutate(async () => {
      const job = this.state.jobs.find((item) => item.id === id);
      if (!job) return null;
      if (job.status !== 'PRINTING' || (job.workerId && job.workerId !== workerId)) return safeClone(job);
      job.status = 'FAILED';
      job.workerId = null;
      job.leaseUntil = null;
      job.lastError = String(error || 'PRINT_FAILED').slice(0, 500);
      job.updatedAt = Date.now();
      await this.save();
      return safeClone(job);
    });
  }

  async retry(id: string): Promise<ProductLabelPrintJob | null> {
    return this.mutate(async () => {
      const job = this.state.jobs.find((item) => item.id === id);
      if (!job) return null;
      if (!job.productCode) {
        job.status = 'BLOCKED';
        job.lastError = 'PRODUCT_CODE_NOT_GENERATED';
      } else {
        if (job.status === 'PRINTED') job.reprintCount += 1;
        job.status = 'WAITING';
        job.lastError = null;
      }
      job.workerId = null;
      job.leaseUntil = null;
      job.updatedAt = Date.now();
      await this.save();
      return safeClone(job);
    });
  }

  async list(limit = 60): Promise<{ jobs: ProductLabelPrintJob[]; summary: LabelPrintQueueSummary }> {
    await this.mutationChain;
    await this.ensureLoaded();
    const now = Date.now();
    if (this.recoverExpiredLeases(now)) await this.save();
    const jobs = [...this.state.jobs]
      .sort((a, b) => b.createdAt - a.createdAt || a.slot - b.slot)
      .slice(0, Math.max(1, Math.min(500, limit)));
    return { jobs: safeClone(jobs), summary: summary(this.state.jobs) };
  }
}
