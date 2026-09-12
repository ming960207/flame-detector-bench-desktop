import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FieldDetectorBatchVerdict } from './closure/field-detector-verdict.js';
import type { FieldWaveformAnalysisSnapshot } from './closure/field-waveform-analysis.js';
import {
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from './product-profile.js';
import {
  autoStatus,
  fixedNotApplicableItems,
  indicatorVisionNotApplicable,
  measuredValue,
  notTested,
  recordConclusion,
  relayTestNotApplicable,
  type InspectionItemStatus,
  type IndicatorVisionInspectionValue,
  type InspectionStatusValue,
  type ProductionInspectionProductResult,
  type ProductionInspectionRecord,
  type ProductionInspectionRecordConfig,
} from './production-inspection-record.js';

export interface ProductionInspectionRecordBuildInput {
  batchId: string;
  productConfig: ProductDetectionConfig;
  precheck: ProductPrecheckReport | null;
  detectorVerdict: FieldDetectorBatchVerdict;
  waveformAnalysis: FieldWaveformAnalysisSnapshot;
  recordConfig: ProductionInspectionRecordConfig;
  productionDate: number;
}

function reasonText(reasons: string[]): string | undefined {
  return reasons.length > 0 ? reasons.join(';') : undefined;
}

function stageInterferencePassed(snapshot: FieldWaveformAnalysisSnapshot, index: number): boolean {
  const unit = snapshot.units.find((item) => item.index === index);
  if (!unit) return false;
  return (['heat', 'flash', 'emc'] as const).every((stage) => unit.stages[stage]?.verdict === 'PASS');
}

const REPORT_AMPLITUDE_CHANNELS = ['probe2', 'probe3'] as const;

function amplitudeValues(snapshot: FieldWaveformAnalysisSnapshot, index: number): number[] {
  const unit = snapshot.units.find((item) => item.index === index);
  if (!unit) return [];
  return REPORT_AMPLITUDE_CHANNELS
    .map((channel) => unit.noiseTest?.metrics?.[channel]?.fluctuation)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function amplitudePassed(snapshot: FieldWaveformAnalysisSnapshot, index: number): boolean {
  const unit = snapshot.units.find((item) => item.index === index);
  return Boolean(
    unit
    && unit.noiseTest?.verdict === 'PASS'
    && amplitudeValues(snapshot, index).length === REPORT_AMPLITUDE_CHANNELS.length,
  );
}

function indicatorVisionValue(
  report: ProductPrecheckReport['indicatorVision'] | null | undefined,
  slot: number,
): IndicatorVisionInspectionValue {
  if (!report) return indicatorVisionNotApplicable();
  const unit = report.units.find((item) => item.slot === slot);
  if (!unit) return indicatorVisionNotApplicable('INDICATOR_VISION_SLOT_MISSING');
  const lightStatus = (value: 'PASS' | 'FAIL' | 'PENDING', label: string) => value === 'PASS'
    ? autoStatus(true)
    : value === 'FAIL'
      ? autoStatus(false, `${label}_NOT_CONFIRMED`)
      : notTested(`${label}_SAMPLES_INSUFFICIENT`);
  const overall = unit.verdict === 'PASS'
    ? autoStatus(true)
    : unit.verdict === 'FAIL'
      ? autoStatus(false, 'INDICATOR_VISION_FAILED')
      : notTested('INDICATOR_VISION_SAMPLES_INSUFFICIENT');
  return {
    ...overall,
    runningGreen: lightStatus(unit.runningGreen, 'RUNNING_GREEN'),
    fireRed: lightStatus(unit.fireRed, 'FIRE_RED'),
    faultYellow: lightStatus(unit.faultYellow, 'FAULT_YELLOW'),
    captureCount: report.captureCount,
    phases: [...report.phases],
  };
}

function productVerdict(
  basePassed: boolean,
  statuses: InspectionItemStatus[],
): InspectionItemStatus {
  if (!basePassed) return '不合格';
  if (statuses.some((status) => status === '不合格')) return '不合格';
  if (statuses.some((status) => status === '未检测')) return '未检测';
  return '合格';
}

export function buildProductionInspectionRecord(input: ProductionInspectionRecordBuildInput): ProductionInspectionRecord {
  const profile = selectedProductProfile(input.productConfig);
  const allocation = input.precheck?.productCodeAllocation ?? null;
  const relay = input.precheck?.relayFunctionalTest ?? null;
  const products: ProductionInspectionProductResult[] = [];

  for (let slot = 1; slot <= 6; slot += 1) {
    const detector = input.detectorVerdict.units.find((unit) => unit.index === slot);
    const precheck = input.precheck?.units.find((unit) => unit.index === slot);
    const relayUnit = relay?.units.find((unit) => unit.detectorIndex === slot);
    const codeItem = allocation?.items.find((item) => item.slot === slot);
    const fixed = fixedNotApplicableItems();

    const fireAction = profile.relayFunctionalTestEnabled
      ? autoStatus(relayUnit?.alarm.verdict === 'PASS', reasonText(relayUnit?.alarm.reasons ?? ['RELAY_RESULT_MISSING']))
      : relayTestNotApplicable();
    const faultAction = profile.relayFunctionalTestEnabled
      ? autoStatus(relayUnit?.fault.verdict === 'PASS', reasonText(relayUnit?.fault.reasons ?? ['RELAY_RESULT_MISSING']))
      : relayTestNotApplicable();

    const amplitudes = amplitudeValues(input.waveformAnalysis, slot);
    const amplitudeOk = amplitudePassed(input.waveformAnalysis, slot);
    const softwareOk = Boolean(
      precheck
      && precheck.actualSoftwareVersion
      && !precheck.reasons.includes('SOFTWARE_VERSION_MISMATCH')
      && !precheck.reasons.includes('SOFTWARE_VERSION_NOT_CONFIGURED')
      && !precheck.reasons.includes('PRECHECK_READ_FAILED'),
    );
    const productInfoOk = Boolean(
      precheck
      && precheck.actualProbeCount === profile.expectedProbeCount
      && precheck.sensitivityLevel !== null
      && precheck.sensitivityLevel !== undefined,
    );
    const interferenceOk = stageInterferencePassed(input.waveformAnalysis, slot);
    const basePassed = detector?.verdict === 'PASS';
    const indicatorVision = indicatorVisionValue(input.precheck?.indicatorVision, slot);

    const softwareVersion = measuredValue(
      precheck?.actualSoftwareVersion ?? null,
      softwareOk,
      reasonText(precheck?.reasons.filter((reason) => reason.includes('SOFTWARE_VERSION') || reason === 'PRECHECK_READ_FAILED') ?? []),
    );
    const productInfo = measuredValue(
      {
        probeCount: precheck?.actualProbeCount ?? null,
        sensitivityLevel: precheck?.sensitivityLevel ?? detector?.metrics.sensitivity ?? null,
      },
      productInfoOk,
      productInfoOk ? undefined : 'PRODUCT_INFO_READ_OR_MATCH_FAILED',
    );
    const interferenceResistance = autoStatus(interferenceOk, interferenceOk ? undefined : 'INTERFERENCE_TEST_FAILED');
    const amplitude = {
      values: amplitudes,
      status: (amplitudeOk ? '合格' : '不合格') as InspectionItemStatus,
      source: 'AUTO' as const,
      ...(amplitudeOk ? {} : { reason: 'AMPLITUDE_OR_NOISE_TEST_FAILED' }),
    };

    products.push({
      slot,
      productCode: codeItem?.productCode ?? null,
      productCodeStatus: allocation?.status ?? 'RULE_MISSING',
      ...fixed,
      indicatorVision,
      fireAction,
      faultAction,
      amplitude,
      softwareVersion,
      productInfo,
      interferenceResistance,
      verdict: productVerdict(basePassed, [
        fireAction.status,
        faultAction.status,
        amplitude.status,
        softwareVersion.status,
        productInfo.status,
        interferenceResistance.status,
        ...(input.precheck?.indicatorVision ? [indicatorVision.status] : []),
      ]),
    });
  }

  return {
    schemaVersion: 1,
    batchId: input.batchId,
    productModel: profile.productModel,
    productionDate: input.productionDate,
    inspector: input.recordConfig.inspector,
    standard: input.recordConfig.standard,
    formNumber: input.recordConfig.formNumber,
    formVersion: input.recordConfig.formVersion,
    quantity: 6,
    products,
    conclusion: recordConclusion(products),
    generatedAt: Date.now(),
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function dateText(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function statusCell(status: InspectionItemStatus): string {
  const className = status === '合格'
    ? 'pass'
    : status === '不合格'
      ? 'fail'
      : status === '未检测'
        ? 'not-tested'
        : 'not-applicable';
  return `<span class="${className}">${status}</span>`;
}

function indicatorVisionCell(value: IndicatorVisionInspectionValue | undefined, fallback: InspectionStatusValue): string {
  const item = value ?? {
    ...fallback,
    runningGreen: fallback,
    fireRed: fallback,
    faultYellow: fallback,
    captureCount: 0,
    phases: [],
  };
  const detail = `绿灯 ${item.runningGreen.status} · 红灯 ${item.fireRed.status} · 黄灯 ${item.faultYellow.status} · 抓拍 ${item.captureCount} 张`;
  return `${statusCell(item.status)}<small class="vision-detail">${escapeHtml(detail)}</small>`;
}

function combinedStatus(statuses: InspectionItemStatus[]): InspectionItemStatus {
  if (statuses.some((status) => status === '不合格')) return '不合格';
  if (statuses.some((status) => status === '未检测')) return '未检测';
  if (statuses.some((status) => status === '不适用')) return '不适用';
  return '合格';
}

function productDefaultSettingsCell(product: ProductionInspectionProductResult): string {
  const status = combinedStatus([product.softwareVersion.status, product.productInfo.status]);
  const detail = `版本 ${product.softwareVersion.value ?? '-'} · 探头 ${product.productInfo.value.probeCount ?? '-'} · 灵敏度 ${product.productInfo.value.sensitivityLevel ?? '-'}`;
  return `${statusCell(status)}<small class="vision-detail">${escapeHtml(detail)}</small>`;
}

export function productionInspectionRecordHtml(record: ProductionInspectionRecord): string {
  const itemRows: Array<[string, (product: ProductionInspectionProductResult) => string]> = [
    ['工作电流检验', (p) => statusCell(p.workCurrent.status)],
    ['火警动作检验', (p) => statusCell(p.fireAction.status)],
    ['故障动作检验', (p) => statusCell(p.faultAction.status)],
    ['LED 显示检验', (p) => indicatorVisionCell(p.indicatorVision, p.ledDisplay)],
    ['幅值测试', (p) => `${escapeHtml(p.amplitude.values.join('，') || '-')} / ${statusCell(p.amplitude.status)}`],
    ['产品默认设置', productDefaultSettingsCell],
    ['抗干扰测试', (p) => statusCell(p.interferenceResistance.status)],
    ['电源波动试验', (p) => statusCell(p.powerFluctuation.status)],
    ['高温运行试验', (p) => statusCell(p.highTemp.status)],
    ['低温运行试验', (p) => statusCell(p.lowTemp.status)],
  ];

  const productHeaders = record.products.map((product) => `<th>产品${product.slot}</th>`).join('');
  const codeCells = record.products.map((product) => `<td>${escapeHtml(product.productCode ?? '未生成')}</td>`).join('');
  const rows = itemRows.map(([label, render], index) => `<tr><td>${index + 1}</td><td class="item">${escapeHtml(label)}</td>${record.products.map((product) => `<td>${render(product)}</td>`).join('')}</tr>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(record.productModel)}生产检验记录</title>
<style>
body{font-family:"Microsoft YaHei",Arial,sans-serif;color:#111;margin:24px;background:#fff}h1{text-align:center;font-size:22px;margin:0 0 14px}.meta{display:flex;justify-content:space-between;gap:12px;font-size:12px;margin:6px 0}.meta span{white-space:nowrap}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}th,td{border:1px solid #222;padding:7px 5px;text-align:center;vertical-align:middle}.item{text-align:left;font-weight:600}th:first-child,td:first-child{width:38px}th:nth-child(2),td:nth-child(2){width:175px}.pass{font-weight:700}.fail{font-weight:700;text-decoration:underline}.not-tested{font-weight:700;text-decoration:underline}.not-applicable{font-weight:600}.vision-detail{display:block;margin-top:3px;color:#555;font-size:10px;line-height:1.35}.footer{display:grid;grid-template-columns:2fr 1fr 1fr;margin-top:12px;border:1px solid #222}.footer>div{padding:10px;border-right:1px solid #222}.footer>div:last-child{border-right:0}@media print{body{margin:8mm}.no-print{display:none}}
</style></head><body>
<h1>点型红外火焰探测器生产检验记录</h1>
<div class="meta"><span>产品型号：${escapeHtml(record.productModel)}</span><span>检验数量：${record.quantity}</span><span>检验标准：${escapeHtml(record.standard)}</span></div>
<div class="meta"><span>表单编号：${escapeHtml(record.formNumber)}</span><span>版本：${escapeHtml(record.formVersion)}</span><span>批次：${escapeHtml(record.batchId)}</span></div>
<table><thead><tr><th>编号</th><th>检验内容</th>${productHeaders}</tr><tr><th></th><th>产品编号</th>${codeCells}</tr></thead><tbody>${rows}</tbody></table>
<div class="footer"><div>综合结论：${statusCell(record.conclusion)}</div><div>检验员：${escapeHtml(record.inspector || '-')}</div><div>日期：${dateText(record.productionDate)}</div></div>
</body></html>`;
}

function safeName(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 120) || 'batch';
}

export class ProductionInspectionRecordStore {
  constructor(private readonly directory = join(process.env.APP_DATA_DIR || process.cwd(), 'production-records')) {}

  private jsonPath(batchId: string): string { return join(this.directory, `${safeName(batchId)}.json`); }
  private htmlPath(batchId: string): string { return join(this.directory, `${safeName(batchId)}.html`); }
  private latestPath(): string { return join(this.directory, 'latest.json'); }

  async save(record: ProductionInspectionRecord): Promise<{ jsonPath: string; htmlPath: string }> {
    await fs.mkdir(this.directory, { recursive: true });
    const jsonPath = this.jsonPath(record.batchId);
    const htmlPath = this.htmlPath(record.batchId);
    const json = `${JSON.stringify(record, null, 2)}\n`;
    const html = productionInspectionRecordHtml(record);
    await this.atomicWrite(jsonPath, json);
    await this.atomicWrite(htmlPath, html);
    await this.atomicWrite(this.latestPath(), json);
    return { jsonPath, htmlPath };
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, path);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  async load(batchId: string): Promise<ProductionInspectionRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.jsonPath(batchId), 'utf8')) as ProductionInspectionRecord;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async loadLatest(): Promise<ProductionInspectionRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.latestPath(), 'utf8')) as ProductionInspectionRecord;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async loadHtml(batchId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.htmlPath(batchId), 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(limit = 50): Promise<Array<{ batchId: string; generatedAt: number; productModel: string; conclusion: InspectionItemStatus }>> {
    try {
      const names = (await fs.readdir(this.directory)).filter((name) => name.endsWith('.json') && name !== 'latest.json');
      const records: Array<{ batchId: string; generatedAt: number; productModel: string; conclusion: InspectionItemStatus }> = [];
      for (const name of names) {
        try {
          const record = JSON.parse(await fs.readFile(join(this.directory, name), 'utf8')) as ProductionInspectionRecord;
          records.push({ batchId: record.batchId, generatedAt: record.generatedAt, productModel: record.productModel, conclusion: record.conclusion });
        } catch { /* skip corrupt individual file */ }
      }
      return records.sort((a, b) => b.generatedAt - a.generatedAt).slice(0, Math.max(1, Math.min(200, limit)));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
}
