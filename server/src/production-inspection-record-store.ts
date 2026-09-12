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
  return statusCell(value?.status ?? fallback.status);
}

function combinedStatus(statuses: InspectionItemStatus[]): InspectionItemStatus {
  if (statuses.some((status) => status === '不合格')) return '不合格';
  if (statuses.some((status) => status === '未检测')) return '未检测';
  if (statuses.some((status) => status === '不适用')) return '不适用';
  return '合格';
}

function productDefaultSettingsCell(product: ProductionInspectionProductResult): string {
  const status = combinedStatus([product.softwareVersion.status, product.productInfo.status]);
  const detail = [
    `版本：${escapeHtml(product.softwareVersion.value ?? '-')}`,
    `探头：${escapeHtml(product.productInfo.value.probeCount ?? '-')}`,
    `灵敏度：${escapeHtml(product.productInfo.value.sensitivityLevel ?? '-')}`,
  ].join('<br>');
  return `${statusCell(status)}<br><span class="vision-detail">${detail}</span>`;
}

/**
 * 生成参考 WUTOS/IMS-JL836 格式的 Word 兼容表格文档。
 *
 * 文档内容是带 Word 命名空间的 HTML，使用 .doc 扩展名后可由 Word/WPS
 * 直接打开，同时保留浏览器预览和打印能力。表格列数跟随当前真实槽位数，
 * 当前检测台固定为 6 个槽位。
 */
export function productionInspectionRecordDocument(record: ProductionInspectionRecord): string {
  const itemRows: Array<[string, (product: ProductionInspectionProductResult) => string]> = [
    ['工作电流检验', (p) => statusCell(p.workCurrent.status)],
    ['火警动作检验', (p) => statusCell(p.fireAction.status)],
    ['故障动作检验', (p) => statusCell(p.faultAction.status)],
    ['LED 显示检验', (p) => indicatorVisionCell(p.indicatorVision, p.ledDisplay)],
    ['幅值测试', (p) => `${escapeHtml(p.amplitude.values.join('，') || '-')}<br>${statusCell(p.amplitude.status)}`],
    ['产品默认设置', productDefaultSettingsCell],
    ['抗干扰测试', (p) => statusCell(p.interferenceResistance.status)],
    ['电源波动试验', (p) => statusCell(p.powerFluctuation.status)],
    ['高温运行试验', (p) => statusCell(p.highTemp.status)],
    ['低温运行试验', (p) => statusCell(p.lowTemp.status)],
  ];

  const productCount = record.products.length;
  const productColumnWidth = (66 / Math.max(productCount, 1)).toFixed(2);
  const productHeaders = record.products.map((product) => `<th style="width: ${productColumnWidth}%">${product.slot}</th>`).join('');
  const codeCells = record.products.map((product) => `<td class="sample-code">${escapeHtml(product.productCode ?? '未生成')}</td>`).join('');
  const rows = itemRows.map(([label, render], index) => {
    const categoryCell = index === 0
      ? `<td rowspan="${itemRows.length}" class="v-text">生产检验项目</td>`
      : '';
    return `<tr>${categoryCell}<td class="index">${index + 1}</td><td class="item">${escapeHtml(label)}</td>${record.products.map((product) => `<td>${render(product)}</td>`).join('')}</tr>`;
  }).join('\n');
  const totalColumns = productCount + 3;

  return `\ufeff<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40" lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(record.productModel)} 点型红外火焰探测器检验记录表</title>
<!--[if gte mso 9]>
<xml>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml>
<![endif]-->
<style>
@page {
  size: 841.9pt 595.3pt;
  mso-page-orientation: landscape;
  margin: 19.85pt 34pt 19.85pt 34pt;
  mso-header-margin: 0pt;
  mso-footer-margin: 0pt;
}
@page Section1 {
  size: 841.9pt 595.3pt;
  mso-page-orientation: landscape;
  margin: 19.85pt 34pt 19.85pt 34pt;
  mso-header-margin: 0pt;
  mso-footer-margin: 0pt;
  mso-paper-source: 0;
}
div.Section1 { page: Section1; }
body {
  font-family: 'SimSun', '宋体', serif;
  font-size: 8.5pt;
  color: #000;
  margin: 0;
  padding: 0;
  line-height: 1.1;
}
p { margin: 0; padding: 0; }
.page-container { width: 100%; page-break-inside: avoid; }
.doc-title {
  text-align: center;
  font-size: 14pt;
  font-family: 'SimSun', '宋体', serif;
  font-weight: normal;
  letter-spacing: 1.5pt;
  margin: 0 0 3pt 0;
  line-height: 1.2;
}
.meta-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 2pt;
  font-size: 8.5pt;
  table-layout: fixed;
}
.meta-table td {
  border: 0;
  padding: 1pt 3pt;
  white-space: nowrap;
}
.w-table {
  width: 100%;
  border-collapse: collapse;
  border: 1.5pt solid #000;
  text-align: center;
  font-size: 8.5pt;
  table-layout: fixed;
  mso-padding-alt: 1.5pt 1pt 1.5pt 1pt;
}
.w-table td, .w-table th {
  border: 0.75pt solid #000;
  padding: 2pt 1.5pt;
  height: 20pt;
  vertical-align: middle;
  word-break: break-all;
  overflow: hidden;
}
.w-table th { font-weight: normal; }
.w-table .index { width: 4%; }
.w-table .item { width: 24%; text-align: left; padding-left: 4pt; }
.sample-code-label { text-align: left; padding-left: 4pt !important; }
.sample-code { white-space: nowrap !important; word-break: keep-all !important; font-size: 7.5pt; letter-spacing: -0.1pt; }
.t-left { text-align: left !important; padding-left: 4pt !important; }
.t-right { text-align: right !important; padding-right: 4pt !important; }
.no-wrap { white-space: nowrap !important; }
.v-text {
  writing-mode: vertical-lr;
  mso-direction-alt: auto;
  letter-spacing: 1pt;
  width: 6%;
  font-size: 8.5pt;
  padding: 1pt 0;
}
.pass { font-weight: 700; }
.fail { font-weight: 700; text-decoration: underline; }
.not-tested { font-weight: 700; text-decoration: underline; }
.not-applicable { font-weight: 600; }
.vision-detail {
  color: #444;
  font-size: 7.5pt;
  line-height: 1.15;
  white-space: normal;
}
@media screen {
  body { margin: 24px; background: #fff; }
  .w-table { font-size: 12px; }
  .w-table td, .w-table th { padding: 7px 5px; height: 28px; }
  .vision-detail { font-size: 10px; }
  .sample-code { font-size: 10px; letter-spacing: -0.2px; }
}
@media print { body { margin: 8mm; } }
</style>
</head>
<body>
<div class="Section1">
<div class="page-container">
  <div class="doc-title">${escapeHtml(record.productModel)}&nbsp;&nbsp;点型红外火焰探测器检验记录表</div>

  <table class="meta-table">
    <tr>
      <td style="width: 25%;" class="t-left">表单编号：${escapeHtml(record.formNumber)}</td>
      <td style="width: 25%;" class="t-left">版本：${escapeHtml(record.formVersion)}</td>
      <td style="width: 25%;" class="t-left">检验数量：${escapeHtml(record.quantity)} 台</td>
      <td style="width: 25%;" class="t-right">生产日期：${dateText(record.productionDate)}</td>
    </tr>
    <tr>
      <td colspan="2" class="t-left">检验依据：${escapeHtml(record.standard)}</td>
      <td class="t-left">批次：${escapeHtml(record.batchId)}</td>
      <td class="t-right">检验员：${escapeHtml(record.inspector || '-')}</td>
    </tr>
  </table>

  <table class="w-table">
    <colgroup>
      <col style="width: 6%;">
      <col style="width: 4%;">
      <col style="width: 24%;">
      ${record.products.map(() => `<col style="width: ${productColumnWidth}%;">`).join('')}
    </colgroup>
    <thead>
      <tr>
        <th colspan="3" style="height: 22pt;">编号<br>检验内容</th>
        ${productHeaders}
      </tr>
      <tr>
        <th></th>
        <th></th>
        <th class="sample-code-label">产品编号</th>
        ${codeCells}
      </tr>
    </thead>
    <tbody>
      ${rows}
      <tr>
        <td colspan="${totalColumns}" class="t-right no-wrap" style="height: 23pt;">
          检验结论：${statusCell(record.conclusion)}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;检验员：${escapeHtml(record.inspector || '-')} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;日期：${dateText(record.productionDate)}
        </td>
      </tr>
    </tbody>
  </table>
</div>
</div>
</body>
</html>`;
}

