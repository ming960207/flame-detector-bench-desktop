import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFieldStatusRuntime } from '../dist/closure/field-status-server.js';
import { decodePLCProcessStatus } from '../dist/process-status.js';

class FakePLCSource extends EventEmitter {
  connected = false;
  current;

  async start() { this.connected = true; }
  async stop() { this.connected = false; }
  getCurrent() { return this.current; }
  isConnected() { return this.connected; }
}

class FakeDetectorSource extends EventEmitter {
  connected = false;
  state = { units: [], onlineCount: 0, fireCount: 0, faultCount: 0, timestamp: 0 };
  waveformHistoryClearCount = 0;

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  getCurrentState() { return this.state; }
  isConnected() { return this.connected; }
  isTransportConnected() { return this.connected; }
  isDataStreamConnected() { return this.state.onlineCount > 0; }
  clearWaveformHistory() {
    this.waveformHistoryClearCount += 1;
    this.state = {
      ...this.state,
      units: this.state.units.map((unit) => ({
        ...unit,
        samples: [],
        rawSamples: [],
        historySamples: [],
        rawHistorySamples: [],
      })),
    };
  }
}

function plcStatus(stageCode, stepCode, timestamp, options = {}) {
  return decodePLCProcessStatus({
    stageCode,
    stepCode,
    autoRunning: options.autoRunning ?? true,
    complete: options.complete ?? false,
    alarm: false,
    returningHome: options.returningHome ?? false,
    timestamp,
    io: options.io,
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

test('field runtime binds PLC capture windows to live detector states across reconnects', async () => {
  const plc = new FakePLCSource();
  const detectors = new FakeDetectorSource();
  const completedTests = [];
  const runtime = createFieldStatusRuntime(plc, detectors, { record: (entry) => completedTests.push(entry) });
  const port = await runtime.listen(0);

  try {
    const emitPLC = (status) => {
      plc.current = status;
      plc.emit('status', status);
    };
    const emitDetector = (state) => {
      detectors.state = state;
      detectors.emit('flame_state', state);
    };

    const staleDetector = detectorState(0, 999);
    detectors.state = {
      ...staleDetector,
      units: staleDetector.units.map((unit) => ({
        ...unit,
        historySamples: [{ probe1: 999, probe2: 999, probe3: 999 }],
        rawHistorySamples: [{ probe1: 999, probe2: 999, probe3: 999 }],
      })),
    };
    emitPLC(plcStatus(2, 3, 1, { io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } } }));
    assert.equal(detectors.waveformHistoryClearCount, 1, 'starting signal-stability capture must clear the old card cache');
    assert.equal(detectors.state.units[0].historySamples.length, 0, 'old card cache must be empty before noise samples arrive');
    emitPLC(plcStatus(2, 3, 5_001, { io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } } }));
    for (let index = 0; index < 400; index += 1) emitDetector(detectorState(5_010 + index, 10 + (index % 120)));
    let summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.phase, 'NOISE');
    assert.equal(summary.waveformAnalysis.units[0].noiseSampleCount, 400);

    emitDetector(detectorState(5_020, 14, false));
    summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.units[0].noiseSampleCount, 400, 'offline cached data must not be counted');

    emitPLC(plcStatus(2, 3, 5_025, { io: { steps: { stepM10_4: false } } }));
    assert.equal(detectors.waveformHistoryClearCount, 1, 'moving into the heat position must not clear the card window early');
    emitPLC(plcStatus(2, 3, 5_026, { io: { steps: { stepM10_4: true } } }));
    assert.equal(detectors.waveformHistoryClearCount, 2, 'starting heat interference must clear device-card waveform cache');
    emitPLC(plcStatus(2, 3, 5_027, { io: { steps: { stepM10_4: true } } }));
    assert.equal(detectors.waveformHistoryClearCount, 2, 'the active heat-interference step must clear only once');
    for (let index = 0; index < 80; index += 1) emitDetector(detectorState(5_028 + index, 12 + (index % 5)));
    summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.phase, 'INTERFERENCE');
    assert.equal(summary.waveformAnalysis.units[0].interferenceSampleCount, 80);
    emitPLC(plcStatus(2, 2, 5_034, { io: { steps: { stepM10_4: false } } }));

    detectors.state = {
      ...detectorState(5_029, 999),
      units: [{
        ...detectorState(5_029, 999).units[0],
        historySamples: [{ probe1: 999, probe2: 999, probe3: 999 }],
        rawHistorySamples: [{ probe1: 999, probe2: 999, probe3: 999 }],
      }],
    };
    emitPLC(plcStatus(3, 3, 5_035, { io: { steps: { stepM11_0: true } } }));
    assert.equal(detectors.waveformHistoryClearCount, 3, 'entering flash interference must start a fresh device-card window');
    assert.equal(detectors.state.units[0].historySamples.length, 0, 'old card cache must not enter the interference window');
    for (let index = 0; index < 80; index += 1) emitDetector(detectorState(5_040 + index, 12 + (index % 5)));
    summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.phase, 'INTERFERENCE');
    assert.equal(summary.waveformAnalysis.units[0].interferenceSampleCount, 160);
    assert.equal(summary.waveformAnalysis.units[0].stages.heat.sampleCount, 80);
    assert.equal(summary.waveformAnalysis.units[0].stages.flash.sampleCount, 80);

    emitPLC(plcStatus(4, 3, 5_046, { io: { steps: { stepM11_0: false, stepM11_2: true } } }));
    for (let index = 0; index < 80; index += 1) emitDetector(detectorState(5_046 + index, 12 + (index % 5)));

    emitPLC(plcStatus(4, 3, 5_046));
    assert.equal(detectors.waveformHistoryClearCount, 3, 'FLASH and EMC belong to one interference window');
    summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.units[0].stages.emc.sampleCount, 80);

    emitPLC(plcStatus(1, 1, 5_050, { autoRunning: true, returningHome: true }));
    summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.phase, 'INTERFERENCE', 'return-home must not complete the analysis early');
    assert.equal(completedTests.length, 0, 'return-home must not write a premature result');

    emitPLC(plcStatus(0, 0, 5_051, { autoRunning: false, complete: true }));
    summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.phase, 'COMPLETE');
    assert.equal(summary.waveformAnalysis.units[0].verdict, 'PASS');
    assert.equal(completedTests.length, 1, 'a completed batch must be logged');
    assert.equal(completedTests[0].batchId, summary.waveformAnalysis.batchId);
    assert.equal(completedTests[0].detectorVerdict.units[0].metrics.noiseAbsolute, summary.detectorVerdict.units[0].metrics.noiseAbsolute);
    assert.deepEqual(completedTests[0].inspectionPositions.map((position) => position.id), [
      'DETECTION_POSITION_1_HEAT',
      'DETECTION_POSITION_2_FLASH',
    ]);
    assert.equal(completedTests[0].inspectionPositions.every((position) => position.status === 'CAPTURED'), true);

    emitPLC(plcStatus(0, 0, 5_052, { autoRunning: false, complete: true }));
    assert.equal(completedTests.length, 1, 'repeated COMPLETE polling must not duplicate the batch log');

    const completedBatchId = summary.waveformAnalysis.batchId;
    emitPLC(plcStatus(2, 3, 5_060, { io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } } }));
    emitPLC(plcStatus(2, 3, 10_060, { io: { internal: { noiseCaptureWindow: true }, steps: { stepM10_4: false } } }));
    emitDetector(detectorState(10_061, 10));
    summary = await readSummary(port);
    assert.notEqual(summary.waveformAnalysis.batchId, completedBatchId, 'a new PLC run must start a new capture batch');
    assert.equal(summary.waveformAnalysis.phase, 'NOISE');
    assert.equal(summary.waveformAnalysis.units[0].noiseSampleCount, 1);
    assert.equal(summary.waveformAnalysis.units[0].interferenceSampleCount, 0);
  } finally {
    await runtime.close();
  }
});

test('deployed PLC run without M25.2 still emits an NG result and completion log', async () => {
  const plc = new FakePLCSource();
  const detectors = new FakeDetectorSource();
  const completedTests = [];
  const runtime = createFieldStatusRuntime(plc, detectors, { record: (entry) => completedTests.push(entry) });
  const port = await runtime.listen(0);

  try {
    const running = plcStatus(1, 1, 100, { io: { internal: { autoRunning: true }, steps: {} } });
    plc.current = running;
    plc.emit('status', running);

    const complete = plcStatus(0, 0, 200, { autoRunning: false, complete: true, io: { internal: { complete: true }, steps: {} } });
    plc.current = complete;
    plc.emit('status', complete);

    const summary = await readSummary(port);
    assert.equal(summary.waveformAnalysis.phase, 'COMPLETE');
    assert.equal(summary.waveformAnalysis.verdict, 'FAIL');
    assert.equal(summary.finalVerdict.verdict, 'FAIL');
    assert.equal(completedTests.length, 1);
    assert.equal(completedTests[0].finalVerdict.verdict, 'FAIL');
  } finally {
    await runtime.close();
  }
});
