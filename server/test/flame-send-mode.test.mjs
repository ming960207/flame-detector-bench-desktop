import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FlameDetectorDevice,
  SEND_MODE_BROADCAST_FRAME_HEX,
} from '../dist/modbus/flame-detector-device.js';
import { FlameDetectorService } from '../dist/modbus/flame-detector-service.js';
import { calculateModbusCRC16, summarizeWaveformChannels } from '../dist/modbus/flame-data-decoder.js';

function createWaveformFrame() {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(offset, offset);
  return frame;
}

function createLongWaveformFrame() {
  const frame = Buffer.alloc(170);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < frame.length; offset += 2) frame.writeInt16LE(offset, offset);
  return frame;
}

function createSocket(onWrite) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.write = (data, callback) => {
    onWrite?.(Buffer.from(data), socket);
    queueMicrotask(() => callback?.());
    return true;
  };
  return socket;
}

function createWriteResponse(address = 1, quantity = 2) {
  const frame = Buffer.from([address, 0x10, 0x30, 0x00, (quantity >> 8) & 0xFF, quantity & 0xFF, 0, 0]);
  const crc = calculateModbusCRC16(frame.subarray(0, -2));
  frame[6] = crc & 0xFF;
  frame[7] = (crc >> 8) & 0xFF;
  return frame;
}

function createReadResponse(request, values = []) {
  const quantity = request.readUInt16BE(4);
  const response = Buffer.alloc(5 + quantity * 2);
  response[0] = request[0];
  response[1] = 0x03;
  response[2] = quantity * 2;
  for (let index = 0; index < quantity; index += 1) response.writeUInt16BE(values[index] ?? 0, 3 + index * 2);
  const crc = calculateModbusCRC16(response.subarray(0, -2));
  response[response.length - 2] = crc & 0xFF;
  response[response.length - 1] = (crc >>> 8) & 0xFF;
  return response;
}

function createModbusRealtimeFrame() {
  const registers = Array(67).fill(0);
  registers[3] = 0x0102;
  registers[4] = 0x0304;
  registers[5] = 0x0506;
  const frame = Buffer.alloc(5 + registers.length * 2);
  frame[0] = 1;
  frame[1] = 0x03;
  frame[2] = registers.length * 2;
  registers.forEach((value, index) => frame.writeUInt16BE(value, 3 + index * 2));
  const crc = calculateModbusCRC16(frame.subarray(0, -2));
  frame[frame.length - 2] = crc & 0xFF;
  frame[frame.length - 1] = (crc >> 8) & 0xFF;
  return frame;
}

function createUnitConfig(overrides = {}) {
  return {
    index: 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: 31001,
    ...overrides,
  };
}

const SEND_MODE_FRAME_HEX = SEND_MODE_BROADCAST_FRAME_HEX.toLowerCase();

async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}

test('retries the FF send-mode frame when the first socket write fails', async () => {
  const writes = [];
  let attempts = 0;
  const socket = {
    destroyed: false,
    writable: true,
    write(data, callback) {
      attempts += 1;
      writes.push(Buffer.from(data).toString('hex'));
      queueMicrotask(() => callback(attempts === 1 ? new Error('transient socket failure') : undefined));
      return true;
    },
  };
  const client = { _port: { _client: socket } };
  const unit = { index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31001 };
  const config = { mode: 'TCP', ip: '127.0.0.1', port: 31001, units: [unit] };
  const device = new FlameDetectorDevice(client, unit, config);

  await device.sendBroadcastSendMode();

  assert.equal(attempts, 2);
  assert.deepEqual(writes, [SEND_MODE_BROADCAST_FRAME_HEX.toLowerCase(), SEND_MODE_BROADCAST_FRAME_HEX.toLowerCase()]);
});

