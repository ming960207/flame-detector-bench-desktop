export interface ProductCodeRule {
  /** 是否尝试自动生成编号；规则缺失时不得阻塞检测流程。 */
  enabled: boolean;
  /** ABCC：4 位品名编码。空值表示当前型号尚未配置编码规则。 */
  productNameCode: string;
  /** EE：2 位软件版本编码，当前默认 01。 */
  softwareVersionCode: string;
  /** FF：2 位硬件版本编码，当前默认 02。 */
  hardwareVersionCode: string;
  /** GG：2 位生产部门编码，当前默认 01。 */
  producerCode: string;
}

export interface ProductCodeParts {
  productNameCode: string;
  productionPeriodCode: string;
  softwareVersionCode: string;
  hardwareVersionCode: string;
  producerCode: string;
  serial: string;
}

/** ERROR 表示编号基础设施异常；它与产品检测 PASS/FAIL 完全独立。 */
export type ProductCodeGenerationStatus = 'GENERATED' | 'RULE_MISSING' | 'DISABLED' | 'ERROR';

export interface ProductCodeGenerationResult {
  status: ProductCodeGenerationStatus;
  code: string | null;
  parts: ProductCodeParts | null;
  reason?: string;
}

export const DEFAULT_PRODUCT_CODE_RULE: Readonly<ProductCodeRule> = Object.freeze({
  enabled: true,
  productNameCode: '',
  softwareVersionCode: '01',
  hardwareVersionCode: '02',
  producerCode: '01',
});

function cleanSegment(value: unknown, length: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, length);
}

export function normalizeProductCodeRule(
  input: unknown,
  fallback: ProductCodeRule = DEFAULT_PRODUCT_CODE_RULE,
): ProductCodeRule {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    productNameCode: cleanSegment(source.productNameCode ?? fallback.productNameCode, 4),
    softwareVersionCode: cleanSegment(source.softwareVersionCode ?? fallback.softwareVersionCode, 2) || '01',
    hardwareVersionCode: cleanSegment(source.hardwareVersionCode ?? fallback.hardwareVersionCode, 2)
      || fallback.hardwareVersionCode
      || '02',
    producerCode: cleanSegment(source.producerCode ?? fallback.producerCode, 2) || '01',
  };
}

export function productCodeRuleMissingFields(rule: ProductCodeRule): string[] {
  const missing: string[] = [];
  if (!/^[0-9A-Z]{4}$/.test(rule.productNameCode)) missing.push('productNameCode');
  if (!/^[0-9A-Z]{2}$/.test(rule.softwareVersionCode)) missing.push('softwareVersionCode');
  if (!/^[0-9A-Z]{2}$/.test(rule.hardwareVersionCode)) missing.push('hardwareVersionCode');
  if (!/^[0-9A-Z]{2}$/.test(rule.producerCode)) missing.push('producerCode');
  return missing;
}

/**
 * 图片中的年份编码规则：2022 -> 01、2023 -> 02、...、2033 -> 12。
 * 因此按 year - 2021 转成两位十进制编码；超出 01..99 的年份拒绝生成，
 * 避免静默生成与企业规则冲突的编号。
 */
export function productionYearCode(date: Date): string {
  const sequence = date.getFullYear() - 2021;
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 99) {
    throw new Error(`PRODUCT_CODE_YEAR_OUT_OF_RANGE:${date.getFullYear()}`);
  }
  return String(sequence).padStart(2, '0');
}

/** 月份编码：1..9 -> 1..9，10 -> A，11 -> B，12 -> C。 */
export function productionMonthCode(date: Date): string {
  const month = date.getMonth() + 1;
  if (month >= 1 && month <= 9) return String(month);
  if (month === 10) return 'A';
  if (month === 11) return 'B';
  if (month === 12) return 'C';
  throw new Error(`PRODUCT_CODE_MONTH_INVALID:${month}`);
}

export function productionPeriodCode(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('PRODUCT_CODE_DATE_INVALID');
  return `${productionYearCode(date)}${productionMonthCode(date)}`;
}

/** 流水号按具体产品型号 + 自然年月独立，每月自动从 00001 开始。 */
export function productMonthlySerialKey(productModel: string, date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('PRODUCT_CODE_DATE_INVALID');
  const model = productModel.trim();
  if (!model) throw new Error('PRODUCT_MODEL_MISSING');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${model}@${date.getFullYear()}${month}`;
}

export function formatProductSerial(serial: number): string {
  if (!Number.isInteger(serial) || serial < 1 || serial > 99999) {
    throw new Error(`PRODUCT_SERIAL_OUT_OF_RANGE:${serial}`);
  }
  return String(serial).padStart(5, '0');
}

export function generateProductCode(
  rule: ProductCodeRule,
  date: Date,
  serial: number,
): ProductCodeGenerationResult {
  if (!rule.enabled) return { status: 'DISABLED', code: null, parts: null, reason: 'PRODUCT_CODE_DISABLED' };
  const missing = productCodeRuleMissingFields(rule);
  if (missing.length > 0) {
    return {
      status: 'RULE_MISSING',
      code: null,
      parts: null,
      reason: `PRODUCT_CODE_RULE_MISSING:${missing.join(',')}`,
    };
  }
  const parts: ProductCodeParts = {
    productNameCode: rule.productNameCode,
    productionPeriodCode: productionPeriodCode(date),
    softwareVersionCode: rule.softwareVersionCode,
    hardwareVersionCode: rule.hardwareVersionCode,
    producerCode: rule.producerCode,
    serial: formatProductSerial(serial),
  };
  const code = [
    parts.productNameCode,
    parts.productionPeriodCode,
    parts.softwareVersionCode,
    parts.hardwareVersionCode,
    parts.producerCode,
    parts.serial,
  ].join('');
  if (code.length !== 18) throw new Error(`PRODUCT_CODE_LENGTH_INVALID:${code}`);
  return { status: 'GENERATED', code, parts };
}
