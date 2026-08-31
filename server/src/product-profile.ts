import type { ChannelKey, WaveformAnalysisConfig } from './closure/field-waveform-analysis.js';
import {
  DEFAULT_PRODUCT_CODE_RULE,
  normalizeProductCodeRule,
  type ProductCodeRule,
} from './product-code.js';

export type ProductType = 'DUAL_WAVELENGTH' | 'THREE_WAVELENGTH' | 'FOUR_WAVELENGTH' | 'IMAGE_DETECTOR';
export type ProductPrecheckVerdict = 'PASS' | 'FAIL' | 'PENDING';

export interface ProductProfileConfig {
  label: string;
  /** 具体产品型号，用于自动编号流水号按型号独立计数。 */
  productModel: string;
  expectedSoftwareVersion: string;
  expectedProbeCount: number;
  /** 具体型号是否执行真实火警/故障继电器功能测试。关闭时记录表按业务规则填“合格”，后台标 DEFAULT_PASS。 */
  relayFunctionalTestEnabled: boolean;
  /** 产品编号规则。规则缺失只影响编号生成，不得阻塞正式检测流程。 */
  productCodeRule: ProductCodeRule;
}

export interface ProductDetectionConfig {
  selectedType: ProductType;
  profiles: Record<ProductType, ProductProfileConfig>;
}

export interface ProductPrecheckUnitResult {
  index: number;
  address: number;
  productType: ProductType;
  expectedSoftwareVersion: string;
  actualSoftwareVersion: string | null;
  expectedProbeCount: number;
  actualProbeCount: number | null;
  fireAlarm: boolean | null;
  fault: boolean | null;
  checkedAt: number;
  verdict: ProductPrecheckVerdict;
  reasons: string[];
}

export interface ProductPrecheckReport {
  batchId: string | null;
  productType: ProductType;
  productLabel: string;
  expectedSoftwareVersion: string;
  expectedProbeCount: number;
  startedAt: number;
  completedAt: number;
  verdict: ProductPrecheckVerdict;
  units: ProductPrecheckUnitResult[];
}

export const PRODUCT_TYPE_ORDER: readonly ProductType[] = [
  'DUAL_WAVELENGTH',
  'THREE_WAVELENGTH',
  'FOUR_WAVELENGTH',
  'IMAGE_DETECTOR',
] as const;

function rule(productNameCode = ''): ProductCodeRule {
  return {
    ...DEFAULT_PRODUCT_CODE_RULE,
    productNameCode,
    softwareVersionCode: '01',
    hardwareVersionCode: '01',
    producerCode: '01',
  };
}

/**
 * 默认型号按现有 02/03/04/05 产品槽位预置；所有字段均可在配置中永久修改。
 * 目前已知编码规则仅预置 02=4102、03=4103；04/05 保持空规则，且不会阻塞检测。
 */
export const DEFAULT_PRODUCT_DETECTION_CONFIG: ProductDetectionConfig = Object.freeze({
  selectedType: 'THREE_WAVELENGTH',
  profiles: {
    DUAL_WAVELENGTH: {
      label: '双波长',
      productModel: 'GHT-1050-02',
      expectedSoftwareVersion: '',
      expectedProbeCount: 2,
      relayFunctionalTestEnabled: false,
      productCodeRule: rule('4102'),
    },
    THREE_WAVELENGTH: {
      label: '三波长',
      productModel: 'GHT-1050-03',
      expectedSoftwareVersion: '',
      expectedProbeCount: 3,
      relayFunctionalTestEnabled: false,
      productCodeRule: rule('4103'),
    },
    FOUR_WAVELENGTH: {
      label: '四波长',
      productModel: 'GHT-1050-04',
      expectedSoftwareVersion: '',
      expectedProbeCount: 4,
      relayFunctionalTestEnabled: false,
      productCodeRule: rule(''),
    },
    IMAGE_DETECTOR: {
      label: '图探型',
      productModel: 'GHT-1050-05',
      expectedSoftwareVersion: '',
      expectedProbeCount: 3,
      relayFunctionalTestEnabled: false,
      productCodeRule: rule(''),
    },
  },
});

function isProductType(value: unknown): value is ProductType {
  return PRODUCT_TYPE_ORDER.includes(value as ProductType);
}