test('uses the FF broadcast frame for a TCP send-mode request', async () => {
  const writes = [];
  const socket = createSocket((data) => writes.push(data.toString('hex')));
  const client = { _port: { _client: socket } };
  const unit = { index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31001 };
  const config = { mode: 'TCP', ip: '127.0.0.1', port: 31001, units: [unit] };
  const device = new FlameDetectorDevice(client, unit, config);

  await device.sendBroadcastSendMode({ attempts: 1, retryDelayMs: 0 });

  assert.equal(writes[0], SEND_MODE_FRAME_HEX);
});

test('uses filtered waveform send mode when it is configured as the default', async () => {
  const writes = [];
  const socket = createSocket((data, currentSocket) => {
    writes.push(Buffer.from(data));
    setTimeout(() => currentSocket.emit('data', createWriteResponse()), 5);
  });
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const config = {
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    pollIntervalMs: 10_000,
    waveformSendMode: 'filtered',
    units: [unit],
  };
  const service = new FlameDetectorService(config);

  try {
    await service.initializeUnit(unit, client);
    await waitFor(() => service.getCurrentState().units[0].sendMode === 2, 1_000);

    assert.equal(writes[0]?.readUInt16BE(7), 2, 'filtered mode must write register value 0x0002');
    assert.equal(writes[0]?.readUInt16BE(9), 8, 'the legacy waveform stream selector must be preserved');
  } finally {
    await service.disconnect();
  }
});

test('waits for a validated response to the FF send-mode frame', async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.write = (data, callback) => {
    queueMicrotask(() => callback?.());
    setTimeout(() => socket.emit('data', createWriteResponse()), 20);
    return true;
  };
  const client = { _port: { _client: socket } };
  const unit = { index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31001 };
  const config = { mode: 'TCP', ip: '127.0.0.1', port: 31001, units: [unit] };
  const device = new FlameDetectorDevice(client, unit, config);

  let settled = false;
  const request = device.sendBroadcastSendMode({ attempts: 1, retryDelayMs: 0, waitForResponse: true, responseTimeoutMs: 100 })
    .finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, 'socket.write callback must not count as device acknowledgement');
  await request;
});

test('retries the FF broadcast frame until a validated response, then stops after waveform data', async () => {
  const writes = [];
  const socket = createSocket((data, currentSocket) => {
    writes.push(data.toString('hex'));
    if (writes.length === 2) {
      setTimeout(() => currentSocket.emit('data', createWriteResponse()), 5);
      setTimeout(() => currentSocket.emit('data', createWaveformFrame()), 10);
    }
  });
  const client = { _port: { _client: socket } };
  const unit = { index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31001 };
  const config = { mode: 'TCP', ip: '127.0.0.1', port: 31001, pollIntervalMs: 10_000, units: [unit] };
  const service = new FlameDetectorService(config);

  service.attachPushListener(unit, client);
  void service.initializeUnit(unit, client);
  await waitFor(() => service.getCurrentState().units[0].sendMode === 1, 2_000);
  await waitFor(() => service.getCurrentState().units[0].historySampleTotal > 0, 1_000);
  const writeCountAfterAck = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await service.disconnect();

  assert.equal(writeCountAfterAck, 2, `expected one retry before ACK, got ${writes.length}`);
  assert.equal(writes.length, writeCountAfterAck, 'a valid waveform must stop the retry loop');
  assert.ok(writes.every((frame) => frame === SEND_MODE_FRAME_HEX));
});

test('continues sending FF while the mode is acknowledged but no waveform is parsed', async () => {
  const writes = [];
  const socket = createSocket((data, currentSocket) => {
    writes.push(data.toString('hex'));
    setTimeout(() => currentSocket.emit('data', createWriteResponse()), 5);
  });
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31001, pollIntervalMs: 10_000, units: [unit] });

  try {
    service.attachPushListener(unit, client);
    await service.initializeUnit(unit, client);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    assert.ok(writes.length >= 2, 'an acknowledged mode request without waveform must be retried');
    assert.ok(writes.every((frame) => frame === SEND_MODE_FRAME_HEX));
    assert.equal(service.getCurrentState().units[0].historySampleTotal, 0, 'the test must remain in the no-waveform path');
  } finally {
    await service.disconnect();
  }
});

