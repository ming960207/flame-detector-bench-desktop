import type { FlameSample } from './flame-data-decoder.js';

type Probe = keyof FlameSample;
export type ProbeDisplaySource = Partial<Record<Probe | `${Probe}Fluctuation`, number | null>>;

/** Match the integer probe values displayed on the device card. */
export function displayedProbeValue(unit: ProbeDisplaySource | null | undefined, key: Probe): number | null {
  const value = unit?.[`${key}Fluctuation`] ?? unit?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(0)) : null;
}

export function probeRatio(numerator: number | null, denominator: number | null): number | null {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
}

export function displayedProbeRatios(unit: ProbeDisplaySource | null | undefined) {
  const p1 = displayedProbeValue(unit, 'probe1');
  const p2 = displayedProbeValue(unit, 'probe2');
  const p3 = displayedProbeValue(unit, 'probe3');
  const p4 = displayedProbeValue(unit, 'probe4');
  return { snr21: probeRatio(p2, p1), snr23: probeRatio(p2, p3), snr31: probeRatio(p3, p1), snr43: probeRatio(p4, p3) };
}