function cleanVersionInput(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
}

function cleanProductModel(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) || fallback : fallback;
}

export function canonicalSoftwareVersion(value: unknown): string {
  const text = cleanVersionInput(value)
    .replace(/^0x/i, '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  return text;
}

export function formatSoftwareVersion(value: unknown): string {
  const canonical = canonicalSoftwareVersion(value);
  if (canonical.length === 8) return canonical.match(/.{1,2}/g)?.join('.') ?? canonical;
  return cleanVersionInput(value) || '-';
}

export function softwareVersionMatches(expected: unknown, actual: unknown): boolean {
  const left = canonicalSoftwareVersion(expected);
  const right = canonicalSoftwareVersion(actual);
  return Boolean(left && right && left === right);
}

export function normalizeProductDetectionConfig(
  input: unknown,
  fallback: ProductDetectionConfig = DEFAULT_PRODUCT_DETECTION_CONFIG,
): ProductDetectionConfig {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const profilesSource = source.profiles && typeof source.profiles === 'object' && !Array.isArray(source.profiles)
    ? source.profiles as Record<string, unknown>
    : {};
  const profiles = {} as Record<ProductType, ProductProfileConfig>;

  for (const type of PRODUCT_TYPE_ORDER) {
    const base = fallback.profiles[type] ?? DEFAULT_PRODUCT_DETECTION_CONFIG.profiles[type];
    const raw = profilesSource[type] && typeof profilesSource[type] === 'object' && !Array.isArray(profilesSource[type])
      ? profilesSource[type] as Record<string, unknown>
      : {};
    const requestedProbeCount = Number(raw.expectedProbeCount);
    const fixedProbeCount = type === 'DUAL_WAVELENGTH' ? 2
      : type === 'THREE_WAVELENGTH' ? 3
        : type === 'FOUR_WAVELENGTH' ? 4
          : Number.isInteger(requestedProbeCount) && requestedProbeCount >= 1 && requestedProbeCount <= 4
            ? requestedProbeCount
            : base.expectedProbeCount;
    profiles[type] = {
      label: base.label,
      productModel: cleanProductModel(raw.productModel, base.productModel),
      expectedSoftwareVersion: cleanVersionInput(raw.expectedSoftwareVersion ?? base.expectedSoftwareVersion),
      expectedProbeCount: fixedProbeCount,
      relayFunctionalTestEnabled: typeof raw.relayFunctionalTestEnabled === 'boolean'
        ? raw.relayFunctionalTestEnabled
        : base.relayFunctionalTestEnabled,
      productCodeRule: normalizeProductCodeRule(raw.productCodeRule, base.productCodeRule),
    };
  }

  return {
    selectedType: isProductType(source.selectedType) ? source.selectedType : fallback.selectedType,
    profiles,
  };
}

export function selectedProductProfile(config: ProductDetectionConfig): ProductProfileConfig {
  return config.profiles[config.selectedType];
}

export function expectedProbeChannels(expectedProbeCount: number): ChannelKey[] {
  const count = Math.max(1, Math.min(4, Math.floor(Number(expectedProbeCount) || 3)));
  return (['probe1', 'probe2', 'probe3', 'probe4'] as ChannelKey[]).slice(0, count);
}

/**
 * A dual-wavelength product must be analyzed as a real two-channel system,
 * rather than by removing P3 from a three-channel operator selection. If the
 * old selection was P2/P3, simple filtering would leave only P2 and make trend
 * agreement impossible. Explicitly use P1+P2 for noise/trend and P2/P1 for the
 * interference ratio. Three/four-probe products keep their configured rules;
 * the detector verdict separately checks every expected probe for no-data.
 */
export function productAwareWaveformConfig(
  source: Partial<WaveformAnalysisConfig> | undefined,
  expectedProbeCount: number,
): Partial<WaveformAnalysisConfig> | undefined {
  if (!source || expectedProbeCount !== 2) return source;
  return {
    ...source,
    noiseProbes: ['probe1', 'probe2'],
    consistencyProbes: ['probe1', 'probe2'],
    interferenceRatio: { numerator: 'probe2', denominator: 'probe1' },
  };
}