test('keeps TCP waveform mode on the raw stream instead of issuing Modbus TCP fallback reads', async () => {
  const requests = [];
  let waveformSent = false;
  let waveformTimer;
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-raw-stream-'));
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      requests.push(Buffer.from(chunk));
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 13) {
        const offset = buffer.indexOf(Buffer.from(SEND_MODE_FRAME_HEX, 'hex'));
        if (offset < 0) {
          buffer = buffer.subarray(Math.max(0, buffer.length - 12));
          return;
        }
        if (offset > 0) buffer = buffer.subarray(offset);
        if (buffer.length < 13) return;
        buffer = buffer.subarray(13);
        socket.write(createWriteResponse());
        if (!waveformSent) {
          waveformSent = true;
          socket.write(createWaveformFrame());
          waveformTimer = setInterval(() => socket.write(createWaveformFrame()), 30);
        }
      }
    });
    socket.once('close', () => clearInterval(waveformTimer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService(
    { mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] },
    { lockPath: join(lockDirectory, 'detector.lock') },
  );

  try {
    await service.connect();
    await waitFor(() => service.getCurrentState().units[0].historySampleTotal > 0, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.ok(service.getCurrentState().units[0].historySampleTotal > 20, 'continuous raw waveform frames must keep being recognized');

    const aggregate = Buffer.concat(requests);
    let cursor = 0;
    while (cursor < aggregate.length) {
      assert.equal(
        aggregate.subarray(cursor, cursor + 13).toString('hex'),
        SEND_MODE_FRAME_HEX,
        'TCP waveform mode must not send an MBAP-wrapped fallback request to the raw stream',
      );
      cursor += 13;
    }
  } finally {
    await service.disconnect();
    await new Promise((resolve) => server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('re-requests waveform mode when the detector reconnects behind an open serial-server TCP session', async () => {
  let connectionCount = 0;
  const framesReceived = [];
  const server = createServer((socket) => {
    connectionCount += 1;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 13) {
        const offset = buffer.indexOf(Buffer.from(SEND_MODE_FRAME_HEX, 'hex'));
        if (offset < 0) {
          buffer = buffer.subarray(Math.max(0, buffer.length - 12));
          break;
        }
        if (offset > 0) buffer = buffer.subarray(offset);
        if (buffer.length < 13) break;
        framesReceived.push(buffer.subarray(0, 13).toString('hex'));
        buffer = buffer.subarray(13);
        socket.write(createWriteResponse());
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] });
  service.waveformStaleTimeoutMs = () => 100;

  try {
    await service.connect();
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    assert.equal(connectionCount, 1, 'waveform silence must not reconnect the serial-server TCP session');
    assert.ok(framesReceived.length >= 2, 'waveform silence must restart the mode request without replacing the TCP session');
    assert.equal(service.getStatus().connected, false, 'detector connected state must follow waveform data');
    assert.equal(service.getStatus().transportConnected, true, 'serial-server TCP session should remain connected');
    assert.equal(service.getStatus().dataStreamConnected, false, 'missing waveform data must be visible separately');
  } finally {
    await service.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('does not leave a TCP client behind when disconnect races with connect', async () => {
  let connectionCount = 0;
  let disconnectPromise;
  let service;
  const sockets = new Set();
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-connect-race-'));
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (!disconnectPromise) disconnectPromise = service.disconnect();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  service = new FlameDetectorService(
    { mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] },
    { lockPath: join(lockDirectory, 'detector.lock') },
  );

  try {
    const connecting = service.connect();
    await waitFor(() => Boolean(disconnectPromise), 1_000);
    await disconnectPromise;
    await connecting;
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(connectionCount, 1);
    assert.equal(service.getStatus().transportConnected, false, 'disconnect must win over an in-flight connect');
    assert.equal(sockets.size, 0, 'the raced TCP client must be closed');
  } finally {
    await service.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('does not leave a replacement TCP client when disconnect races with reconnect', async () => {
  let connectionCount = 0;
  let disconnectPromise;
  let service;
  const sockets = new Set();
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-reconnect-race-'));
  const server = createServer((socket) => {
    const connectionNumber = ++connectionCount;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let modeHandled = false;
    socket.on('data', (chunk) => {
      if (connectionNumber !== 1 || modeHandled || !chunk.includes(Buffer.from(SEND_MODE_FRAME_HEX, 'hex'))) return;
      modeHandled = true;
      socket.write(createWriteResponse());
      socket.write(createWaveformFrame());
      setTimeout(() => socket.destroy(), 30);
    });
    if (connectionNumber === 2 && !disconnectPromise) disconnectPromise = service.disconnect();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  service = new FlameDetectorService(
    { mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] },
    { lockPath: join(lockDirectory, 'detector.lock') },
  );

  try {
    await service.connect();
    await waitFor(() => connectionCount >= 2, 2_000);
    await waitFor(() => Boolean(disconnectPromise), 1_000);
    await disconnectPromise;
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(connectionCount, 2);
    assert.equal(service.getStatus().transportConnected, false, 'disconnect must cancel an in-flight reconnect');
    assert.equal(sockets.size, 0, 'the raced replacement TCP client must be closed');
  } finally {
    await service.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('reloads detector configuration without accumulating TCP sessions', async () => {
  let connectionCount = 0;
  const sockets = new Set();
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (chunk.includes(Buffer.from(SEND_MODE_FRAME_HEX, 'hex'))) {
        socket.write(createWriteResponse());
        socket.write(createWaveformFrame());
      }
    });
  });
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-config-reload-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService(
    { mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] },
    { lockPath: join(lockDirectory, 'detector.lock') },
  );

  try {
    await service.connect();
    await waitFor(() => service.getCurrentState().units[0].historySampleTotal > 0, 1_000);
    const nextConfig = service.getConfig();
    nextConfig.pollIntervalMs = 200;
    await service.disconnect();
    service.updateConfig(nextConfig);
    await service.connect();
    await waitFor(() => connectionCount >= 2 && service.getCurrentState().units[0].historySampleTotal > 0, 1_000);

    assert.equal(connectionCount, 2);
    assert.equal(sockets.size, 1, 'configuration reload must leave one active TCP session');
    assert.equal(service.getStatus().transportConnected, true);
  } finally {
    await service.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('re-requests mode and keeps the last recognized waveform visible when the stream is temporarily stale', async () => {
  const writes = [];
  let modeRequests = 0;
  const socket = createSocket((data, currentSocket) => {
    writes.push(data.toString('hex'));
    modeRequests += 1;
    setTimeout(() => currentSocket.emit('data', createWriteResponse()), 5);
    if (modeRequests === 2) setTimeout(() => currentSocket.emit('data', createWaveformFrame(20)), 10);
  });
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const config = { mode: 'TCP', ip: '127.0.0.1', port: 31001, pollIntervalMs: 100, units: [unit] };
  const service = new FlameDetectorService(config);
  service.waveformStaleTimeoutMs = () => 100;
  const states = [];
  service.on('flame_state', (state) => states.push(state));

  service.attachPushListener(unit, client);
  await service.initializeUnit(unit, client);
  const writesBeforeWaveform = writes.length;

  socket.emit('data', createWaveformFrame());
  await new Promise((resolve) => setImmediate(resolve));

  const stateAfterWaveform = service.getCurrentState().units[0];
  const totalAfterWaveform = stateAfterWaveform.historySampleTotal;
  assert.equal(stateAfterWaveform.online, true);
  assert.ok(stateAfterWaveform.historySamples.length > 0);
  assert.ok(states.at(-1).units[0].historySamples.length > 0);

  const writesAfterWaveform = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const staleState = service.getCurrentState().units[0];
  await service.disconnect();

  assert.ok(writesBeforeWaveform >= 1);
  assert.equal(writesAfterWaveform, writesBeforeWaveform);
  assert.ok(writes.length > writesAfterWaveform, 'waveform timeout must re-request mode for a reconnected detector');
  assert.ok(staleState.historySamples.length > 0, 'temporary waveform silence must not erase the last recognized waveform');
  assert.ok(staleState.historySampleTotal > totalAfterWaveform, 'waveform history must resume after the detector switches mode again');
  assert.ok(writes.every((frame) => frame === SEND_MODE_FRAME_HEX));
});

test('keeps a live waveform online when the send-mode command has no acknowledgement', async () => {
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31001, pollIntervalMs: 100, units: [unit] });

  service.attachPushListener(unit, client);
  const initializing = service.initializeUnit(unit, client);
  const waveformTimer = setInterval(() => socket.emit('data', createWaveformFrame()), 200);
  setTimeout(() => socket.emit('data', createWaveformFrame()), 20);
  try {
    await initializing;
  } finally {
    clearInterval(waveformTimer);
  }

  const state = service.getCurrentState().units[0];
  assert.equal(state.online, true);
  assert.ok(state.historySamples.length > 0);
  assert.equal(service.getStatus().dataStreamConnected, true);
  await service.disconnect();
});

test('reports a missing send-mode acknowledgement before the one-second response budget', async () => {
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31001, pollIntervalMs: 100, units: [unit] });
  const startedAt = Date.now();

  const initializing = service.initializeUnit(unit, client);
  await waitFor(() => Boolean(service.getCurrentState().units[0].lastError), 950);
  assert.ok(Date.now() - startedAt < 950);
  await initializing;
  await service.disconnect();
});

test('waits for the initial send-mode handshake before starting auto-test Modbus reads', async () => {
  let modeAckTimer;
  let waveformTimer;
  let modeAckDue = 0;
  let overlappingRead = false;
  let sensorSocket;
  const server = createServer((socket) => {
    sensorSocket = socket;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        if (
          buffer.length >= 6
          && buffer[0] === 0xFF
          && buffer[1] === 0x10
          && buffer.readUInt16BE(2) === 0x3000
          && buffer.readUInt16BE(4) === 2
        ) {
          if (buffer.length < 13) return;
          buffer = buffer.subarray(13);
          modeAckDue = Date.now() + 600;
          modeAckTimer = setTimeout(() => socket.write(createWriteResponse()), 600);
          continue;
        }
        if (buffer.length < 8) return;
        if (buffer[0] !== 1 || buffer[1] !== 0x03) {
          buffer = buffer.subarray(1);
          continue;
        }
        const request = buffer.subarray(0, 8);
        buffer = buffer.subarray(8);
        {
          if (Date.now() < modeAckDue) overlappingRead = true;
          const startAddress = request.readUInt16BE(2);
          socket.write(createReadResponse(request, startAddress === 0x8000 ? [1] : []));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 10_000, units: [unit] });

  try {
    await service.connect();
    await waitFor(() => Boolean(sensorSocket && service.devices.get(1)));
    const device = service.devices.get(1);
    device.readCommAddress = () => device.readRegisters(0x8000, 1);
    waveformTimer = setInterval(() => sensorSocket?.write(createWaveformFrame()), 30);
    const report = await service.runAutoTest(() => {}, { enabledStepKeys: ['connection'] });

    assert.equal(report.passed, true);
    assert.equal(overlappingRead, false, 'auto-test reads must wait for the initial mode handshake');
    assert.ok(service.getCurrentState().units[0].historySampleTotal > 0);
  } finally {
    clearTimeout(modeAckTimer);
    clearInterval(waveformTimer);
    await service.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('waits for the replacement handshake before retrying an auto-test read after reconnect', async () => {
  let connectionCount = 0;
  let droppedFirstRead = false;
  let overlappingRead = false;
  let waveformTimer;
  const sockets = new Set();
  const modeAckTimers = new Set();
  const server = createServer((socket) => {
    const connectionNumber = ++connectionCount;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let modeAckDue = 0;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        if (
          buffer.length >= 6
          && buffer[0] === 0xFF
          && buffer[1] === 0x10
          && buffer.readUInt16BE(2) === 0x3000
          && buffer.readUInt16BE(4) === 2
        ) {
          if (buffer.length < 13) return;
          buffer = buffer.subarray(13);
          const delay = connectionNumber === 1 ? 20 : 600;
          modeAckDue = Date.now() + delay;
          const timer = setTimeout(() => {
            modeAckTimers.delete(timer);
            if (!socket.destroyed) socket.write(createWriteResponse());
          }, delay);
          modeAckTimers.add(timer);
          continue;
        }
        if (buffer.length < 8) return;
        if (buffer[0] !== 1 || buffer[1] !== 0x03) {
          buffer = buffer.subarray(1);
          continue;
        }
        const request = buffer.subarray(0, 8);
        buffer = buffer.subarray(8);
        if (connectionNumber === 1 && !droppedFirstRead) {
          droppedFirstRead = true;
          socket.destroy();
          continue;
        }
        if (Date.now() < modeAckDue) overlappingRead = true;
        socket.write(createReadResponse(request, [1]));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 10_000, units: [unit] });

  try {
    await service.connect();
    waveformTimer = setInterval(() => {
      for (const socket of sockets) {
        if (!socket.destroyed && socket.writable) socket.write(createWaveformFrame());
      }
    }, 30);
    await waitFor(() => connectionCount === 1 && service.getCurrentState().units[0].historySampleTotal > 0);
    const report = await service.runAutoTest(() => {}, { enabledStepKeys: ['connection'] });

    assert.equal(report.passed, true);
    assert.equal(droppedFirstRead, true);
    assert.equal(connectionCount, 2);
    assert.equal(overlappingRead, false, 'retry reads must wait for the replacement mode handshake');
    assert.ok(service.getCurrentState().units[0].historySampleTotal > 0);
  } finally {
    clearInterval(waveformTimer);
    for (const timer of modeAckTimers) clearTimeout(timer);
    await service.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeps receiving waveforms while the automatic test is running', async () => {
  const waveform = createWaveformFrame();
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-auto-test-'));
  const sockets = new Set();
  let sensorSocket;
  const server = createServer((socket) => {
    sensorSocket = socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (chunk.includes(Buffer.from(SEND_MODE_FRAME_HEX, 'hex'))) socket.write(createWriteResponse());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService(
    { mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] },
    { lockPath: join(lockDirectory, 'detector.lock') },
  );

  try {
    await service.connect();
    await waitFor(() => Boolean(sensorSocket));
    const device = service.devices.get(1);
    device.readCommAddress = async () => 1;
    device.readSoftwareVersion = async () => 'test-version';
    device.readRuntime = async () => 0;
    device.readAllBasicParams = async () => ({ sensitivity: 1 });
    device.readAlarmStatus = async () => ({ fault: false });
    device.readRealtimeFeatures = async () => ({ features: [{}], fifoCount: 1, samples: [{}] });
    device.readMirrorStatus = async () => ({ enabled: false, normal: true });

    let progressCount = 0;
    const runningTest = service.runAutoTest(() => { progressCount += 1; }, {
      enabledStepKeys: ['connection', 'version', 'params', 'status', 'realtime', 'mirror', 'report'],
    });
    const waveformPump = setInterval(() => sensorSocket?.write(waveform), 30);
    try {
      const report = await runningTest;
      const state = service.getCurrentState().units[0];
      assert.equal(report.devices['1'].passed, true);
      assert.ok(progressCount > 0);
      assert.ok(state.historySampleTotal > 0, 'waveform frames must be processed during auto-test');
      assert.equal(service.getStatus().dataStreamConnected, true);
    } finally {
      clearInterval(waveformPump);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await service.disconnect();
    await new Promise((resolve) => server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('coalesces high-rate waveform broadcasts while publishing disconnect immediately', async () => {
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig({ tcpPort: 31003 });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31003, units: [unit] });
  const states = [];

  service.on('flame_state', (state) => states.push(state));
  service.attachPushListener(unit, client);
  const originalLog = console.log;
  const waveformLogs = [];
  console.log = (...args) => waveformLogs.push(args.join(' '));
  try {
    for (let index = 0; index < 20; index += 1) socket.emit('data', createWaveformFrame());
  } finally {
    console.log = originalLog;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(waveformLogs.length, 0, 'high-rate waveform handling must not write per-frame console logs');
  assert.ok(states.length <= 1, `expected one immediate broadcast, got ${states.length}`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(states.length, 2, 'pending waveform updates should flush once per broadcast window');

  socket.emit('close');
  assert.equal(states.at(-1).units[0].online, false, 'disconnect must be broadcast without waiting for the throttle window');
  await service.disconnect();
});

test('accepts a split Modbus realtime push frame and updates the port-owned device', async () => {
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31001, units: [unit] });

  service.attachPushListener(unit, client);
  const frame = createModbusRealtimeFrame();
  socket.emit('data', frame.subarray(0, 9));
  socket.emit('data', frame.subarray(9));
  await new Promise((resolve) => setImmediate(resolve));

  const state = service.getCurrentState().units[0];
  assert.equal(state.online, true);
  assert.equal(state.sourceReady, true);
  assert.equal(state.protocol, 'standard');
  assert.ok(state.historySamples.length > 0);
  assert.ok(state.historySampleTotal > 0);
  await service.disconnect();
});

test('accepts the captured 29-byte 5A A5 waveform after the FF ACK', async () => {
  const waveform = Buffer.from(
    '5A A5 01 80 61 01 21 01 01 01 01 80 71 01 51 01 11 80 81 01 81 01 01 80 81 01 51 01 33'.replaceAll(' ', ''),
    'hex',
  );
  const socket = createSocket((_data, currentSocket) => {
    setTimeout(() => currentSocket.emit('data', createWriteResponse()), 5);
  });
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig({ tcpPort: 31005 });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31005, units: [unit] });

  service.attachPushListener(unit, client);
  await service.initializeUnit(unit, client);
  socket.emit('data', waveform.subarray(0, 11));
  socket.emit('data', waveform.subarray(11));
  await new Promise((resolve) => setImmediate(resolve));

  const state = service.getCurrentState().units[0];
  assert.equal(state.online, true);
  assert.equal(state.historySampleTotal, 4);
  assert.equal(state.rawSamples.length, 4);
  const normalizedMetrics = summarizeWaveformChannels(state.historySamples);
  const rawMetrics = summarizeWaveformChannels(state.rawHistorySamples);
  assert.equal(state.probe1, normalizedMetrics.probe1.fluctuation, '探头 1 应显示当前窗口波动值');
  assert.equal(state.probe2, normalizedMetrics.probe2.fluctuation, '探头 2 应显示当前窗口波动值');
  assert.equal(state.probe3, normalizedMetrics.probe3.fluctuation, '探头 3 应显示当前窗口波动值');
  assert.equal(state.probe1Absolute, rawMetrics.probe1.absolute, '探头绝对值应来自当前窗口');

  service.clearWaveformHistory();
  const cleared = service.getCurrentState().units[0];
  assert.equal(cleared.historySamples.length, 0);
  assert.equal(cleared.rawHistorySamples.length, 0);
  assert.equal(cleared.probe1Fluctuation, 0, '开始干扰测试后不应继续显示旧窗口指标');
  await service.disconnect();
});

test('accepts the captured 27-byte detector waveform frame', async () => {
  const waveform = Buffer.from(
    '5A A5 01 80 41 01 31 01 11 80 91 01 81 01 01 80 81 01 71 01 01 80 41 01 11 01 E3'.replaceAll(' ', ''),
    'hex',
  );
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig();
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31001, units: [unit] });

  service.attachPushListener(unit, client);
  socket.emit('data', waveform);
  await new Promise((resolve) => setImmediate(resolve));

  const state = service.getCurrentState().units[0];
  assert.equal(waveform.length, 27);
  assert.equal(state.online, true);
  assert.equal(state.historySampleTotal, 4);
  assert.deepEqual(state.rawSamples[0], { probe1: -32767, probe2: 321, probe3: 305 });
  await service.disconnect();
});

test('accepts a split 170-byte raw waveform frame through the live TCP listener', async () => {
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig({ tcpPort: 31004 });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port: 31004, units: [unit] });

  service.attachPushListener(unit, client);
  const frame = createLongWaveformFrame();
  socket.emit('data', frame.subarray(0, 71));
  socket.emit('data', frame.subarray(71));
  await new Promise((resolve) => setImmediate(resolve));

  const state = service.getCurrentState().units[0];
  assert.equal(state.online, true);
  assert.equal(state.sourceReady, true);
  assert.equal(state.protocol, 'standard');
  assert.equal(state.historySampleTotal, 28);
  assert.equal(state.historySamples.length, 28);
  await service.disconnect();
});

test('treats an actual serial-server TCP socket close as transport failure, not as waveform evidence', async () => {
  const socket = createSocket();
  const client = { _port: { _client: socket } };
  const unit = createUnitConfig({ tcpPort: 31002 });
  const config = { mode: 'TCP', ip: '127.0.0.1', port: 31002, units: [unit] };
  const service = new FlameDetectorService(config);

  service.attachPushListener(unit, client);
  await service.initializeUnit(unit, client);
  socket.emit('data', createWaveformFrame());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getCurrentState().units[0].online, true);

  socket.emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  const stateAfterClose = service.getCurrentState().units[0];
  assert.equal(stateAfterClose.online, false);
  assert.equal(stateAfterClose.sourceReady, false);
  assert.equal(stateAfterClose.syncOk, false);
  assert.equal(service.getStatus().transportConnected, false);
  assert.equal(service.getStatus().dataStreamConnected, false);
  await service.disconnect();
});

test('reconnects only after the serial-server TCP socket itself drops', async () => {
  const waveform = createWaveformFrame();
  let connectionCount = 0;
  let closedAt = 0;
  const framesReceived = [];
  const server = createServer((socket) => {
    const connectionNumber = ++connectionCount;
    let buffer = Buffer.alloc(0);
    let waveformSent = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 13) {
        const offset = buffer.indexOf(Buffer.from(SEND_MODE_FRAME_HEX, 'hex'));
        if (offset < 0) {
          buffer = buffer.subarray(Math.max(0, buffer.length - 12));
          break;
        }
        if (offset > 0) buffer = buffer.subarray(offset);
        if (buffer.length < 13) break;
        framesReceived.push(buffer.subarray(0, 13).toString('hex'));
        buffer = buffer.subarray(13);
        socket.write(createWriteResponse());
        if (!waveformSent) {
          waveformSent = true;
          socket.write(waveform);
          if (connectionNumber === 1) setTimeout(() => {
            closedAt = Date.now();
            socket.destroy();
          }, 30);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const unit = createUnitConfig({ tcpPort: port });
  const service = new FlameDetectorService({ mode: 'TCP', ip: '127.0.0.1', port, pollIntervalMs: 100, units: [unit] });

  try {
    await service.connect();
    await waitFor(() => connectionCount >= 2 && service.getCurrentState().units[0].online);
    assert.ok(closedAt > 0, 'the first serial-server socket should close during the test');
    assert.ok(Date.now() - closedAt < 1_000, `reconnect took ${Date.now() - closedAt}ms`);
    assert.ok(framesReceived.length >= 2);
    assert.ok(framesReceived.every((frame) => frame === SEND_MODE_FRAME_HEX));
  } finally {
    await service.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});
