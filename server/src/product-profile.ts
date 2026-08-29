import type { ChannelKey, WaveformAnalysisConfig } from './closure/field-waveform-analysis.js';

export type ProductType = 'DUAL_WAVELENGTH' | 'THREE_WAVELENGTH' | 'FOUR_WAVELENGTH' | 'IMAGE_DETECTOR';
export type ProductPrecheckVerdict = 'PASS' | 'FAIL' | 'PENDING';

export interface ProductProfileConfig {
  label: string;
  expectedSoftwareVersion: string;
  expectedProbeCount: number;
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

export const DEFAULT_PRODUCT_DETECTION_CONFIG: ProductDetectionConfig = Object.freeze({
  selectedType: 'THREE_WAVELENGTH',
  profiles: {
    DUAL_WAVELENGTH: { label: '双波长', expectedSoftwareVersion: '', expectedProbeCount: 2 },
    THREE_WAVELENGTH: { label: '三波长', expectedSoftwareVersion: '', expectedProbeCount: 3 },
    FOUR_WAVELENGTH: { label: '四波长', expectedSoftwareVersion: '', expectedProbeCount: 4 },
    IMAGE_DETECTOR: { label: '图探型', expectedSoftwareVersion: '', expectedProbeCount: 3 },
  },
});

function isProductType(value: unknown): value is ProductType {
  return PRODUCT_TYPE_ORDER.includes(value as ProductType);
}

function cleanVersionInput(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
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
      expectedSoftwareVersion: cleanVersionInput(raw.expectedSoftwareVersion ?? base.expectedSoftwareVersion),
      expectedProbeCount: fixedProbeCount,
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
 * Keep the operator's waveform thresholds intact, but prevent a two-probe
 * product from being judged against P3. Three/four-probe products retain the
 * configured analysis behavior; explicit no-data checks cover every expected
 * probe later in the detector verdict.
 */
export function productAwareWaveformConfig(
  source: Partial<WaveformAnalysisConfig> | undefined,
  expectedProbeCount: number,
): Partial<WaveformAnalysisConfig> | undefined {
  if (!source || expectedProbeCount !== 2) return source;
  const allowed = new Set<ChannelKey>(['probe1', 'probe2']);
  const filter = (value: ChannelKey[] | undefined, fallback: ChannelKey[]) => {
    const next = (value ?? fallback).filter((key) => allowed.has(key));
    return next.length > 0 ? next : fallback;
  };
  const configuredRatio = source.interferenceRatio;
  const ratioValid = configuredRatio && allowed.has(configuredRatio.numerator) && allowed.has(configuredRatio.denominator);
  return {
    ...source,
    noiseProbes: filter(source.noiseProbes, ['probe1', 'probe2']),
    consistencyProbes: filter(source.consistencyProbes, ['probe1', 'probe2']),
    interferenceRatio: ratioValid ? configuredRatio : { numerator: 'probe2', denominator: 'probe1' },
  };
}
