import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFieldStatusRuntime, type FlameDetectorStatusSource, type PLCProcessStatusSource } from '../src/closure/field-status-server.js';
import { FlameDetectorService } from '../src/modbus/flame-detector-service.js';
import { FlameDetectorDevice } from '../src/modbus/flame-detector-device.js';
import { detrendedAmplitudeRatio } from '../src/modbus/waveform-signal-ratios.js';
import { createLatestValueScheduler, waveformKeys } from '../../utils/waveform.js';
import type { FlameDetectorState, FlameDetectorUnitState, FlameSample } from '../src/types.js';

test('unpaired channel samples cannot change either side of an amplitude ratio', () => {
  const paired = [0, 1, 0, -1].map(w => ({ probe1: 0, probe2: w * 20, probe3: w * 10 }));
  const missing = { probe1: 0, probe2: 90000, probe3: NaN };
  assert.equal(detrendedAmplitudeRatio([...paired, missing], 'probe2', 'probe3'), 2);
  assert.equal(detrendedAmplitudeRatio([missing, missing, ...paired.slice(0, 2)], 'probe2', 'probe3'), null);
  assert.equal(detrendedAmplitudeRatio(paired.map(s => ({ ...s, probe2: 0 })), 'probe2', 'probe3'), 0);
});

test('live ratios use synchronized RAW drift-removed amplitudes and expire old frames', () => {
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31001,
    units: [{ index: 1, address: 1, enabled: false }] });
  const internal = service as any;
  const unit = internal.units.get(1);
  // Normalization/history and reported device features must not supply ratios.
  unit.historySamples = [{ probe1: -1, probe2: -9000, probe3: -1 }, { probe1: 1, probe2: 9000, probe3: 1 }];
  const device = { normalizeSamples: (samples: FlameSample[]) => ({ samples, baseline: {} }),
    getProtocolProfile: () => ({ isFourWavelength: true }) } as unknown as FlameDetectorDevice;
  const raw = (ratio: number) => [0, 1, 0, -1].map((w, i) => ({
    probe1: 100 + i * 9 + w * 10, probe2: 1000 + i * 30 + w * 20 * ratio,
    probe3: -300 + i * 2 + w * 20, probe4: 500 + i * 40 + w * 60,
  }));
  const update = (ratio: number, at: number) => internal.applyRealtimeState(unit,
    { samples: raw(ratio), features: [{ snr21: 999, snr23: 999, snr31: 999, snr43: 999 }] }, device, at);
  update(1, 1000);
  assert.ok(Math.abs(unit.snr23 - 1) < 1e-9);
  assert.ok(Math.abs(unit.snr21 - 2) < 1e-9);
  assert.ok(Math.abs(unit.snr31 - 2) < 1e-9);
  assert.ok(Math.abs(unit.snr43 - 3) < 1e-9);
  update(1.5, 2100);
  assert.ok(Math.abs(unit.snr23 - 1.5) < 1e-9);
  internal.applyRealtimeState(unit, { samples: raw(1).map(s => ({ ...s, probe3: 0 })), features: [] }, device, 3200);
  assert.equal(unit.snr23, null);
  assert.equal(unit.snr43, null);
});

test('latest value scheduler publishes only the newest pending detector state', () => {
  const callbacks: Array<(() => void) | null> = [];
  const published: string[] = [];
  const scheduler = createLatestValueScheduler<string>(
    (callback) => {
      callbacks.push(callback);
      return callbacks.length - 1;
    },
    (handle) => { callbacks[Number(handle)] = null; },
    (value) => published.push(value),
  );

  scheduler.push('state-1');
  scheduler.push('state-2');
  scheduler.push('state-3');

  assert.equal(callbacks.length, 1);
  callbacks[0]?.();
  assert.deepEqual(published, ['state-3']);

  scheduler.cancel();
});

test('received probe count limits waveform channels even if a frame carries P4 data', () => {
  const unit = { probeCount: 2, probe4: 23_013 } as FlameDetectorUnitState;
  const samples: FlameSample[] = [{ probe1: 8, probe2: 232, probe3: 152, probe4: 23_013 }];

  assert.deepEqual(waveformKeys(samples, unit), ['probe1', 'probe2']);
});

test('clearing waveform history resets probe metrics, ratios, and features for every detector', () => {
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31_001,
    units: [{ index: 1, address: 1, enabled: false, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31_001 }],
  });
  const internal = service as unknown as { units: Map<number, FlameDetectorUnitState> };
  const unit = internal.units.get(1);
  assert.ok(unit);
  Object.assign(unit, {
    probe1: 12,
    probe2: 24,
    probe3: 36,
    probe1Fluctuation: 12,
    probe2Fluctuation: 24,
    probe3Fluctuation: 36,
    probe1Absolute: 100,
    probe2Absolute: 200,
    probe3Absolute: 300,
    snr21: 2,
    snr23: 3,
    snr31: 4,
    features: [{ snr2: 2, snr21: 2, snr23: 3, snr31: 4, peakPower: 5 }],
    samples: [{ probe1: 1, probe2: 2, probe3: 3 }],
    rawSamples: [{ probe1: 10, probe2: 20, probe3: 30 }],
    historySamples: [{ probe1: 1, probe2: 2, probe3: 3 }],
    rawHistorySamples: [{ probe1: 10, probe2: 20, probe3: 30 }],
    historySampleTotal: 1,
  });

  service.clearWaveformHistory();

  const cleared = service.getCurrentState().units.find((item) => item.index === 1)!;
  assert.deepEqual(cleared.samples, []);
  assert.deepEqual(cleared.rawSamples, []);
  assert.deepEqual(cleared.historySamples, []);
  assert.deepEqual(cleared.rawHistorySamples, []);
  assert.equal(cleared.historySampleTotal, 0);
  assert.equal(cleared.probe1, 0);
  assert.equal(cleared.probe2, 0);
  assert.equal(cleared.probe3, 0);
  assert.equal(cleared.probe1Fluctuation, 0);
  assert.equal(cleared.probe2Fluctuation, 0);
  assert.equal(cleared.probe3Fluctuation, 0);
  assert.equal(cleared.probe1Absolute, 0);
  assert.equal(cleared.probe2Absolute, 0);
  assert.equal(cleared.probe3Absolute, 0);
  assert.equal(cleared.snr21, null);
  assert.equal(cleared.snr23, null);
  assert.equal(cleared.snr31, null);
  assert.deepEqual(cleared.features, []);
});

class FakeProcessSource extends EventEmitter implements PLCProcessStatusSource {
  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  getCurrent() { return undefined; }
  isConnected(): boolean { return false; }
}

class FakeDetectorSource extends EventEmitter implements FlameDetectorStatusSource {
  state: FlameDetectorState = { units: [], onlineCount: 0, fireCount: 0, faultCount: 0, timestamp: Date.now() };
  clearCalls = 0;

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  getCurrentState(): FlameDetectorState { return this.state; }
  isConnected(): boolean { return false; }
  clearWaveformHistory(): void {
    this.clearCalls += 1;
    this.state = { ...this.state, timestamp: Date.now() };
    this.emit('flame_state', this.state);
  }
}

test('field API exposes the all-detector waveform clear operation', async () => {
  const source = new FakeProcessSource();
  const detectors = new FakeDetectorSource();
  const runtime = createFieldStatusRuntime(source, detectors);
  const port = await runtime.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/flame/waveform/clear`, { method: 'POST' });
    const payload = await response.json() as { success?: boolean; state?: FlameDetectorState };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(detectors.clearCalls, 1);
    assert.deepEqual(payload.state?.units, []);
  } finally {
    await runtime.close();
  }
});
