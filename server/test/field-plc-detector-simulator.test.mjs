import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFieldStatusRuntime } from '../dist/closure/field-status-server.js';
import { decodePLCProcessStatus } from '../dist/process-status.js';
import { FlameDetectorService } from '../dist/modbus/flame-detector-service.js';

const SEND_MODE_BROADCAST_FRAME = Buffer.from('FF10300000020400010008C043', 'hex');

function calculateModbusCRC16(buffer) {
  let crc = 0xFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
  }
  return crc;
}

function createWriteResponse(address = 1, quantity = 2) {
  const frame = Buffer.from([address, 0x10, 0x30, 0x00, (quantity >> 8) & 0xFF, quantity & 0xFF, 0, 0]);
  const crc = calculateModbusCRC16(frame.subarray(0, -2));
  frame[6] = crc & 0xFF;
  frame[7] = (crc >> 8) & 0xFF;
  return frame;
}

function createReadResponse(request) {
  const quantity = request.readUInt16BE(4);
  const startAddress = request.readUInt16BE(2);
  const values = Array(quantity).fill(0);
  const set = (offset, value) => {
    if (offset >= 0 && offset < values.length) values[offset] = value & 0xFFFF;
  };

  switch (startAddress) {
    case 0x0000: set(0, 1); break;
    case 0x1000: set(0, 3); break;
    case 0x3000: set(0, 1); break;
    case 0x6000:
      set(1, 1);
      set(3, 0x0102);
      set(4, 0x0304);
      set(5, 0x0506);
      set(6, 0x0708);
      set(7, 0x090A);
      break;
    case 0x7000: set(0, 0x0102); set(1, 0x0304); break;
    case 0x7002: set(0, 0); set(1, 42); break;
    case 0x8000: set(0, 1); break;
    case 0x9000: set(10, 1); break;
    default: break;
  }

  const response = Buffer.alloc(5 + quantity * 2);
  response[0] = request[0];
  response[1] = 0x03;
  response[2] = quantity * 2;
  values.forEach((value, index) => response.writeUInt16BE(value, 3 + index * 2));
  const crc = calculateModbusCRC16(response.subarray(0, -2));
  response[response.length - 2] = crc & 0xFF;
  response[response.length - 1] = (crc >>> 8) & 0xFF;
  return response;
}

function createWaveformFrame() {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(100 + offset, offset);
  return frame;
}

function createLongWaveformFrame() {
  const frame = Buffer.alloc(170);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < frame.length; offset += 2) frame.writeInt16LE(100 + offset, offset);
  return frame;
}

function createPLCStatus(stageCode, stepCode, options = {}) {
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

function createMockDetectorGateway() {
  let connectionCount = 0;
  let modeRequestCount = 0;
  const sockets = new Set();
  const droppedAt = [];
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    const state = { buffer: Buffer.alloc(0) };
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      while (state.buffer.length > 0) {
        if (
          state.buffer.length >= SEND_MODE_BROADCAST_FRAME.length
          && state.buffer.subarray(0, SEND_MODE_BROADCAST_FRAME.length).equals(SEND_MODE_BROADCAST_FRAME)
        ) {
          state.buffer = state.buffer.subarray(SEND_MODE_BROADCAST_FRAME.length);
          modeRequestCount += 1;
          socket.write(createWriteResponse(1));
          continue;
        }

        if (state.buffer.length < 8) return;
        if (state.buffer[0] !== 1 || state.buffer[1] !== 0x03) {
          state.buffer = state.buffer.subarray(1);
          continue;
        }
        const request = state.buffer.subarray(0, 8);
        state.buffer = state.buffer.subarray(8);
        socket.write(createReadResponse(request));
      }
    });
  });

  return {
    server,
    sockets,
    get connectionCount() { return connectionCount; },
    get modeRequestCount() { return modeRequestCount; },
    get droppedAt() { return droppedAt; },
    dropActiveSocket() {
      const socket = sockets.values().next().value;
      assert.ok(socket, 'the simulator must have an active TCP session before injecting a drop');
      const dropped = Date.now();
      droppedAt.push(dropped);
      socket.destroy();
      return dropped;
    },
    startWaveformPump({ frame = createWaveformFrame(), intervalMs = 25 } = {}) {
      return setInterval(() => {
        for (const socket of sockets) {
          if (!socket.destroyed && socket.writable) socket.write(frame);
        }
      }, intervalMs);
    },
  };
}

