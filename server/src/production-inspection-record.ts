import type { ProductCodeGenerationStatus } from './product-code.js';

export type InspectionItemStatus = '合格' | '不合格' | '未检测' | '不适用';
export type InspectionItemSource = 'AUTO' | 'NOT_TESTED' | 'NOT_APPLICABLE';

export interface ProductionInspectionRecordConfig {
  inspector: string;
  standard: string;
  formNumber: string;
  formVersion: string;
}

export const DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG: Readonly<ProductionInspectionRecordConfig> = Object.freeze({
  inspector: '',
  standard: 'GB15631－2008',
  formNumber: 'WUTOS/IMS-JL836',
  formVersion: 'A/0',
});

export interface InspectionStatusValue {
  status: InspectionItemStatus;
  source: InspectionItemSource;
  reason?: string;
}

export interface InspectionMeasuredValue<T> extends InspectionStatusValue {
  value: T;
}

export interface IndicatorVisionInspectionValue extends InspectionStatusValue {
  runningGreen: InspectionStatusValue;
  fireRed: InspectionStatusValue;
  faultYellow: InspectionStatusValue;
  captureCount: number;
  phases: string[];
}

export interface ProductionInspectionProductResult {
  slot: number;
  productCode: string | null;
  /** 编号状态只用于追溯，不参与产品合格/不合格判定。 */
  productCodeStatus: ProductCodeGenerationStatus;
  workCurrent: InspectionStatusValue;
  fireAction: InspectionStatusValue;
  faultAction: InspectionStatusValue;
  ledDisplay: InspectionStatusValue;
  /** 摄像头按槽位记录的运行绿/火警红/故障黄视觉证据。 */
  indicatorVision?: IndicatorVisionInspectionValue;
  amplitude: {
    /** 按 P2、P3 顺序记录本批噪声窗口的相对波动值。 */
    values: number[];
    status: InspectionItemStatus;
    source: 'AUTO';
    reason?: string;
  };
  softwareVersion: InspectionMeasuredValue<string | null>;
  productInfo: InspectionMeasuredValue<{
    probeCount: number | null;
    sensitivityLevel: number | string | null;
  }>;
  interferenceResistance: InspectionStatusValue;
  powerFluctuation: InspectionStatusValue;
  highTemp: InspectionStatusValue;
  lowTemp: InspectionStatusValue;
  verdict: InspectionItemStatus;
}

export interface ProductionInspectionRecord {
  schemaVersion: 1;
  batchId: string;
  productModel: string;
  productionDate: number;
  inspector: string;
  standard: string;
  formNumber: string;
  formVersion: string;
  quantity: number;
  products: ProductionInspectionProductResult[];
  conclusion: InspectionItemStatus;
  generatedAt: number;
}

export function notTested(reason: string): InspectionStatusValue {
  return { status: '未检测', source: 'NOT_TESTED', reason };
}

export function notApplicable(reason: string): InspectionStatusValue {
  return { status: '不适用', source: 'NOT_APPLICABLE', reason };
}

export function indicatorVisionNotApplicable(reason = 'INDICATOR_VISION_NOT_SUBMITTED'): IndicatorVisionInspectionValue {
  return {
    ...notApplicable(reason),
    runningGreen: notApplicable(reason),
    fireRed: notApplicable(reason),
    faultYellow: notApplicable(reason),
    captureCount: 0,
    phases: [],
  };
}

export function autoStatus(passed: boolean, reason?: string): InspectionStatusValue {
  return {
    status: passed ? '合格' : '不合格',
    source: 'AUTO',
    ...(reason ? { reason } : {}),
  };
}

export function measuredValue<T>(value: T, passed: boolean, reason?: string): InspectionMeasuredValue<T> {
  return {
    value,
    ...autoStatus(passed, reason),
  };
}

/**
 * The paper form requires the supplementary items to be filled as PASS. They are
 * deliberately kept out of the automatic product verdict because this bench does
 * not measure those items yet.
 */
export function fixedNotApplicableItems() {
  return {
    workCurrent: autoStatus(true, 'SUPPLEMENTARY_ITEM_DEFAULT_PASS'),
    ledDisplay: notApplicable('BENCH_DOES_NOT_MEASURE_LED_DISPLAY'),
    powerFluctuation: autoStatus(true, 'SUPPLEMENTARY_ITEM_DEFAULT_PASS'),
    highTemp: autoStatus(true, 'SUPPLEMENTARY_ITEM_DEFAULT_PASS'),
    lowTemp: autoStatus(true, 'SUPPLEMENTARY_ITEM_DEFAULT_PASS'),
  };
}

/**
 * relayFunctionalTestEnabled=false means this product profile does not require the
 * relay functional test in the current bench recipe. Record N/A rather than PASS.
 * When the profile enables the relay test, callers must supply real AUTO evidence.
 */
export function relayTestNotApplicable(reason = 'RELAY_TEST_NOT_REQUIRED_FOR_PROFILE'): InspectionStatusValue {
  return notApplicable(reason);
}

export function normalizeProductionInspectionRecordConfig(
  input: unknown,
  fallback: ProductionInspectionRecordConfig = DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG,
): ProductionInspectionRecordConfig {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const text = (value: unknown, base: string, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : base;
  return {
    inspector: text(source.inspector, fallback.inspector, 64),
    standard: text(source.standard, fallback.standard, 128) || fallback.standard,
    formNumber: text(source.formNumber, fallback.formNumber, 64) || fallback.formNumber,
    formVersion: text(source.formVersion, fallback.formVersion, 32) || fallback.formVersion,
  };
}

export function recordConclusion(products: ProductionInspectionProductResult[]): InspectionItemStatus {
  if (products.some((product) => product.verdict === '不合格')) return '不合格';
  if (products.some((product) => product.verdict === '未检测')) return '未检测';
  return '合格';
}
