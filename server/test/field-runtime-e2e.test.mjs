import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const SEND_MODE_BROADCAST_FRAME = Buffer.from('FF10300000020400010008C043', 'hex');
const SEND_MODE_DEDICATED_FRAME = Buffer.from('0110300000020400010008F7A8', 'hex');

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

function createWaveformFrame() {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(100 + offset, offset);
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
    case 0x0000: set(0, 1); break; // sensitivity
    case 0x1000: set(0, 3); break; // standard three-probe device
    case 0x3000: set(0, 1); break; // broadcast send mode
    case 0x6000: // one valid realtime feature group
      set(1, 1);
      set(3, 0x0102);
      set(4, 0x0304);
      set(5, 0x0506);
      set(6, 0x0708);
      set(7, 0x090A);
      break;
    case 0x7000: set(0, 0x0102); set(1, 0x0304); break; // software version
    case 0x7002: set(0, 0); set(1, 42); break; // runtime
    case 0x8000: set(0, 1); break; // communication address
    case 0x9000: set(10, 1); break; // mirror normal
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

function createMockGateway() {
  let connectionCount = 0;
  let broadcastRequestCount = 0;
  let modbusReadRequestCount = 0;
  let pendingReadDrops = 0;
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
        if (state.buffer[0] === 0xFF) {
          if (state.buffer.length < SEND_MODE_BROADCAST_FRAME.length) return;
          if (state.buffer.subarray(0, SEND_MODE_BROADCAST_FRAME.length).equals(SEND_MODE_BROADCAST_FRAME)) {
            state.buffer = state.buffer.subarray(SEND_MODE_BROADCAST_FRAME.length);
            broadcastRequestCount += 1;
            socket.write(createWriteResponse());
            continue;
          }
          state.buffer = state.buffer.subarray(1);
          continue;
        }

        if (
          state.buffer.length >= 6
          && state.buffer[1] === 0x10
          && state.buffer.readUInt16BE(2) === 0x3000
          && state.buffer.readUInt16BE(4) === 2
        ) {
          if (state.buffer.length < SEND_MODE_DEDICATED_FRAME.length) return;
          const request = state.buffer.subarray(0, SEND_MODE_DEDICATED_FRAME.length);
          state.buffer = state.buffer.subarray(SEND_MODE_DEDICATED_FRAME.length);
          broadcastRequestCount += 1;
          socket.write(createWriteResponse(request[0]));
          continue;
        }

        if (state.buffer.length < 8) return;
        if (state.buffer[0] !== 1 || state.buffer[1] !== 0x03) {
          state.buffer = state.buffer.subarray(1);
          continue;
        }
        const request = state.buffer.subarray(0, 8);
        state.buffer = state.buffer.subarray(8);
        modbusReadRequestCount += 1;
        if (pendingReadDrops > 0) {
          pendingReadDrops -= 1;
          droppedAt.push(Date.now());
          socket.destroy();
          continue;
        }
        socket.write(createReadResponse(request));
      }
    });
  });

  return {
    server,
    sockets,
    get connectionCount() { return connectionCount; },
    get broadcastRequestCount() { return broadcastRequestCount; },
    get modbusReadRequestCount() { return modbusReadRequestCount; },
    get droppedAt() { return droppedAt; },
    dropNextRead() { pendingReadDrops += 1; },
  };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function readJson(url, options) {
  const requestOptions = { ...(options ?? {}) };
  if (!requestOptions.signal) requestOptions.signal = AbortSignal.timeout(10_000);
  const response = await fetch(url, requestOptions);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('condition timed out');
}

async function connectWebSocket(baseUrl) {
  const client = new WebSocket(baseUrl.replace(/^http/, 'ws'));
  let waveformMessageCount = 0;
  const autoTestProgress = [];
  await new Promise((resolveOpen, rejectOpen) => {
    client.once('open', resolveOpen);
    client.once('error', rejectOpen);
  });
  client.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'flame_test_progress') autoTestProgress.push(message.payload);
      if (message.type !== 'flame_state' && message.type !== 'flame_waveform_delta') return;
      const units = message.payload?.units;
      if (Array.isArray(units) && (units[0]?.historySampleTotal ?? 0) > 0) waveformMessageCount += 1;
    } catch {
      // Ignore unrelated malformed test traffic; the production server's
      // HTTP/API assertions remain authoritative for this test.
    }
  });
  return {
    client,
    get waveformMessageCount() { return waveformMessageCount; },
    autoTestProgress,
    async close() {
      if (client.readyState === WebSocket.CLOSED) return;
      client.close();
      await new Promise((resolveClose) => client.once('close', resolveClose));
    },
  };
}