async function readSummary(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/field/summary`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function readDevices(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/flame/devices`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function waitForSummary(port, predicate, timeoutMs = 950) {
  const startedAt = performance.now();
  let latest;
  while (performance.now() - startedAt < timeoutMs) {
    latest = await readSummary(port);
    if (predicate(latest)) return { summary: latest, elapsedMs: performance.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`field summary predicate timed out after ${timeoutMs}ms: ${JSON.stringify(latest)}`);
}

async function waitForDevices(port, predicate, timeoutMs = 950) {
  const startedAt = performance.now();
  let latest;
  while (performance.now() - startedAt < timeoutMs) {
    latest = await readDevices(port);
    if (predicate(latest)) return { state: latest, elapsedMs: performance.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`device state predicate timed out after ${timeoutMs}ms: ${JSON.stringify(latest)}`);
}

async function assertStageAndReconnect({ plc, gateway, port }, stage, phase, counterKey, previousCount = 0, repeats = 1) {
  plc.setPending(stage);
  let result = await waitForSummary(port, (summary) => (
    summary.waveformAnalysis.phase === phase
    && summary.waveformAnalysis.processStage === stage.processStage
  ));
  assert.ok(result.elapsedMs < 1_000, `${stage.processLabel} stage update exceeded one second`);
  let countBeforeDrop = result.summary.waveformAnalysis.units[0][counterKey];
  assert.ok(countBeforeDrop >= previousCount);

  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const droppedAt = gateway.dropActiveSocket();
    result = await waitForSummary(port, (summary) => summary.detectorDataStreamConnected === false);
    assert.ok(result.elapsedMs < 1_000, `${stage.processLabel} disconnect ${attempt + 1} update exceeded one second`);
    result = await waitForSummary(port, (summary) => summary.detectorDataStreamConnected === true);
    assert.ok(result.elapsedMs < 1_000, `${stage.processLabel} reconnect ${attempt + 1} exceeded one second`);
    assert.ok(Date.now() - droppedAt < 1_000, `${stage.processLabel} reconnect ${attempt + 1} wall time exceeded one second`);
    result = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.phase === phase
      && summary.waveformAnalysis.units[0][counterKey] > countBeforeDrop
    ));
    assert.ok(result.elapsedMs < 1_000, `${stage.processLabel} waveform did not resume within one second after reconnect ${attempt + 1}`);
    countBeforeDrop = result.summary.waveformAnalysis.units[0][counterKey];
  }
  return countBeforeDrop;
}

