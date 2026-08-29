import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

class FakePLCSource extends EventEmitter {
  async start() {}
  async stop() {}
  getCurrent() { return undefined; }
  isConnected() { return false; }
}

class FakeDetectorSource extends EventEmitter {
  connected = false;
  state = { units: [], onlineCount: 0, fireCount: 0, faultCount: 0, timestamp: 0 };

  constructor(config) {
    super();
    this.config = structuredClone(config);
  }

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  getCurrentState() { return this.state; }
  isConnected() { return this.connected; }
  getConfig() { return this.config; }
  updateConfig(config) { this.config = structuredClone(config); }
}

test('saving detector config updates live judgment thresholds and persists them', async () => {
  const appDataDir = await mkdtemp(join(tmpdir(), 'flame-config-runtime-'));
  process.env.APP_DATA_DIR = appDataDir;
  const [{ createFieldStatusRuntime }, { config }, { DEFAULT_DETECTION_QUALITY_CONFIG }] = await Promise.all([
    import('../dist/closure/field-status-server.js'),
    import('../dist/config.js'),
    import('../dist/closure/field-waveform-analysis.js'),
  ]);
  const detectors = new FakeDetectorSource(config.flame);
  const runtime = createFieldStatusRuntime(new FakePLCSource(), detectors, { record() {} });
  const port = await runtime.listen(0);

  try {
    const next = structuredClone(detectors.getConfig());
    next.waveformSendMode = 'filtered';
    next.waveformAnalysis.minNoiseRms = 55;
    next.waveformAnalysis.maxNoiseRms = 80;
    next.waveformAnalysis.quality = structuredClone(DEFAULT_DETECTION_QUALITY_CONFIG);
    next.waveformAnalysis.quality.acceptanceGrade = 'B';
    next.waveformAnalysis.quality.ratios.a.snr23 = { min: 0.8, max: 1.2 };
    next.waveformAnalysis.quality.a.maxNoiseRms = 70;
    next.waveformAnalysis.quality.b.maxNoiseRms = 80;
    const response = await fetch(`http://127.0.0.1:${port}/api/flame/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    assert.equal(response.ok, true);

    const summary = await fetch(`http://127.0.0.1:${port}/api/field/summary`).then((value) => value.json());
    assert.equal(summary.waveformAnalysis.thresholds.maxNoiseRms, 80);
    assert.equal(summary.waveformAnalysis.thresholds.minNoiseRms, 55);
    assert.equal(summary.waveformAnalysis.thresholds.quality.a.maxNoiseRms, 70);
    assert.equal(summary.waveformAnalysis.thresholds.quality.b.maxNoiseRms, 80);
    assert.equal(summary.waveformAnalysis.thresholds.quality.acceptanceGrade, 'B');
    assert.deepEqual(summary.waveformAnalysis.thresholds.quality.ratios.a.snr23, { min: 0.8, max: 1.2 });
    assert.equal('detectors' in summary.waveformAnalysis.thresholds.quality, false);

    const saved = JSON.parse(await readFile(join(appDataDir, 'system-config.json'), 'utf8'));
    assert.equal(saved.flameConfig.waveformAnalysis.maxNoiseRms, 80);
    assert.equal(saved.flameConfig.waveformAnalysis.minNoiseRms, 55);
    assert.equal(saved.flameConfig.waveformAnalysis.quality.b.maxNoiseRms, 80);
    assert.equal(saved.flameConfig.waveformAnalysis.quality.acceptanceGrade, 'B');
    assert.equal(saved.flameConfig.waveformSendMode, 'filtered');
  } finally {
    await runtime.close();
    await rm(appDataDir, { recursive: true, force: true });
  }
});
