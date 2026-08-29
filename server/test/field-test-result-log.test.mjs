import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { FileFieldTestResultLogger } from '../dist/closure/field-test-result-log.js';

test('completed test log renders concise tables with device values and every process stage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'field-test-log-'));
  try {
    const logger = new FileFieldTestResultLogger(directory);
    const file = logger.record({
      batchId: 'batch-001',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      finalVerdict: { verdict: 'FAIL', grade: 'FAIL' },
      detectorVerdict: {
        verdict: 'FAIL', grade: 'FAIL', timestamp: 1_700_000_001_000,
        units: [
          { index: 1, address: 1, verdict: 'FAIL', grade: 'FAIL', reason: 'SNR23_ABOVE_LIMIT', sampledAt: 9,
            metrics: { noiseRms: 1, noisePeakToPeak: 2, noiseAbsolute: 3, interferenceRatio: 1.1, consistencyTrend: 0.9, snr21: 1, snr23: 1.8, snr31: 1, sensitivity: 5 } },
          { index: 2, address: 1, verdict: 'PASS', grade: 'A_PASS', reason: 'A_GRADE_WITHIN_LIMIT', sampledAt: 9,
            metrics: { noiseRms: 1, noisePeakToPeak: 2, noiseAbsolute: 3, interferenceRatio: 1.1, consistencyTrend: 0.9, snr21: 1, snr23: 1, snr31: 1, sensitivity: 5 } },
        ],
      },
      thresholds: {
        minNoiseSamples: 5, minInterferenceSamples: 5, maxNoiseRms: 200, maxInterferenceRatio: 1.5,
        quality: {
          a: { maxNoiseRms: 100, maxNoiseAbsolute: 500, maxInterferenceRatio: 1.2, minConsistencyTrend: 0.8, minSensitivity: 1 },
          b: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 1.5, minConsistencyTrend: 0.7, minSensitivity: 0.5 },
          detectors: {
            '1': { a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.6, max: 1.4 }, snr31: { min: 0, max: 0 } }, b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } } },
            '2': { a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } }, b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } } },
          },
        },
      },
      waveformAnalysis: {
        phase: 'COMPLETE', processStage: 'COMPLETE', verdict: 'FAIL',
        startedAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000,
        units: [{
          index: 1, noiseSampleCount: 30, interferenceSampleCount: 90, reason: 'SNR23_ABOVE_LIMIT',
          stages: {
            heat: { verdict: 'PASS', reason: 'STAGE_WITHIN_LIMIT', sampleCount: 30, interferenceRatio: 1.1, consistencyTrend: 0.9, snr21: 1, snr23: 1.1, snr31: 1 },
            flash: { verdict: 'PASS', reason: 'STAGE_WITHIN_LIMIT', sampleCount: 30, interferenceRatio: 1.2, consistencyTrend: 0.9, snr21: 1, snr23: 1.2, snr31: 1 },
            emc: { verdict: 'PASS', reason: 'STAGE_WITHIN_LIMIT', sampleCount: 30, interferenceRatio: 1.3, consistencyTrend: 0.9, snr21: 1, snr23: 1.3, snr31: 1 },
          },
        }],
      },
      inspectionPositions: [
        { id: 'DETECTION_POSITION_1_HEAT', label: '第一次检测位/热源检测', status: 'CAPTURED', startedAt: 100, completedAt: 200, devices: [{ index: 1, address: 1, sampledAt: 190, online: true, fire: false, fault: false, sourceReady: true, syncOk: true, probes: { probe1: 10, probe2: 12, probe3: 11 }, ratios: { snr21: 1.2, snr23: 1.1, snr31: 1.1 } }] },
        { id: 'DETECTION_POSITION_2_FLASH', label: '第二次检测位/爆闪检测', status: 'CAPTURED', startedAt: 300, completedAt: 400, devices: [{ index: 1, address: 1, sampledAt: 390, online: true, fire: true, fault: false, sourceReady: true, syncOk: true, probes: { probe1: 20, probe2: 22, probe3: 21 }, ratios: { snr21: 1.1, snr23: 1.05, snr31: 1.05 } }] },
      ],
    });

    const log = await readFile(file, 'utf8');
    assert.match(log, /批次：batch-001 \| 结果：不合格 \| 等级：不合格 \| 耗时：1\.0秒/);
    assert.match(log, /设备结果明细/);
    assert.match(log, /\| 1 \| 1 \| 不合格 \| 1 \| 2 \| 3 \| 1\.1 \| 0\.9 \| 1 \| 1\.8 \| 1 \| 5 \| P2\/P3 信噪比高于上限（1\.8 ≤ 1\.5） \|/);
    assert.match(log, /\| 2 \| 1 \| A类合格 \| 1 \| 2 \| 3 \| 1\.1 \| 0\.9 \| 1 \| 1 \| 1 \| 5 \| 全部指标满足 A 类限值 \|/);
    assert.match(log, /工序检测明细/);
    assert.match(log, /\| 热源检测 \| 1 \| 30 \| 1\.1 \| 0\.9 \| 1 \| 1\.1 \| 1 \| 合格 \| 指标正常 \|/);
    assert.match(log, /\| 爆闪检测 \| 1 \| 30 \| 1\.2 \| 0\.9 \| 1 \| 1\.2 \| 1 \| 合格 \| 指标正常 \|/);
    assert.match(log, /\| 电磁干扰 \| 1 \| 30 \| 1\.3 \| 0\.9 \| 1 \| 1\.3 \| 1 \| 合格 \| 指标正常 \|/);
    assert.match(log, /\| 热源检测 \| 2 \| - \| - \| - \| - \| - \| - \| 未采集 \| 未采集 \|/);
    assert.match(log, /检测位原始数值/);
    assert.match(log, /\| 第二次检测位\/爆闪检测 \| 1 \| 20 \| 22 \| 21 \| - \| 1\.1 \| 1\.05 \| 1\.05 \| 在线、火警、无故障、光源就绪、同步正常 \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged runtime stores result logs below APP_DATA_DIR', async () => {
  const appDataDirectory = await mkdtemp(join(tmpdir(), 'field-app-data-'));
  const previous = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = appDataDirectory;
  try {
    const logger = new FileFieldTestResultLogger();
    const file = logger.record({
      batchId: 'batch-app-data', startedAt: 1, completedAt: 2,
      finalVerdict: { verdict: 'FAIL', grade: 'FAIL' },
      detectorVerdict: { verdict: 'FAIL', grade: 'FAIL', units: [], timestamp: 2 },
      thresholds: { minNoiseSamples: 1, minInterferenceSamples: 1, maxNoiseRms: 1, maxInterferenceRatio: 1 },
      inspectionPositions: [],
    });
    assert.equal(dirname(file), join(appDataDirectory, 'logs'));
    assert.match(await readFile(file, 'utf8'), /批次：batch-app-data/);
  } finally {
    if (previous === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previous;
    await rm(appDataDirectory, { recursive: true, force: true });
  }
});

test('corrupt zero-filled result file is preserved and replaced with valid table log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'field-corrupt-log-'));
  const file = join(directory, 'test-results-1970-01-01.log');
  await writeFile(file, Buffer.alloc(128));
  try {
    const logger = new FileFieldTestResultLogger(directory);
    logger.record({
      batchId: 'batch-recovered', startedAt: 1, completedAt: 2,
      finalVerdict: { verdict: 'FAIL', grade: 'FAIL' },
      detectorVerdict: { verdict: 'FAIL', grade: 'FAIL', units: [], timestamp: 2 },
      thresholds: { minNoiseSamples: 1, minInterferenceSamples: 1, maxNoiseRms: 1, maxInterferenceRatio: 1 },
      inspectionPositions: [],
    });

    assert.match(await readFile(file, 'utf8'), /批次：batch-recovered/);
    assert.equal((await readdir(directory)).some((name) => name.startsWith('test-results-1970-01-01.log.corrupt-')), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