async function waitForHealth(baseUrl, predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await readJson(`${baseUrl}/api/health`);
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await sleep(50);
  }
  throw new Error(`health condition timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function launchRuntime(entryPath, environment) {
  const entryUrl = pathToFileURL(resolve(entryPath)).href;
  const runtimePort = await findFreePort();
  const childCode = [
    `import { startConfiguredServer } from ${JSON.stringify(entryUrl)};`,
    'let runtime;',
    'let stopping = false;',
    'async function stop() {',
    '  if (stopping) return;',
    '  stopping = true;',
    '  try { await runtime?.close(); } catch (error) { console.error("E2E_CLOSE_FAILED", error); process.exitCode = 1; }',
    '  process.exit();',
    '}',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (value) => { if (value.includes("STOP")) void stop(); });',
    'try {',
    '  runtime = await startConfiguredServer();',
    '  console.log(`E2E_READY:${process.env.SERVER_PORT}`);',
    '} catch (error) {',
    '  console.error("E2E_START_FAILED", error);',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
    cwd: dirname(entryPath),
    env: { ...process.env, ...environment, DESKTOP_EMBEDDED_SERVER: '1', SERVER_PORT: String(runtimePort) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let resolveExit;
  const exited = new Promise((resolveExited) => { resolveExit = resolveExited; });
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let port;
  try {
    port = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`runtime did not become ready\n${stdout}\n${stderr}`)), 12_000);
      const check = () => {
        const match = stdout.match(/E2E_READY:(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      };
      child.stdout.on('data', check);
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      child.once('exit', (code, signal) => {
        if (!matchReady(stdout)) {
          clearTimeout(timer);
          rejectReady(new Error(`runtime exited before ready: code=${code} signal=${signal}\n${stdout}\n${stderr}`));
        }
      });
      check();
    });
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, sleep(1_000)]);
    throw error;
  }

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin.write('STOP\n');
      const stopped = await Promise.race([exited, sleep(3_000).then(() => undefined)]);
      if (!stopped && child.exitCode === null) child.kill();
      if (child.exitCode === null) await Promise.race([exited, sleep(1_000)]);
    },
  };
}

function matchReady(output) {
  return /E2E_READY:\d+/.test(output);
}

test('keeps a silent TCP raw waveform stream isolated from Modbus TCP fallback reads', async () => {
  const gateway = createMockGateway();
  await new Promise((resolveListen) => gateway.server.listen(0, '127.0.0.1', resolveListen));
  const gatewayPort = gateway.server.address().port;
  const dataDirectory = await mkdtemp(join(tmpdir(), 'flame-runtime-register-fallback-'));
  await writeFile(join(dataDirectory, 'system-config.json'), JSON.stringify({
    steps: [],
    flameConfig: {
      mode: 'TCP',
      ip: '127.0.0.1',
      port: gatewayPort,
      pollIntervalMs: 100,
      waveformMaxSamples: 1000,
      units: [{
        index: 1,
        address: 1,
        enabled: true,
        connMode: 'TCP',
        tcpHost: '127.0.0.1',
        tcpPort: gatewayPort,
      }],
    },
    lastUpdated: Date.now(),
  }));
  await writeFile(join(dataDirectory, 'plc-configs.json'), JSON.stringify({
    plcs: [{
      id: 'plc-register-fallback',
      name: 'mock PLC',
      enabled: false,
      mode: 'S7',
      ip: '127.0.0.1',
      port: 1,
      slaveId: 1,
      diCount: 18,
      doCount: 12,
      pollIntervalMs: 100,
    }],
    lastUpdated: Date.now(),
  }));

  const entryPath = process.env.FIELD_E2E_ENTRY
    ? resolve(process.env.FIELD_E2E_ENTRY)
    : fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const childEnvironment = {
    CLOSURE_MODE: 'field',
    APP_DATA_DIR: dataDirectory,
    TEMP: dataDirectory,
    TMP: dataDirectory,
  };
  let runtime;

  try {
    runtime = await launchRuntime(entryPath, childEnvironment);
    await waitForHealth(runtime.baseUrl, (health) => health.detectorTransportConnected === true);

    let devices;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      devices = await readJson(`${runtime.baseUrl}/api/flame/devices`);
      if (gateway.modbusReadRequestCount > 0) break;
      await sleep(25);
    }

    assert.equal(gateway.modbusReadRequestCount, 0, 'raw TCP waveform mode must not issue Modbus TCP fallback reads');
    assert.equal(devices.units[0].historySampleTotal, 0);
    assert.equal(devices.units[0].online, false);
    const health = await readJson(`${runtime.baseUrl}/api/health`);
    assert.equal(health.detectorTransportConnected, true);
  } finally {
    await runtime?.stop();
    await new Promise((resolveClose) => gateway.server.close(resolveClose));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('production field runtime keeps waveforms during auto-test and reconnects without a duplicate TCP session', async () => {
  const gateway = createMockGateway();
  await new Promise((resolveListen) => gateway.server.listen(0, '127.0.0.1', resolveListen));
  const gatewayPort = gateway.server.address().port;
  const dataDirectory = await mkdtemp(join(tmpdir(), 'flame-runtime-e2e-'));
  const units = Array.from({ length: 6 }, (_, offset) => ({
    index: offset + 1,
    address: 1,
    enabled: offset === 0,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: gatewayPort,
  }));
  await writeFile(join(dataDirectory, 'system-config.json'), JSON.stringify({
    steps: [],
    flameConfig: {
      mode: 'TCP',
      ip: '127.0.0.1',
      port: gatewayPort,
      pollIntervalMs: 100,
      waveformMaxSamples: 1000,
      units,
    },
    lastUpdated: Date.now(),
  }));
  await writeFile(join(dataDirectory, 'plc-configs.json'), JSON.stringify({
    plcs: [{
      id: 'plc-e2e',
      name: 'mock PLC',
      enabled: false,
      mode: 'S7',
      ip: '127.0.0.1',
      port: 1,
      slaveId: 1,
      diCount: 18,
      doCount: 12,
      pollIntervalMs: 100,
    }],
    lastUpdated: Date.now(),
  }));

  const entryPath = process.env.FIELD_E2E_ENTRY
    ? resolve(process.env.FIELD_E2E_ENTRY)
    : fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const childEnvironment = {
    CLOSURE_MODE: 'field',
    APP_DATA_DIR: dataDirectory,
    TEMP: dataDirectory,
    TMP: dataDirectory,
  };
  const waveform = createWaveformFrame();
  const waveformPump = setInterval(() => {
    for (const socket of gateway.sockets) {
      if (!socket.destroyed && socket.writable) socket.write(waveform);
    }
  }, 25);
  let runtime;
  let secondRuntime;
  let websocket;

  try {
    runtime = await launchRuntime(entryPath, childEnvironment);
    await waitForHealth(runtime.baseUrl, (health) => health.detectorDataStreamConnected === true);
    websocket = await connectWebSocket(runtime.baseUrl);
    await waitFor(() => websocket.waveformMessageCount > 0, 1_000);
    assert.equal(gateway.connectionCount, 1);
    assert.ok(gateway.broadcastRequestCount >= 1, 'the production runtime must send the configured-address mode command');

    secondRuntime = await launchRuntime(entryPath, childEnvironment);
    const secondHealth = await waitForHealth(secondRuntime.baseUrl, (health) => health.detectorTransportConnected === false);
    assert.equal(secondHealth.detectorTransportConnected, false, 'a second production runtime must be refused by the TCP lock');
    await sleep(300);
    assert.equal(gateway.connectionCount, 1, 'the refused runtime must not create a second sensor socket');
    await secondRuntime.stop();
    secondRuntime = undefined;

    const waveformMessagesBeforeAutoTest = websocket.waveformMessageCount;
    const autoTestPromise = readJson(`${runtime.baseUrl}/api/flame/auto-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledStepKeys: ['connection', 'version', 'params', 'status', 'realtime', 'mirror', 'report'] }),
    });
    const flapPromise = (async () => {
      for (let index = 0; index < 3; index += 1) {
        const expectedConnectionCount = gateway.connectionCount + 1;
        gateway.dropNextRead();
        await waitFor(() => gateway.droppedAt.length >= index + 1, 1_000);
        const droppedAt = gateway.droppedAt[index];
        await waitFor(() => gateway.connectionCount >= expectedConnectionCount, 1_000);
        await waitForHealth(runtime.baseUrl, (health) => health.detectorDataStreamConnected === true, 1_000);
        assert.ok(Date.now() - droppedAt < 1_000, `auto-test reconnect ${index + 1} exceeded one second`);
        await sleep(75);
      }
    })();
    const [autoTest, flapResult] = await Promise.all([
      autoTestPromise,
      flapPromise.then(() => true),
    ]);
    assert.equal(flapResult, true);
    assert.equal(autoTest.success, true);
    assert.equal(autoTest.report.passed, true, JSON.stringify({ report: autoTest.report, progress: websocket.autoTestProgress, drops: gateway.droppedAt }));
    assert.ok(
      websocket.waveformMessageCount > waveformMessagesBeforeAutoTest,
      'the WebSocket client must continue receiving waveform states during auto-test',
    );
    const deviceState = await readJson(`${runtime.baseUrl}/api/flame/devices`);
    assert.ok(deviceState.units[0].historySampleTotal > 0, 'waveforms must continue during the production auto-test');

    const oldSocket = gateway.sockets.values().next().value;
    assert.ok(oldSocket, 'the production runtime must own an active TCP socket');
    const droppedAt = Date.now();
    oldSocket.destroy();
    await waitForHealth(runtime.baseUrl, (health) => health.detectorTransportConnected === false, 1_000);
    assert.ok(Date.now() - droppedAt < 1_000, 'transport disconnect must be visible within one second');
    await waitFor(() => gateway.connectionCount >= 2, 1_000);
    await waitForHealth(runtime.baseUrl, (health) => health.detectorDataStreamConnected === true, 1_000);
    assert.ok(Date.now() - droppedAt < 1_000, 'waveform stream must reconnect within one second');
    assert.equal(gateway.connectionCount, 5, 'reconnect must replace the old session, not accumulate sessions');
    assert.equal(gateway.sockets.size, 1, 'only the replacement TCP session should remain active');
    assert.ok(gateway.broadcastRequestCount >= 2, 'the reconnect must resend the configured-address mode command');
  } finally {
    clearInterval(waveformPump);
    await websocket?.close();
    await secondRuntime?.stop();
    for (const socket of gateway.sockets) socket.destroy();
    await runtime?.stop();
    await new Promise((resolveClose) => gateway.server.close(resolveClose));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
