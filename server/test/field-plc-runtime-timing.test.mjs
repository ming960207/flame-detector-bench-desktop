import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createFieldStatusRuntime } from '../dist/closure/field-status-server.js';
import { decodePLCProcessStatus } from '../dist/process-status.js';

class PollingPLCSource extends EventEmitter {
  connected = false;
  current;
  timer;

  constructor(intervalMs = 200) {
    super();
    this.intervalMs = intervalMs;
  }

  setPending(status) {
    this.current = status;
  }

  async start() {
    this.connected = true;
    this.timer = setInterval(() => {
      if (this.current) this.emit('status', this.current);
    }, this.intervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.connected = false;
  }

  getCurrent() { return this.current; }
  isConnected() { return this.connected; }
}

class FakeDetectorSource extends EventEmitter {
  connected = false;
  state = { units: [], onlineCount: 0, fireCount: 0, faultCount: 0, timestamp: 0 };

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  getCurrentState() { return this.state; }
  isConnected() { return this.connected; }
  isTransportConnected() { return this.connected; }
  isDataStreamConnected() { return this.state.onlineCount > 0; }

  emitState(state) {
    this.state = state;
    this.emit('flame_state', state);
  }
}

function plcStatus(stageCode, stepCode, options = {}) {
  const returningHome = options.returningHome ?? false;
  return decodePLCProcessStatus({
    stageCode,
    stepCode,
    autoRunning: options.autoRunning ?? true,
    complete: options.complete ?? false,
    alarm: false,
    returningHome,
    timestamp: options.timestamp ?? Date.now(),
    io: {
      internal: {
        noiseCaptureWindow: options.noiseCaptureWindow
          ?? (stageCode === 1 && stepCode === 1 && !returningHome),
      },
      steps: {
        stepM10_4: stageCode === 2,
        stepM11_0: stageCode === 3,
        stepM11_2: stageCode === 4,
      },
    },
  });
}

function detectorState(timestamp, value, online = true) {
  const unit = {
    index: 1,
    address: 1,
    online,
    fire: false,
    fault: false,
    sourceReady: online,
    syncOk: online,
    probe1: value,
    probe2: value,
    probe3: value,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    sensitivity: 1,
    sendMode: 1,
    version: 'test',
    address_r: 1,
    runTime: 0,
    probeCount: 3,
    lastUpdate: timestamp,
    samples: [{ probe1: value, probe2: value, probe3: value }],
    rawSamples: [{ probe1: value, probe2: value, probe3: value }],
  };
  return { units: [unit], onlineCount: online ? 1 : 0, fireCount: 0, faultCount: 0, timestamp };
}

async function readSummary(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/field/summary`);
  assert.equal(response.ok, true);
  return response.json();
}

async function waitForSummary(port, predicate, timeoutMs = 950) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const summary = await readSummary(port);
    if (predicate(summary)) return { summary, elapsedMs: performance.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`field summary predicate timed out after ${timeoutMs}ms`);
}

test('poll-driven PLC stages switch waveform windows within one second and survive detector reconnect', async () => {
  const plc = new PollingPLCSource(200);
  const detectors = new FakeDetectorSource();
  const testStartedAt = Date.now();
  plc.setPending(plcStatus(1, 1, { timestamp: testStartedAt }));
  const runtime = createFieldStatusRuntime(plc, detectors);
  const port = await runtime.listen(0);

  try {
    let result = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.phase === 'NOISE'
      && summary.waveformAnalysis.processStage === 'INIT'
      && summary.waveformAnalysis.heatSubstage === 'SIGNAL_STABILIZATION'
    ));
    assert.ok(result.elapsedMs < 1_000);
    const batchId = result.summary.waveformAnalysis.batchId;
    assert.equal(result.summary.waveformAnalysis.noiseCaptureActive, false);
    assert.equal(result.summary.waveformAnalysis.noiseStartedAt, null);
    assert.equal(result.summary.waveformAnalysis.noiseEndedAt, null);

    plc.setPending(plcStatus(1, 1, { timestamp: testStartedAt + 5_000 }));
    result = await waitForSummary(port, (summary) => summary.waveformAnalysis.noiseCaptureActive === true);
    assert.ok(result.elapsedMs < 1_000);
    assert.equal(result.summary.waveformAnalysis.heatSubstage, 'NOISE_CAPTURE');
    assert.equal(result.summary.waveformAnalysis.noiseStartedAt, testStartedAt + 5_000);
    const noiseStartedAt = result.summary.waveformAnalysis.noiseStartedAt;

    detectors.emitState(detectorState(Date.now(), 10));
    result = await waitForSummary(port, (summary) => summary.waveformAnalysis.units[0].noiseSampleCount === 1);
    assert.equal(result.summary.waveformAnalysis.batchId, batchId);

    detectors.emitState(detectorState(Date.now(), 11, false));
    result = await readSummary(port);
    assert.equal(result.waveformAnalysis.units[0].noiseSampleCount, 1);

    detectors.emitState(detectorState(Date.now(), 12));
    result = await waitForSummary(port, (summary) => summary.waveformAnalysis.units[0].noiseSampleCount === 2);
    assert.equal(result.summary.waveformAnalysis.batchId, batchId);

    const transitions = [
      { status: plcStatus(2, 2, { timestamp: testStartedAt + 5_100 }), phase: 'INTERFERENCE' },
      { status: plcStatus(3, 3, { timestamp: testStartedAt + 5_200 }), phase: 'INTERFERENCE' },
      { status: plcStatus(4, 3, { timestamp: testStartedAt + 5_300 }), phase: 'INTERFERENCE' },
      { status: plcStatus(1, 1, { returningHome: true, timestamp: testStartedAt + 5_400 }), phase: 'INTERFERENCE' },
    ];
    for (const transition of transitions) {
      plc.setPending(transition.status);
      result = await waitForSummary(port, (summary) => (
        summary.waveformAnalysis.phase === transition.phase
        && summary.waveformAnalysis.processStage === transition.status.processStage
      ));
      assert.ok(result.elapsedMs < 1_000, `${transition.status.processLabel} exceeded the one-second stage budget`);
      assert.equal(result.summary.waveformAnalysis.batchId, batchId);
      assert.equal(result.summary.waveformAnalysis.noiseCaptureActive, false);
      assert.ok(result.summary.waveformAnalysis.noiseEndedAt >= noiseStartedAt);
    }

    plc.setPending(plcStatus(0, 0, { autoRunning: false, complete: true, timestamp: testStartedAt + 5_500 }));
    result = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.phase === 'COMPLETE'
      && summary.waveformAnalysis.processStage === 'COMPLETE'
    ));
    assert.equal(result.summary.waveformAnalysis.batchId, batchId);
    assert.equal(result.summary.waveformAnalysis.noiseCaptureActive, false);
    assert.ok(result.summary.waveformAnalysis.noiseEndedAt >= noiseStartedAt);
  } finally {
    await runtime.close();
  }
});
