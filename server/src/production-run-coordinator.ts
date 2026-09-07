import { EventEmitter } from 'node:events';
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

// PLC M11.2 uses T39 +100, i.e. a 10 s EMC window. Read software version at
// +8 s so the operation lives in the final two seconds without changing the
// waveform capture window or the EMC decision logic.
export const EMC_SOFTWARE_VERSION_READ_OFFSET_MS = 8_000;

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

export class ProductionRunCoordinator extends EventEmitter {
  private recordConfig: ProductionInspectionRecordConfig = DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG;
  private capturedRecordConfig: ProductionInspectionRecordConfig | null = null;
  private batchStartedAt: number | null = null;
  private emcStartedAt: number | null = null;
  private wasActive = false;
  private saving = new Set<string>();
  private saved = new Set<string>();
  private readonly versionChecks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly snapshot: () => FieldStatusSnapshot,
    private readonly detectors: ProductAwareFlameDetectorService,
    private readonly recordStore = new ProductionInspectionRecordStore(),
    private readonly rawDirectory = join(process.env.APP_DATA_DIR || process.cwd(), 'production-records', 'raw'),
  ) {
    super();
  }

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
      this.emcStartedAt = null;
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
        this.detectors.noteFormalBatchStartedAt(status.timestamp);
      }
    }
    this.wasActive = active;

    // Use the same PLC bit as FieldWaveformAnalysis. The EMC waveform is still
    // captured for the entire M11.2 high window; this side task neither clears
    // history nor pauses/re-arms the detector stream.
    const emcActive = status.io?.steps?.stepM11_2 === true;
    if (emcActive && this.emcStartedAt === null) this.emcStartedAt = status.timestamp;
    if (emcActive && this.emcStartedAt !== null
      && status.timestamp - this.emcStartedAt >= EMC_SOFTWARE_VERSION_READ_OFFSET_MS) {
      const snapshot = this.snapshot();
      const batchId = snapshot.summary.waveformAnalysis.batchId;
      if (batchId && !this.versionChecks.has(batchId)) {
        const check = this.detectors.finalizeProductPrecheckVersions(
          snapshot.summary.productConfig,
          batchId,
        ).then((report) => {
          // If position-one preparation was unexpectedly not ready yet, allow a
          // later status sample in the same final-two-second window to retry.
          if (!report) this.versionChecks.delete(batchId);
          return report;
        }).catch((error) => {
          this.versionChecks.delete(batchId);
          console.error('[生产检测] EMC末段软件版本读取失败:', error instanceof Error ? error.message : String(error));
          return null;
        });
        this.versionChecks.set(batchId, check);
      }
    }

    if (isComplete(status)) {
      // field-status runtime is registered first on the same EventEmitter; defer
      // one turn so snapshot() contains the just-completed waveform/final verdict.
      setTimeout(() => void this.archiveCompletedBatch(), 0);
    }
  }

  private async archiveCompletedBatch(): Promise<void> {
    let snapshot = this.snapshot();
    const batchId = snapshot.summary.waveformAnalysis.batchId;
    if (!batchId || snapshot.summary.waveformAnalysis.phase !== 'COMPLETE') return;
    if (this.saved.has(batchId) || this.saving.has(batchId)) return;
    this.saving.add(batchId);

    try {
      // A version request may begin near the end of M11.2 and still be resolving
      // when COMPLETE is observed. Await that already-started request, but never
      // start a new hardware version read after EMC has ended.
      const pendingVersionCheck = this.versionChecks.get(batchId);
      if (pendingVersionCheck) await pendingVersionCheck;
      snapshot = this.snapshot();

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
      const archive: ProductionRunArchive = {
        schemaVersion: 1,
        batchId,
        archivedAt: Date.now(),
        productionDate,
        summary: snapshot.summary,
        flame: snapshot.flame,
        productContext: context,
        inspectionRecord: record,
      };

      await this.recordStore.save(record);
      await this.saveRawArchive(archive);
      this.saved.add(batchId);
      this.emit('archive', archive);
    } catch (error) {
      // Do not emit Node's special `error` event: without a listener EventEmitter
      // rethrows it and can terminate the unified backend. Archive failure is a
      // recoverable production-record subsystem error, not a process-fatal error.
      this.emit('archive_error', error);
      console.error('[生产检验记录] 批次归档失败:', error instanceof Error ? error.message : String(error));
    } finally {
      this.saving.delete(batchId);
      this.versionChecks.delete(batchId);
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
