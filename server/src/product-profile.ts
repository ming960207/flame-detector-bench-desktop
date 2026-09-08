import type { ChannelKey, WaveformAnalysisConfig } from './closure/field-waveform-analysis.js';
import {
  normalizeProductCodeRule,
  type ProductCodeRule,
} from './product-code.js';
import type { ProductCodeAllocation } from './product-code-store.js';
import type { RelayFunctionalTestReport } from './relay-functional-test.js';
import profileDefaults from '../product-profiles.json' assert { type: 'json' };

export type ProductType = 'DUAL_WAVELENGTH' | 'THREE_WAVELENGTH' | 'FOUR_WAVELENGTH' | 'IMAGE_DETECTOR';
export type ProductPrecheckVerdict = 'PASS' | 'FAIL' | 'PENDING';

export interface ProductProfileConfig {
  label: string;
  /** 具体产品型号，用于自动编号流水号按型号独立计数。 */
  productModel: string;
  expectedSoftwareVersion: string;
  /** 勾选后仍发送版本读取指令并记录实际版本，但版本结果不参与 PASS/FAIL 判定。 */
  skipSoftwareVersionCheck: boolean;
  expectedProbeCount: number;
  /** 真实参与定量判定的物理通道；不能再通过“探头数量=前N路”推断。 */
  activeChannels?: ChannelKey[];
  /** 噪声判定通道。 */
  noiseProbes?: ChannelKey[];
  /** 趋势一致性判定通道。 */
  consistencyProbes?: ChannelKey[];
  /** 干扰比的分子/分母通道。 */
  interferenceRatio?: { numerator: ChannelKey; denominator: ChannelKey };
  /** 是否把原始绝对幅值作为 NG 条件；默认关闭，仅记录诊断值。 */
  judgeNoiseAbsolute?: boolean;
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
  /** 预检阶段从 0x0000 读取；旧路径未读取时为空。 */
  sensitivityLevel?: number | null;
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
  productModel?: string;
  expectedSoftwareVersion: string;
  expectedProbeCount: number;
  productionDate?: number;
  productCodeAllocation?: ProductCodeAllocation | null;
  relayFunctionalTest?: RelayFunctionalTestReport | null;
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

const CHANNEL_KEYS: readonly ChannelKey[] = ['probe1', 'probe2', 'probe3', 'probe4'];

function defaultActiveChannels(type: ProductType, expectedProbeCount: number): ChannelKey[] {
  if (type === 'DUAL_WAVELENGTH' || expectedProbeCount === 2) return ['probe2', 'probe3'];
  const count = Math.max(1, Math.min(4, Math.floor(Number(expectedProbeCount) || 3)));
  return CHANNEL_KEYS.slice(0, count);
}

function defaultInterferenceRatio(type: ProductType, activeChannels: ChannelKey[]): { numerator: ChannelKey; denominator: ChannelKey } {
  if (type === 'DUAL_WAVELENGTH' || (activeChannels.includes('probe2') && activeChannels.includes('probe3'))) {
    return { numerator: 'probe2', denominator: 'probe3' };
  }
  return {
    numerator: activeChannels[1] ?? activeChannels[0] ?? 'probe2',
    denominator: activeChannels[0] ?? 'probe1',
  };
}

function normalizedChannels(value: unknown, fallback: ChannelKey[]): ChannelKey[] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set(CHANNEL_KEYS);
  const result = [...new Set(value.filter((item): item is ChannelKey => allowed.has(item as ChannelKey)))];
  return result.length > 0 ? result : [...fallback];
}

function normalizedRatio(
  value: unknown,
  fallback: { numerator: ChannelKey; denominator: ChannelKey },
): { numerator: ChannelKey; denominator: ChannelKey } {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const numerator = CHANNEL_KEYS.includes(source.numerator as ChannelKey) ? source.numerator as ChannelKey : fallback.numerator;
  const denominator = CHANNEL_KEYS.includes(source.denominator as ChannelKey) ? source.denominator as ChannelKey : fallback.denominator;
  return { numerator, denominator };
}

/**
 * Product/model/probe mappings are data, not code. Edit server/product-profiles.json
 * for a deployment-specific mapping; persisted system-config values can still
 * override these values through the configuration UI.
 */