/** @deprecated 使用 productionInspectionRecordDocument，保留用于浏览器预览调用方。 */
export const productionInspectionRecordHtml = productionInspectionRecordDocument;

function safeName(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 120) || 'batch';
}

export class ProductionInspectionRecordStore {
  constructor(private readonly directory = join(process.env.APP_DATA_DIR || process.cwd(), 'production-records')) {}

  private jsonPath(batchId: string): string { return join(this.directory, `${safeName(batchId)}.json`); }
  private documentPath(batchId: string): string { return join(this.directory, `${safeName(batchId)}.doc`); }
  private legacyHtmlPath(batchId: string): string { return join(this.directory, `${safeName(batchId)}.html`); }
  private latestPath(): string { return join(this.directory, 'latest.json'); }

  async save(record: ProductionInspectionRecord): Promise<{ jsonPath: string; documentPath: string }> {
    await fs.mkdir(this.directory, { recursive: true });
    const jsonPath = this.jsonPath(record.batchId);
    const documentPath = this.documentPath(record.batchId);
    const json = `${JSON.stringify(record, null, 2)}\n`;
    const document = productionInspectionRecordDocument(record);
    await this.atomicWrite(jsonPath, json);
    await this.atomicWrite(documentPath, document);
    await this.atomicWrite(this.latestPath(), json);
    return { jsonPath, documentPath };
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

  async loadDocument(batchId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.documentPath(batchId), 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        return await fs.readFile(this.legacyHtmlPath(batchId), 'utf8');
      } catch (legacyError: any) {
        if (legacyError?.code === 'ENOENT') return null;
        throw legacyError;
      }
    }
  }

  /** @deprecated 使用 loadDocument；旧记录仍允许通过该别名预览。 */
  async loadHtml(batchId: string): Promise<string | null> {
    return this.loadDocument(batchId);
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
