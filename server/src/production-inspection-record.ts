export type InspectionItemStatus = '合格' | '不合格';
export type InspectionItemSource = 'AUTO' | 'DEFAULT_PASS';

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

export interface ProductionInspectionProductResult {
  slot: number;
  productCode: string | null;
  productCodeStatus: 'GENERATED' | 'RULE_MISSING' | 'DISABLED';
  workCurrent: InspectionStatusValue;
  fireAction: InspectionStatusValue;
  faultAction: InspectionStatusValue;
  ledDisplay: InspectionStatusValue;
  amplitude: {
    /** 按 P1..Pn 顺序记录本批噪声窗口真实绝对幅值。 */
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

export function defaultPass(reason: string): InspectionStatusValue {
  return { status: '合格', source: 'DEFAULT_PASS', reason };
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

export function fixedDefaultPassItems() {
  return {
    workCurrent: defaultPass('BENCH_DOES_NOT_MEASURE_WORK_CURRENT'),
    ledDisplay: defaultPass('BENCH_DOES_NOT_MEASURE_LED_DISPLAY'),
    powerFluctuation: defaultPass('BENCH_DOES_NOT_MEASURE_POWER_FLUCTUATION'),
    highTemp: defaultPass('BENCH_DOES_NOT_MEASURE_HIGH_TEMPERATURE'),
    lowTemp: defaultPass('BENCH_DOES_NOT_MEASURE_LOW_TEMPERATURE'),
  };
}

export function relayDisabledDefaultPass(reason = 'RELAY_TEST_DISABLED'): InspectionStatusValue {
  return defaultPass(reason);
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
  return products.some((product) => product.verdict === '不合格') ? '不合格' : '合格';
}