test('simulated PLC stages keep capturing waveforms through a reconnect at every capture window', async () => {
  const gateway = createMockDetectorGateway();
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const gatewayPort = gateway.server.address().port;
  const lockDirectory = await mkdtemp(join(tmpdir(), 'field-plc-detector-simulator-'));
  const units = Array.from({ length: 6 }, (_, offset) => ({
    index: offset + 1,
    address: 1,
    enabled: offset === 0,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: gatewayPort,
  }));
  const detectors = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: gatewayPort,
    pollIntervalMs: 100,
    waveformMaxSamples: 1000,
    units,
  }, { lockPath: join(lockDirectory, 'detector.lock') });
  const plc = new PollingPLCSource(200);
  const testStartedAt = Date.now();
  plc.setPending(createPLCStatus(1, 1, { timestamp: testStartedAt }));
  const runtime = createFieldStatusRuntime(plc, detectors);
  const pump = gateway.startWaveformPump();
  let port;

  try {
    port = await runtime.listen(0);
    await waitForSummary(port, (summary) => summary.detectorDataStreamConnected === true);
    assert.equal(gateway.connectionCount, 1);
    assert.ok(gateway.modeRequestCount >= 1, 'the simulator must observe the FF broadcast mode handshake');

    plc.setPending(createPLCStatus(1, 1, { timestamp: testStartedAt + 5_000 }));
    await assertStageAndReconnect(
      { plc, gateway, port },
      createPLCStatus(1, 1, { timestamp: testStartedAt + 5_000 }),
      'NOISE',
      'noiseSampleCount',
      0,
      3,
    );
    let interferenceCount = await assertStageAndReconnect(
      { plc, gateway, port },
      createPLCStatus(2, 2),
      'INTERFERENCE',
      'interferenceSampleCount',
      0,
      3,
    );
    interferenceCount = await assertStageAndReconnect(
      { plc, gateway, port },
      createPLCStatus(3, 3),
      'INTERFERENCE',
      'interferenceSampleCount',
      0,
      3,
    );
    interferenceCount = await assertStageAndReconnect(
      { plc, gateway, port },
      createPLCStatus(4, 3),
      'INTERFERENCE',
      'interferenceSampleCount',
      interferenceCount,
      3,
    );

    plc.setPending(createPLCStatus(1, 1, { returningHome: true }));
    const returningHome = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.phase === 'INTERFERENCE'
      && summary.waveformAnalysis.processStage === 'RETURN_HOME'
    ));
    assert.ok(returningHome.elapsedMs < 1_000, 'return-home stage update exceeded one second');

    plc.setPending(createPLCStatus(0, 0, { autoRunning: false, complete: true }));
    const complete = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.phase === 'COMPLETE'
      && summary.waveformAnalysis.processStage === 'COMPLETE'
    ));
    const completedCounts = complete.summary.waveformAnalysis.units[0];
    assert.ok(completedCounts.noiseSampleCount >= 5, 'noise window must contain enough online waveform samples');
    assert.ok(completedCounts.interferenceSampleCount >= 5, 'interference window must contain enough online waveform samples');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterComplete = await readSummary(port);
    assert.equal(afterComplete.waveformAnalysis.units[0].noiseSampleCount, completedCounts.noiseSampleCount);
    assert.equal(afterComplete.waveformAnalysis.units[0].interferenceSampleCount, completedCounts.interferenceSampleCount);
    assert.equal(gateway.sockets.size, 1, 'reconnects must replace the TCP session instead of accumulating sessions');
    assert.equal(gateway.droppedAt.length, 12, 'each capture stage should exercise three reconnect cycles');
    assert.equal(gateway.connectionCount, 13, 'one initial session plus one replacement per reconnect cycle is expected');
  } finally {
    clearInterval(pump);
    await runtime.close();
    for (const socket of gateway.sockets) socket.destroy();
    await new Promise((resolve) => gateway.server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('six detector TCP sessions remain independent while one unit reconnects during PLC stages', async () => {
  const gateways = Array.from({ length: 6 }, () => createMockDetectorGateway());
  await Promise.all(gateways.map((gateway) => new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))));
  const gatewayPorts = gateways.map((gateway) => gateway.server.address().port);
  const lockDirectory = await mkdtemp(join(tmpdir(), 'field-six-detector-simulator-'));
  const units = gateways.map((gateway, offset) => ({
    index: offset + 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: gatewayPorts[offset],
  }));
  const detectors = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: gatewayPorts[0],
    pollIntervalMs: 100,
    waveformMaxSamples: 1000,
    units,
  }, { lockPath: join(lockDirectory, 'detector.lock') });
  const plc = new PollingPLCSource(200);
  const testStartedAt = Date.now();
  plc.setPending(createPLCStatus(1, 1, { timestamp: testStartedAt }));
  const runtime = createFieldStatusRuntime(plc, detectors);
  const pumps = gateways.map((gateway) => gateway.startWaveformPump());
  let port;

  async function assertIndependentReconnect(unitIndex, counterKey) {
    const before = await readDevices(port);
    const countBeforeDrop = (await readSummary(port)).waveformAnalysis.units[unitIndex - 1][counterKey];
    assert.equal(before.units.filter((unit) => unit.online).length, 6);
    const droppedAt = gateways[unitIndex - 1].dropActiveSocket();
    let result = await waitForDevices(port, (state) => (
      state.units[unitIndex - 1].online === false
      && state.units.filter((unit) => unit.online).length === 5
    ));
    assert.ok(result.elapsedMs < 1_000, `detector ${unitIndex} disconnect update exceeded one second`);
    result = await waitForDevices(port, (state) => state.units.every((unit) => unit.online));
    assert.ok(result.elapsedMs < 1_000, `detector ${unitIndex} reconnect exceeded one second`);
    assert.ok(Date.now() - droppedAt < 1_000, `detector ${unitIndex} reconnect wall time exceeded one second`);
    result = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.units[unitIndex - 1][counterKey] > countBeforeDrop
    ));
    assert.ok(result.elapsedMs < 1_000, `detector ${unitIndex} waveform did not resume within one second`);
    assert.equal(gateways[unitIndex - 1].sockets.size, 1);
    assert.ok(gateways[unitIndex - 1].modeRequestCount >= 2);
  }

  try {
    port = await runtime.listen(0);
    await waitForDevices(port, (state) => state.units.every((unit) => unit.online));
    assert.equal(gateways.reduce((total, gateway) => total + gateway.connectionCount, 0), 6);
    assert.ok(gateways.every((gateway) => gateway.modeRequestCount >= 1));

    plc.setPending(createPLCStatus(1, 1, { timestamp: testStartedAt + 5_000 }));
    await waitForSummary(port, (summary) => summary.waveformAnalysis.units.every((unit) => unit.noiseSampleCount >= 5));
    await assertIndependentReconnect(1, 'noiseSampleCount');
    await assertIndependentReconnect(3, 'noiseSampleCount');
    await assertIndependentReconnect(5, 'noiseSampleCount');

    plc.setPending(createPLCStatus(2, 2));
    await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.processStage === 'HEAT'
      && summary.waveformAnalysis.phase === 'INTERFERENCE'
    ));

    plc.setPending(createPLCStatus(3, 3));
    await waitForSummary(port, (summary) => summary.waveformAnalysis.phase === 'INTERFERENCE');
    await waitForSummary(port, (summary) => summary.waveformAnalysis.units.every((unit) => unit.interferenceSampleCount >= 5));
    await assertIndependentReconnect(2, 'interferenceSampleCount');
    await assertIndependentReconnect(4, 'interferenceSampleCount');
    await assertIndependentReconnect(6, 'interferenceSampleCount');

    plc.setPending(createPLCStatus(4, 3));
    await waitForSummary(port, (summary) => summary.waveformAnalysis.processStage === 'EMC');
    const countsBeforeStorm = (await readSummary(port)).waveformAnalysis.units.map((unit) => unit.interferenceSampleCount);
    const stormDroppedAt = gateways.map((gateway) => gateway.dropActiveSocket());
    let stormState = await waitForDevices(port, (state) => state.units.every((unit) => !unit.online));
    assert.ok(stormState.elapsedMs < 1_000, 'simultaneous detector disconnect update exceeded one second');
    let stormSummary = await waitForSummary(port, (summary) => summary.detectorDataStreamConnected === false);
    assert.ok(stormSummary.elapsedMs < 1_000, 'simultaneous detector stream disconnect exceeded one second');
    stormState = await waitForDevices(port, (state) => state.units.every((unit) => unit.online));
    assert.ok(stormState.elapsedMs < 1_000, 'simultaneous detector reconnect exceeded one second');
    for (const droppedAt of stormDroppedAt) {
      assert.ok(Date.now() - droppedAt < 1_000, 'simultaneous detector reconnect wall time exceeded one second');
    }
    stormSummary = await waitForSummary(port, (summary) => summary.waveformAnalysis.units.every((unit, index) => (
      unit.interferenceSampleCount > countsBeforeStorm[index]
    )));
    assert.ok(stormSummary.elapsedMs < 1_000, 'simultaneous detector waveforms did not resume within one second');

    plc.setPending(createPLCStatus(0, 0, { autoRunning: false, complete: true }));
    const complete = await waitForSummary(port, (summary) => summary.waveformAnalysis.processStage === 'COMPLETE');
    assert.ok(complete.summary.waveformAnalysis.units.every((unit) => (
      unit.noiseSampleCount >= 5 && unit.interferenceSampleCount >= 5
    )));
    assert.equal(gateways.every((gateway) => gateway.sockets.size === 1), true);
    assert.equal(gateways.every((gateway) => gateway.droppedAt.length === 2), true);
    assert.equal(gateways.every((gateway) => gateway.connectionCount === 3), true);
  } finally {
    for (const pump of pumps) clearInterval(pump);
    await runtime.close();
    for (const gateway of gateways) {
      for (const socket of gateway.sockets) socket.destroy();
      await new Promise((resolve) => gateway.server.close(resolve));
    }
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('six detectors keep recovering long waveforms under a high-rate simultaneous reconnect', async () => {
  const gateways = Array.from({ length: 6 }, () => createMockDetectorGateway());
  await Promise.all(gateways.map((gateway) => new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))));
  const gatewayPorts = gateways.map((gateway) => gateway.server.address().port);
  const lockDirectory = await mkdtemp(join(tmpdir(), 'field-high-rate-detector-simulator-'));
  const units = gateways.map((gateway, offset) => ({
    index: offset + 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: gatewayPorts[offset],
  }));
  const detectors = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: gatewayPorts[0],
    pollIntervalMs: 100,
    waveformMaxSamples: 1000,
    units,
  }, { lockPath: join(lockDirectory, 'detector.lock') });
  const plc = new PollingPLCSource(200);
  plc.setPending(createPLCStatus(4, 3));
  const runtime = createFieldStatusRuntime(plc, detectors);
  const pumps = gateways.map((gateway) => gateway.startWaveformPump({
    frame: createLongWaveformFrame(),
    intervalMs: 2,
  }));
  let port;

  try {
    port = await runtime.listen(0);
    await waitForDevices(port, (state) => state.units.every((unit) => unit.online));
    const before = await waitForSummary(port, (summary) => (
      summary.waveformAnalysis.processStage === 'EMC'
      && summary.waveformAnalysis.units.every((unit) => unit.interferenceSampleCount > 0)
    ));
    const countsBeforeDrop = before.summary.waveformAnalysis.units.map((unit) => unit.interferenceSampleCount);
    const droppedAt = gateways.map((gateway) => gateway.dropActiveSocket());

    let result = await waitForDevices(port, (state) => state.units.every((unit) => !unit.online));
    assert.ok(result.elapsedMs < 1_000, 'high-rate simultaneous disconnect update exceeded one second');
    result = await waitForDevices(port, (state) => state.units.every((unit) => unit.online));
    assert.ok(result.elapsedMs < 1_000, 'high-rate simultaneous reconnect exceeded one second');
    for (const dropped of droppedAt) assert.ok(Date.now() - dropped < 1_000, 'high-rate reconnect wall time exceeded one second');

    result = await waitForSummary(port, (summary) => summary.waveformAnalysis.units.every((unit, index) => (
      unit.interferenceSampleCount > countsBeforeDrop[index]
    )));
    assert.ok(result.elapsedMs < 1_000, 'high-rate long waveforms did not resume within one second');
    assert.equal(gateways.every((gateway) => gateway.sockets.size === 1), true);
    assert.equal(gateways.every((gateway) => gateway.connectionCount === 2), true);
  } finally {
    for (const pump of pumps) clearInterval(pump);
    await runtime.close();
    for (const gateway of gateways) {
      for (const socket of gateway.sockets) socket.destroy();
      await new Promise((resolve) => gateway.server.close(resolve));
    }
    await rm(lockDirectory, { recursive: true, force: true });
  }
});
