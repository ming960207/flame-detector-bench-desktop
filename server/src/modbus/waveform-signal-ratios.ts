import type { FlameSample } from './flame-data-decoder.js';

export const SIGNAL_RATIO_WINDOW_MS = 1_000;
export interface SignalRatioFrame { timestamp: number; samples: FlameSample[] }
type Channel = keyof FlameSample;

/** Both amplitudes use the same paired samples and sample indices in one window. */
export function detrendedAmplitudeRatio(samples: FlameSample[], numerator: Channel, denominator: Channel): number | null {
  const points = samples.map((sample, x) => ({ x, a: sample[numerator], b: sample[denominator] }))
    .filter((p): p is { x: number; a: number; b: number } => Number.isFinite(p.a) && Number.isFinite(p.b));
  if (points.length < 3) return null;
  const xMean = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const variance = points.reduce((sum, p) => sum + (p.x - xMean) ** 2, 0);
  const amplitude = (key: 'a' | 'b') => {
    const mean = points.reduce((sum, p) => sum + p[key], 0) / points.length;
    const slope = points.reduce((sum, p) => sum + (p.x - xMean) * (p[key] - mean), 0) / variance;
    const residuals = points.map(p => p[key] - mean - slope * (p.x - xMean));
    return (Math.max(...residuals) - Math.min(...residuals)) / 2;
  };
  const b = amplitude('b');
  return b > 1e-6 ? amplitude('a') / b : null;
}

export function synchronizedSignalRatios(frames: SignalRatioFrame[]) {
  const samples = frames.flatMap(frame => frame.samples);
  return {
    snr21: detrendedAmplitudeRatio(samples, 'probe2', 'probe1'),
    snr23: detrendedAmplitudeRatio(samples, 'probe2', 'probe3'),
    snr31: detrendedAmplitudeRatio(samples, 'probe3', 'probe1'),
    snr43: detrendedAmplitudeRatio(samples, 'probe4', 'probe3'),
  };
}
