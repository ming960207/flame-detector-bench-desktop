import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  expectedProbeChannels,
  normalizeProductDetectionConfig,
  productAwareWaveformConfig,
  selectedProductProfile,
} from '../src/product-profile.js';

test('dual-wavelength production maps the two real optical channels to P2/P3', () => {
  const config = normalizeProductDetectionConfig(undefined, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const profile = selectedProductProfile(config);

  assert.equal(config.selectedType, 'DUAL_WAVELENGTH');
  assert.deepEqual(profile.activeChannels, ['probe2', 'probe3']);
  assert.deepEqual(expectedProbeChannels(profile.expectedProbeCount, profile.activeChannels), ['probe2', 'probe3']);

  const waveform = productAwareWaveformConfig({
    minNoiseSamples: 400,
    minInterferenceSamples: 80,
    minNoiseRms: 50,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    noiseProbes: ['probe1', 'probe2'],
    consistencyProbes: ['probe1', 'probe2'],
    interferenceRatio: { numerator: 'probe2', denominator: 'probe1' },
    quality: {
      acceptanceGrade: 'B',
      a: { maxNoiseRms: 180, maxNoiseAbsolute: 1000, maxInterferenceRatio: 1.5, minConsistencyTrend: 0.8, minSensitivity: 0 },
      b: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 1.5, minConsistencyTrend: 0.75, minSensitivity: 0 },
      ratios: {
        a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } },
        b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.48, max: 1.5 }, snr31: { min: 0, max: 0 } },
      },
    },
  }, profile)!;

  assert.deepEqual(waveform.noiseProbes, ['probe2', 'probe3']);
  assert.deepEqual(waveform.consistencyProbes, ['probe2', 'probe3']);
  assert.deepEqual(waveform.interferenceRatio, { numerator: 'probe2', denominator: 'probe3' });
  assert.equal(waveform.maxNoiseAbsolute, 0, 'raw absolute amplitude must remain diagnostic-only by default');
  assert.equal(waveform.quality?.a.maxNoiseAbsolute, 0);
  assert.equal(waveform.quality?.b.maxNoiseAbsolute, 0);
});

test('legacy count-only dual-wavelength path can no longer fall back to P1/P2', () => {
  assert.deepEqual(expectedProbeChannels(2), ['probe2', 'probe3']);
  const waveform = productAwareWaveformConfig({
    noiseProbes: ['probe1', 'probe2'],
    consistencyProbes: ['probe1', 'probe2'],
    interferenceRatio: { numerator: 'probe2', denominator: 'probe1' },
  }, 2)!;
  assert.deepEqual(waveform.noiseProbes, ['probe2', 'probe3']);
  assert.deepEqual(waveform.consistencyProbes, ['probe2', 'probe3']);
  assert.deepEqual(waveform.interferenceRatio, { numerator: 'probe2', denominator: 'probe3' });
});
