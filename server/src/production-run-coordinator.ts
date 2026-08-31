import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FieldStatusSnapshot } from './closure/field-status-server.js';
import type { PLCProcessStatus } from './process-status.js';
import type { ProductAwareFlameDetectorService } from './product-aware-flame-detector-service.js';
import {
  buildProductionInspectionRecord,
  ProductionInspectionRecordStore,
} from './production-inspection-record-store.js';
import {
  DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
  normalizeProductionInspectionRecordConfig,
  type ProductionInspectionRecord,
  type ProductionInspectionRecordConfig,
} from './production-inspection-record.js';

export interface ProductionRunArchive {
  schemaVersion: 1;
  batchId: string;
  archivedAt: number;
  productionDate: number;
  summary: FieldStatusSnapshot['summary'];
  flame: FieldStatusSnapshot['flame'];
  productContext: ReturnType<ProductAwareFlameDetectorService['getBatchContext']>;
  inspectionRecord: ProductionInspectionRecord;
}

function isFormalActive(status: PLCProcessStatus): boolean {
  return status.stage !== 'FAULT'
    && status.processStage !== 'IDLE'
    && status.processStage !== 'COMPLETE'
    && status.processStage !== 'UNKNOWN';
}

function isComplete(status: PLCProcessStatus): boolean {
  return status.complete || status.stage === 'COMPLETE' || status.processStage === 'COMPLETE';
}

function cloneRecordConfig(config: ProductionInspectionRecordConfig): ProductionInspectionRecordConfig {
  return JSON.parse(JSON.stringify(config)) as ProductionInspectionRecordConfig;
}

export class ProductionRunCoordinator {
  private recordConfig: ProductionInspectionRecordConfig = DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG;
  private capturedRecordConfig: ProductionInspectionRecordConfig | null = null;
  private batchStartedAt: number | null = null;
  private wasActive = false;
  private saving = new Set<string>();
  private saved = new Set<string>();

  constructor(
    private readonly snapshot: () => FieldStatusSnapshot,
    private readonly detectors: ProductAwareFlameDetectorService,
    private readonly recordStore = new ProductionInspectionRecordStore(),
    private readonly rawDirectory = join(process.env.APP_DATA_DIR || process.cwd(), 'production-records', 'raw'),
  ) {}

  setRecordConfig(config: ProductionInspectionRecordConfig): void {
    this.recordConfig = normalizeProductionInspectionRecordConfig(config, this.recordConfig);
  }

  getRecordConfig(): ProductionInspectionRecordConfig {
    return cloneRecordConfig(this.recordConfig);
  }

  observeStatus(status: PLCProcessStatus): void {
    const active = isFormalActive(status);
    if (active && !this.wasActive) {
      this.batchStartedAt = status.timestamp;
      this.capturedRecordConfig = cloneRecordConfig(this.recordConfig);

      // createFieldStatusRuntime registered its PLC listener before this coordinator,
      // therefore on the same automatic-run rising edge the snapshot already carries
      // the real FieldWaveformAnalysis batchId. Reserve six serials immediately here.
      const snapshot = this.snapshot();
      const batchId = snapshot.summary.waveformAnalysis.batchId;
      if (batchId) {
        void this.detectors.reserveFormalBatch(
          snapshot.summary.productConfig,
          batchId,
          status.timestamp,
        );
      } else {
        // Defensive fallback: precheck will allocate with this exact start timestamp.
        this.detectors.noteFormalBatchStartedAt(status.timestamp);
      }
    }
    this.wasActive = active;

    if (isComplete(status)) {
      // field-status runtime is registered first on the same EventEmitter; defer
      // one turn so snapshot() contains the just-completed waveform/final verdict.
      setTimeout(() => void this.archiveCompletedBatch(), 0);
    }
  }

  private async archiveCompletedBatch(): Promise<void> {
    const snapshot = this.snapshot();
    const batchId = snapshot.summary.waveformAnalysis.batchId;
    if (!batchId || snapshot.summary.waveformAnalysis.phase !== 'COMPLETE') return;
    if (this.saved.has(batchId) || this.saving.has(batchId)) return;
    this.saving.add(batchId);

    try {
      const context = this.detectors.getBatchContext(batchId);
      const productionDate = snapshot.summary.productPrecheck?.productionDate
        ?? context?.productionDate
        ?? this.batchStartedAt
        ?? snapshot.summary.waveformAnalysis.startedAt
        ?? Date.now();
      const record = buildProductionInspectionRecord({
        batchId,
        productConfig: snapshot.summary.productConfig,
        precheck: snapshot.summary.productPrecheck,
        detectorVerdict: snapshot.summary.detectorVerdict,
        waveformAnalysis: snapshot.summary.waveformAnalysis,
        recordConfig: this.capturedRecordConfig ?? this.recordConfig,
        productionDate,
      });

      await this.recordStore.save(record);
      await this.saveRawArchive({
        schemaVersion: 1,
        batchId,
        archivedAt: Date.now(),
        productionDate,
        summary: snapshot.summary,
        flame: snapshot.flame,
        productContext: context,
        inspectionRecord: record,
      });
      this.saved.add(batchId);
    } finally {
      this.saving.delete(batchId);
    }
  }

  private async saveRawArchive(archive: ProductionRunArchive): Promise<void> {
    await fs.mkdir(this.rawDirectory, { recursive: true });
    const safe = archive.batchId.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 120) || 'batch';
    const path = join(this.rawDirectory, `${safe}.raw.json`);
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, path);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  getStore(): ProductionInspectionRecordStore {
    return this.recordStore;
  }
}
