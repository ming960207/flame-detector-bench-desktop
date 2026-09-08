import { existsSync, promises as fs, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProductionInspectionProductResult } from './production-inspection-record.js';
import type { ProductionInspectionRecordStore } from './production-inspection-record-store.js';
import type { ProductionRunArchive } from './production-run-coordinator.js';

export interface MESConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  operatorName: string;
  requestTimeoutMs: number;
}

export interface MESFileReference {
  url?: string;
  fileName?: string;
  fileOriginName?: string;
  [key: string]: unknown;
}

export interface MESProductSubmission {
  productCode: string;
  inspectionStatus: 0 | 1;
  inspectionResult: string | null;
  jbrName: string;
  remark: string;
}

interface PendingMESProduct extends MESProductSubmission {
  uploaded: boolean;
}

interface PendingMESBatch {
  version: 1;
  batchId: string;
  reportFileName: string;
  reportHtml: string;
  files: MESFileReference[] | null;
  products: PendingMESProduct[];
  queuedAt: number;
}

interface MESApiResponse {
  code?: number | string;
  msg?: string;
  data?: unknown;
}

export interface MESPublicStatus {
  enabled: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  operatorName: string;
  requestTimeoutMs: number;
  pendingJobs: number;
  lastError?: string;
  lastUploadedAt?: number;
}

const DEFAULT_MES_BASE_URL = 'http://10.11.2.144:5051';
const DEFAULT_OUTBOX_FILE = join(process.env.APP_DATA_DIR || process.cwd(), 'mes-upload-outbox.json');
const REFERENCE_MES_CONFIG_FILE = 'D:\\code\\小工具\\MES对接\\relay-client\\mes_config.json';
const MES_RETRY_INTERVAL_MS = 30_000;

