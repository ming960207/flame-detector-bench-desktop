import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { TestProgramArchiveStore } from '../dist/test-program/test-program-archive.js';
import { createTestProgramRuntime } from '../dist/test-program/test-program-server.js';

function status(timestamp, stage, heatSubstage = 'IDLE', options = {}) {
  const codes = { INIT: [1, 1], HEAT: [2, 3], COMPLETE: [0, 0] }[stage] ?? [0, 0];
  return {
    stageCode: codes[0], stepCode: codes[1], autoRunning: options.autoRunning ?? stage !== 'COMPLETE', complete: options.complete ?? stage === 'COMPLETE', alarm: false, returningHome: false,
    stage, label: stage, processStage: stage, processLabel: stage, heatSubstage, heatSubstageLabel: heatSubstage, valid: true, timestamp,
    io: { inputs: {}, outputs: { heatSource: stage === 'HEAT' }, internal: {}, steps: {}, syncedAt: timestamp },
  };
}

function jsonResponse(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('test wait timeout'));
      setTimeout(check, 20).unref();
    };
    check();
  });
}

test('test program runtime exposes read-only snapshot and archives a formal WS run', async () => {
  const archiveDirectory = mkdtempSync(join(tmpdir(), 'flame-test-runtime-'));
  const formalServer = createServer((request, response) => {
    if (request.url === '/api/field/summary') return jsonResponse(response, { process: status(1_000, 'INIT') });
    if (request.url === '/api/flame/devices') return jsonResponse(response, { units: [], onlineCount: 0, fireCount: 0, faultCount: 0, timestamp: 1_000 });
    response.writeHead(404); response.end();
  });
  const formalWS = new WebSocketServer({ noServer: true });
  formalServer.on('upgrade', (request, socket, head) => formalWS.handleUpgrade(request, socket, head, (client) => formalWS.emit('connection', client, request)));
  let formalClient;
  formalWS.on('connection', (client) => { formalClient = client; });
  await new Promise((resolve) => formalServer.listen(0, '127.0.0.1', resolve));
  const formalPort = formalServer.address().port;
  const archiveStore = new TestProgramArchiveStore(archiveDirectory);
  const runtime = createTestProgramRuntime({
    port: 0,
    formalBackendUrl: `http://127.0.0.1:${formalPort}`,
    formalBackendWsUrl: `ws://127.0.0.1:${formalPort}`,
    archiveStore,
    pollIntervalMs: 300,
    reconnectIntervalMs: 100,
    completionFlushDelayMs: 100,
  });
  let uiClient;
  try {
    const port = await runtime.listen(0);
    uiClient = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => { uiClient.once('open', resolve); uiClient.once('error', reject); });
    await waitFor(() => Boolean(formalClient));

    const send = (type, payload, timestamp) => formalClient.send(JSON.stringify({ type, payload, timestamp }));
    send('plc_process_status', status(1_000, 'INIT'), 1_000);
    send('plc_process_status', status(2_000, 'HEAT', 'SIGNAL_STABILIZATION'), 2_000);
    send('plc_process_status', status(3_000, 'HEAT', 'NOISE_CAPTURE'), 3_000);
    send('plc_process_status', status(4_000, 'HEAT', 'HEAT_INTERFERENCE'), 4_000);
    send('field_summary', {
      process: status(5_000, 'COMPLETE', 'IDLE', { complete: true, autoRunning: false }),
      waveformAnalysis: { phase: 'COMPLETE', verdict: 'PASS', thresholds: { minNoiseSamples: 1, minInterferenceSamples: 1 } , units: [] },
      detectorVerdict: { verdict: 'PASS', grade: 'B_PASS', units: [], timestamp: 5_000 },
      finalVerdict: { verdict: 'PASS', grade: 'B_PASS' },
    }, 5_000);
    send('plc_process_status', status(5_000, 'COMPLETE', 'IDLE', { complete: true, autoRunning: false }), 5_000);

    await waitFor(() => archiveStore.list().length === 1);
    const response = await fetch(`http://127.0.0.1:${port}/api/test-program/snapshot`);
    assert.equal(response.ok, true);
    const snapshot = await response.json();
    assert.equal(snapshot.currentRun.status, 'COMPLETED');
    assert.equal(snapshot.currentRun.stages.some((stage) => stage.stageId === 'HEAT_SIGNAL_STABILIZATION'), true);
    assert.equal(snapshot.currentRun.stages.some((stage) => stage.stageId === 'HEAT_NOISE_CAPTURE'), true);
    assert.equal(snapshot.currentRun.stages.some((stage) => stage.stageId === 'HEAT_INTERFERENCE'), true);

    const archiveListResponse = await fetch(`http://127.0.0.1:${port}/api/test-program/archives?limit=10`);
    assert.equal(archiveListResponse.ok, true);
    const archiveList = await archiveListResponse.json();
    assert.equal(archiveList.items[0].runId, snapshot.currentRun.runId);
    const archiveDetailResponse = await fetch(`http://127.0.0.1:${port}/api/test-program/archives/${encodeURIComponent(snapshot.currentRun.runId)}`);
    assert.equal(archiveDetailResponse.ok, true);
    const archiveDetail = await archiveDetailResponse.json();
    assert.equal(archiveDetail.runId, snapshot.currentRun.runId);
    assert.equal(archiveDetail.stages.length, snapshot.currentRun.stages.length);

    const writeResponse = await fetch(`http://127.0.0.1:${port}/api/test-program/anything`, { method: 'POST' });
    assert.equal(writeResponse.status, 405);
  } finally {
    uiClient?.close();
    await runtime.close();
    formalWS.close();
    await new Promise((resolve) => formalServer.close(resolve));
    rmSync(archiveDirectory, { recursive: true, force: true });
  }
});