export const DEFAULT_PRODUCT_DETECTION_CONFIG: ProductDetectionConfig = Object.freeze(
  profileDefaults as ProductDetectionConfig,
);

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
    const fixedProbeCount = Number.isInteger(requestedProbeCount) && requestedProbeCount >= 1 && requestedProbeCount <= 4
      ? requestedProbeCount
      : base.expectedProbeCount;
    const defaultActive = defaultActiveChannels(type, fixedProbeCount);
    const baseActive = normalizedChannels(base.activeChannels, defaultActive);
    const activeChannels = normalizedChannels(raw.activeChannels, baseActive);
    const noiseProbes = normalizedChannels(raw.noiseProbes, normalizedChannels(base.noiseProbes, activeChannels));
    const consistencyProbes = normalizedChannels(raw.consistencyProbes, normalizedChannels(base.consistencyProbes, activeChannels));
    const baseRatio = normalizedRatio(base.interferenceRatio, defaultInterferenceRatio(type, activeChannels));
    const interferenceRatio = normalizedRatio(raw.interferenceRatio, baseRatio);

    profiles[type] = {
      label: base.label,
      productModel: cleanProductModel(raw.productModel, base.productModel),
      expectedSoftwareVersion: cleanVersionInput(raw.expectedSoftwareVersion ?? base.expectedSoftwareVersion),
      skipSoftwareVersionCheck: typeof raw.skipSoftwareVersionCheck === 'boolean'
        ? raw.skipSoftwareVersionCheck
        : Boolean(base.skipSoftwareVersionCheck),
      expectedProbeCount: fixedProbeCount,
      activeChannels,
      noiseProbes,
      consistencyProbes,
      interferenceRatio,
      judgeNoiseAbsolute: typeof raw.judgeNoiseAbsolute === 'boolean'
        ? raw.judgeNoiseAbsolute
        : Boolean(base.judgeNoiseAbsolute),
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

export function expectedProbeChannels(expectedProbeCount: number, configuredChannels?: ChannelKey[]): ChannelKey[] {
  if (configuredChannels?.length) return normalizedChannels(configuredChannels, defaultActiveChannels('THREE_WAVELENGTH', expectedProbeCount));
  if (expectedProbeCount === 2) return ['probe2', 'probe3'];
  const count = Math.max(1, Math.min(4, Math.floor(Number(expectedProbeCount) || 3)));
  return CHANNEL_KEYS.slice(0, count);
}

/**
 * Apply the selected product's physical-channel map to the quantitative analyzer.
 * Real-hardware evidence for 90.22.09.15 dual-wavelength units shows that P2/P3 are
 * the two optical channels while P1 remains near a fixed single-digit carrier value.
 * Therefore a two-channel product must never be inferred as P1/P2 by array slicing.
 *
 * Raw absolute amplitude is still recorded for diagnostics. Unless a product profile
 * explicitly opts in, it is not a product-NG criterion. Noise has no lower reject
 * bound: a quieter detector is better, so production only enforces the configured
 * upper fluctuation/RMS limits after baseline removal.
 */
export function productAwareWaveformConfig(
  source: Partial<WaveformAnalysisConfig> | undefined,
  profileOrProbeCount: ProductProfileConfig | number,
): Partial<WaveformAnalysisConfig> | undefined {
  if (!source) return source;

  const profile = typeof profileOrProbeCount === 'number' ? undefined : profileOrProbeCount;
  const expectedProbeCount = typeof profileOrProbeCount === 'number'
    ? profileOrProbeCount
    : profileOrProbeCount.expectedProbeCount;
  const inferredType: ProductType = expectedProbeCount === 2 ? 'DUAL_WAVELENGTH' : 'THREE_WAVELENGTH';
  const activeChannels = expectedProbeChannels(expectedProbeCount, profile?.activeChannels);
  const noiseProbes = normalizedChannels(profile?.noiseProbes, activeChannels);
  const consistencyProbes = normalizedChannels(profile?.consistencyProbes, activeChannels);
  const interferenceRatio = normalizedRatio(
    profile?.interferenceRatio,
    defaultInterferenceRatio(inferredType, activeChannels),
  );
  const judgeNoiseAbsolute = profile?.judgeNoiseAbsolute === true;
  const quality = source.quality
    ? {
      ...source.quality,
      a: { ...source.quality.a, ...(judgeNoiseAbsolute ? {} : { maxNoiseAbsolute: 0 }) },
      b: { ...source.quality.b, ...(judgeNoiseAbsolute ? {} : { maxNoiseAbsolute: 0 }) },
    }
    : source.quality;

  return {
    ...source,
    minNoiseRms: 0,
    ...(judgeNoiseAbsolute ? {} : { maxNoiseAbsolute: 0 }),
    noiseProbes,
    consistencyProbes,
    interferenceRatio,
    quality,
  };
}