function referenceMESConfig(): { baseUrl?: string; apiKey?: string } {
  try {
    const source = JSON.parse(readFileSync(REFERENCE_MES_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    return {
      baseUrl: typeof source.mes_gateway === 'string' ? source.mes_gateway.trim() : undefined,
      apiKey: typeof source.mes_api_key === 'string' ? source.mes_api_key.trim() : undefined,
    };
  } catch {
    return {};
  }
}

export function defaultMESConfig(): MESConfig {
  const reference = referenceMESConfig();
  return {
    enabled: process.env.MES_ENABLED === 'true',
    baseUrl: process.env.MES_BASE_URL || reference.baseUrl || DEFAULT_MES_BASE_URL,
    apiKey: process.env.MES_API_KEY || reference.apiKey || '',
    operatorName: process.env.MES_OPERATOR_NAME || '',
    requestTimeoutMs: 15_000,
  };
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

export function normalizeMESConfig(input: unknown, fallback: MESConfig = defaultMESConfig()): MESConfig {
  const source = plainRecord(input);
  const timeout = Number(source.requestTimeoutMs);
  const baseUrl = text(source.baseUrl, fallback.baseUrl, 512).replace(/\/+$/, '');
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    baseUrl: baseUrl || fallback.baseUrl,
    apiKey: text(source.apiKey, fallback.apiKey, 512) || fallback.apiKey,
    operatorName: text(source.operatorName, fallback.operatorName, 64) || fallback.operatorName,
    requestTimeoutMs: Number.isFinite(timeout) ? Math.max(1_000, Math.min(60_000, Math.round(timeout))) : fallback.requestTimeoutMs,
  };
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'production-record';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asMESFiles(value: unknown): MESFileReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MESFileReference => Boolean(item && typeof item === 'object'));
}

export function buildMESProductPayload(
  product: MESProductSubmission,
  files: MESFileReference[],
): Record<string, unknown> {
  return {
    deviceCode: product.productCode,
    inspectionStatus: product.inspectionStatus,
    ...(product.inspectionResult ? { inspectionResult: product.inspectionResult } : {}),
    jbrName: product.jbrName,
    remark: product.remark,
    files: JSON.stringify(files),
  };
}

export class MESPublisher {
  private config: MESConfig;
  private readonly outboxFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly jobs = new Map<string, PendingMESBatch>();
  private queue: Promise<unknown> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | null = null;
  private lastError = '';
  private lastUploadedAt: number | undefined;

  constructor(config: MESConfig, options: { outboxFile?: string; fetchImpl?: typeof fetch } = {}) {
    this.config = normalizeMESConfig(config);
    this.outboxFile = options.outboxFile || DEFAULT_OUTBOX_FILE;
    this.fetchImpl = options.fetchImpl || fetch;
    this.loadOutbox();
    this.updateRetryTimer();
  }

  getConfig(): MESConfig {
    return { ...this.config };
  }

  getPublicStatus(): MESPublicStatus {
    return {
      enabled: this.config.enabled,
      baseUrl: this.config.baseUrl,
      apiKeyConfigured: Boolean(this.config.apiKey),
      operatorName: this.config.operatorName,
      requestTimeoutMs: this.config.requestTimeoutMs,
      pendingJobs: this.jobs.size,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastUploadedAt ? { lastUploadedAt: this.lastUploadedAt } : {}),
    };
  }

  updateConfig(input: unknown): MESPublicStatus {
    this.config = normalizeMESConfig(input, this.config);
    this.updateRetryTimer();
    if (this.config.enabled) void this.flush();
    return this.getPublicStatus();
  }

  close(): void {
    if (!this.retryTimer) return;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  async publishArchive(archive: ProductionRunArchive, recordStore: ProductionInspectionRecordStore): Promise<boolean> {
    if (!this.config.enabled) return false;
    return this.enqueue(async () => {
      try {
        let job = this.jobs.get(archive.batchId);
        if (!job) {
          job = await this.createJob(archive, recordStore);
          if (job.products.length === 0) return true;
          this.jobs.set(job.batchId, job);
          await this.saveOutbox();
        }
        return await this.processJob(job);
      } catch (error) {
        this.lastError = errorText(error);
        console.error(`[MES] 批次 ${archive.batchId} 上传失败:`, this.lastError);
        await this.saveOutbox();
        return false;
      }
    });
  }

  async flush(): Promise<void> {
    if (!this.config.enabled) return;
    await this.enqueue(async () => {
      for (const job of Array.from(this.jobs.values())) {
        await this.processJob(job);
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private updateRetryTimer(): void {
    if (!this.config.enabled) {
      this.close();
      return;
    }
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.jobs.size > 0) void this.flush();
    }, MES_RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  private loadOutbox(): void {
    if (!existsSync(this.outboxFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.outboxFile, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('MES_OUTBOX_FORMAT_INVALID');
      for (const value of parsed) {
        const job = value as Partial<PendingMESBatch>;
        if (!job.batchId || !Array.isArray(job.products) || typeof job.reportHtml !== 'string') continue;
        this.jobs.set(job.batchId, {
          version: 1,
          batchId: job.batchId,
          reportFileName: typeof job.reportFileName === 'string' ? job.reportFileName : `${safeName(job.batchId)}_生产检验记录.doc`,
          reportHtml: job.reportHtml,
          files: Array.isArray(job.files) ? asMESFiles(job.files) : null,
          products: job.products as PendingMESProduct[],
          queuedAt: Number(job.queuedAt) || Date.now(),
        });
      }
    } catch (error) {
      const preserved = `${this.outboxFile}.corrupt-${Date.now()}`;
      try { renameSync(this.outboxFile, preserved); } catch { /* best effort */ }
      this.lastError = `MES_OUTBOX_READ_FAILED:${errorText(error)}`;
      console.error('[MES] 待上传队列读取失败，原文件已尽量保留:', this.lastError);
    }
  }

  private async saveOutbox(): Promise<void> {
    await fs.mkdir(dirname(this.outboxFile), { recursive: true });
    const temporary = `${this.outboxFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(Array.from(this.jobs.values()), null, 2)}\n`, 'utf8');
      await fs.rename(temporary, this.outboxFile);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  private async createJob(archive: ProductionRunArchive, recordStore: ProductionInspectionRecordStore): Promise<PendingMESBatch> {
    const reportHtml = await recordStore.loadHtml(archive.batchId);
    if (!reportHtml) throw new Error('MES_REPORT_ATTACHMENT_NOT_FOUND');
    const record = archive.inspectionRecord;
    const jbrName = record.inspector.trim() || this.config.operatorName.trim();
    if (!jbrName) throw new Error('MES_OPERATOR_NAME_REQUIRED');
    const products = record.products
      .filter((product): product is ProductionInspectionProductResult & { productCode: string } => Boolean(product.productCode))
      .map((product) => ({
        productCode: product.productCode,
        inspectionStatus: product.verdict === '合格' ? 1 : 0,
        inspectionResult: product.verdict === '合格' ? null : `检测结果：${product.verdict}`,
        jbrName,
        remark: `检测台自动上传；型号：${record.productModel}；批次：${record.batchId}；槽位：D${product.slot}；结果：${product.verdict}`,
        uploaded: false,
      } satisfies PendingMESProduct));
    return {
      version: 1,
      batchId: archive.batchId,
      reportFileName: `${safeName(record.productModel)}_${safeName(record.batchId)}_生产检验记录.doc`,
      reportHtml,
      files: null,
      products,
      queuedAt: Date.now(),
    };
  }

  private async processJob(job: PendingMESBatch): Promise<boolean> {
    try {
      if (!this.config.apiKey) throw new Error('MES_API_KEY_REQUIRED');
      if (!job.files) {
        job.files = await this.uploadReport(job);
        await this.saveOutbox();
      }
      for (const product of job.products) {
        if (product.uploaded) continue;
        const result = await this.submitProduct(product, job.files);
        if (!result) throw new Error('MES_PRODUCT_UPLOAD_REJECTED');
        product.uploaded = true;
        await this.saveOutbox();
      }
      this.jobs.delete(job.batchId);
      await this.saveOutbox();
      this.lastError = '';
      this.lastUploadedAt = Date.now();
      console.log(`[MES] 批次 ${job.batchId} 已上传 ${job.products.length} 个产品编号，并关联检验报告附件。`);
      return true;
    } catch (error) {
      this.lastError = errorText(error);
      await this.saveOutbox();
      console.error(`[MES] 批次 ${job.batchId} 待重试:`, this.lastError);
      return false;
    }
  }

  private async uploadReport(job: PendingMESBatch): Promise<MESFileReference[]> {
    const form = new FormData();
    form.append('file', new Blob([job.reportHtml], { type: 'application/msword' }), job.reportFileName);
    const response = await this.request(`${this.config.baseUrl}/api/DeviceBom/UploadFile`, {
      method: 'POST',
      headers: { apikey: this.config.apiKey, Accept: 'application/json' },
      body: form,
    });
    if (Number(response.code) !== 1) throw new Error(`MES_ATTACHMENT_UPLOAD_FAILED:${response.msg || response.code || 'UNKNOWN'}`);
    const files = asMESFiles(response.data);
    if (files.length === 0) throw new Error('MES_ATTACHMENT_RESPONSE_EMPTY');
    return files;
  }

  private async submitProduct(product: PendingMESProduct, files: MESFileReference[]): Promise<boolean> {
    const payload = buildMESProductPayload(product, files);
    const response = await this.request(`${this.config.baseUrl}/api/ProductionRecord/BriefCreateOrUpdate`, {
      method: 'POST',
      headers: { apikey: this.config.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (Number(response.code) === 1) return true;
    const message = String(response.msg || '');
    if (/已入库|已存在/.test(message)) return true;
    throw new Error(`MES_PRODUCT_UPLOAD_FAILED:${message || response.code || 'UNKNOWN'}`);
  }

  private async request(url: string, init: RequestInit): Promise<MESApiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const raw = await response.text();
      let parsed: MESApiResponse;
      try {
        parsed = JSON.parse(raw) as MESApiResponse;
      } catch {
        throw new Error(`MES_RESPONSE_INVALID:${response.status}`);
      }
      if (!response.ok) throw new Error(`MES_HTTP_${response.status}:${parsed.msg || 'REQUEST_FAILED'}`);
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('MES_REQUEST_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export default MESPublisher;
