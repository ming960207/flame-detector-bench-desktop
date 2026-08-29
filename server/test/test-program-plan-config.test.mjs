import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { TestProgramArchiveStore } from '../dist/test-program/test-program-archive.js';
import { createTestProgramRuntime } from '../dist/test-program/test-program-server.js';

function jsonResponse(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      Promise.resolve(predicate()).then((matched) => {
        if (matched) return resolve();
        if (Date.now() >= deadline) return reject(new Error('test wait timeout'));
        setTimeout(check, 20).unref();
      }, reject);
    };
    check();
  });
}

test('test program exposes PLC step references and saves local stage plan overrides', async () => {
  const archiveDirectory = mkdtempSync(join(tmpdir(), 'flame-test-plan-'));
  const formalServer = createServer((request, response) => {
    if (request.url === '/api/field/summary') return jsonResponse(response, { process: null });
    if (request.url === '/api/flame/devices') return jsonResponse(response, { units: [], timestamp: Date.now() });
    if (request.url === '/api/system-config') return jsonResponse(response, {
      success: true,
      config: {
        lastUpdated: 123,
        steps: [
          { id: 's1', name: '开始测试', duration: 2, waitTime: 0 },
          { id: 's3', name: '识别到达检测位', duration: 3, waitTime: 1 },
        ],
      },
    });
    response.writeHead(404); response.end();
  });
  const formalWS = new WebSocketServer({ noServer: true });
  formalServer.on('upgrade', (request, socket, head) => formalWS.handleUpgrade(request, socket, head, (client) => formalWS.emit('connection', client, request)));
  await new Promise((resolve) => formalServer.listen(0, '127.0.0.1', resolve));
  const formalPort = formalServer.address().port;
  const runtime = createTestProgramRuntime({
    port: 0,
    formalBackendUrl: `http://127.0.0.1:${formalPort}`,
    formalBackendWsUrl: `ws://127.0.0.1:${formalPort}`,
    archiveStore: new TestProgramArchiveStore(archiveDirectory),
    pollIntervalMs: 250,
    reconnectIntervalMs: 100,
  });

  try {
    const port = await runtime.listen(0);
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/test-program/config`);
      const config = await response.json();
      return config.plcSteps?.length === 2;
    });

    const initialResponse = await fetch(`http://127.0.0.1:${port}/api/test-program/config`);
    const initial = await initialResponse.json();
    assert.equal(initial.plcSteps[0].name, '开始测试');
    assert.equal(initial.plan.find((stage) => stage.id === 'INIT').plannedDurationMs, 2_000);

    const plan = initial.plan.map((stage) => stage.id === 'HEAT_SIGNAL_STABILIZATION'
      ? { ...stage, plannedDurationMs: 11_000 }
      : stage);
    const saveResponse = await fetch(`http://127.0.0.1:${port}/api/test-program/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.planSource, 'LOCAL_OVERRIDE');
    assert.equal(saved.plan.find((stage) => stage.id === 'HEAT_SIGNAL_STABILIZATION').plannedDurationMs, 11_000);

    const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/test-program/snapshot`);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.plan.find((stage) => stage.id === 'HEAT_SIGNAL_STABILIZATION').plannedDurationMs, 11_000);
  } finally {
    await runtime.close();
    formalWS.close();
    await new Promise((resolve) => formalServer.close(resolve));
    rmSync(archiveDirectory, { recursive: true, force: true });
  }
});
