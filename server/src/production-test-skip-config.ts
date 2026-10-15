export interface ProductionTestSkipConfig {
  indicatorVision: boolean;
  relayFunctionalTest: boolean;
  noise: boolean;
  heat: boolean;
  flash: boolean;
  emc: boolean;
}

export const DEFAULT_PRODUCTION_TEST_SKIP_CONFIG: ProductionTestSkipConfig = Object.freeze({
  indicatorVision: false,
  relayFunctionalTest: false,
  noise: false,
  heat: false,
  flash: false,
  emc: false,
});

export function normalizeProductionTestSkipConfig(
  value: unknown,
  fallback: ProductionTestSkipConfig = DEFAULT_PRODUCTION_TEST_SKIP_CONFIG,
): ProductionTestSkipConfig {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    indicatorVision: typeof source.indicatorVision === 'boolean' ? source.indicatorVision : fallback.indicatorVision,
    relayFunctionalTest: typeof source.relayFunctionalTest === 'boolean' ? source.relayFunctionalTest : fallback.relayFunctionalTest,
    noise: typeof source.noise === 'boolean' ? source.noise : fallback.noise,
    heat: typeof source.heat === 'boolean' ? source.heat : fallback.heat,
    flash: typeof source.flash === 'boolean' ? source.flash : fallback.flash,
    emc: typeof source.emc === 'boolean' ? source.emc : fallback.emc,
  };
}
