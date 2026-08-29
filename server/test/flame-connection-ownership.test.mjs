import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import ModbusRTU from 'modbus-serial';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlameDetectorService } from '../dist/modbus/flame-detector-service.js';

function createSocket() {
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (data, callback) => {
    callback?.();
    return true;
  };
  return socket;
}

function createClient(socket) {
  return { _port: { _client: socket } };
}

function calculateModbusCRC16(buffer) {
  let crc = 0xFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
  }
  return crc;
}

function createWriteResponse() {
  const frame = Buffer.from([1, 0x10, 0x30, 0x00, 0x00, 0x02, 0x00, 0x00]);
  const crc = calculateModbusCRC16(frame.subarray(0, -2));
  frame[6] = crc & 0xFF;
  frame[7] = (crc >>> 8) & 0xFF;
  return frame;
}

function createWaveformFrame(value) {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(value + offset, offset);
  return frame;
}

test('ignores a queued waveform callback from a replaced TCP client', async () => {
  const firstSocket = createSocket();
  const secondSocket = createSocket();
  const firstClient = createClient(firstSocket);
  const secondClient = createClient(secondSocket);
  const unit = {
    index: 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: 31001,
  };
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    units: [unit],
  });

  try {
    service.pool.set('tcp:127.0.0.1:31001', { client: firstClient, ok: true });
    service.attachPushListener(unit, firstClient);
    const staleCallback = service.socketBindings.get(1).onData;
    firstSocket.emit('data', createWaveformFrame(100));
    await new Promise((resolve) => setImmediate(resolve));
    const countAfterFirstClient = service.getCurrentState().units[0].historySampleTotal;
    assert.ok(countAfterFirstClient > 0);

    service.pool.set('tcp:127.0.0.1:31001', { client: secondClient, ok: true });
    service.attachPushListener(unit, secondClient);
    staleCallback(createWaveformFrame(200));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      service.getCurrentState().units[0].historySampleTotal,
      countAfterFirstClient,
      'a delayed callback from the old socket must not update the replacement client state',
    );

    secondSocket.emit('data', createWaveformFrame(300));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(service.getCurrentState().units[0].historySampleTotal > countAfterFirstClient);
  } finally {
    await service.disconnect();
  }
});

test('does not let a slow old handshake block initialization of the replacement client', async () => {
  const firstSocket = createSocket();
  const secondSocket = createSocket();
  const firstClient = createClient(firstSocket);
  const secondClient = createClient(secondSocket);
  secondSocket.write = (data, callback) => {
    callback?.();
    setImmediate(() => secondSocket.emit('data', createWriteResponse()));
    return true;
  };
  const unit = {
    index: 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: 31001,
  };
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    units: [unit],
  });

  try {
    service.pool.set('tcp:127.0.0.1:31001', { client: firstClient, ok: true });
    const oldInitialization = service.initializeUnit(unit, firstClient);
    await new Promise((resolve) => setTimeout(resolve, 20));

    service.pool.set('tcp:127.0.0.1:31001', { client: secondClient, ok: true });
    service.attachPushListener(unit, secondClient);
    const replacementStartedAt = Date.now();
    const replacementInitialization = service.initializeUnit(unit, secondClient);
    await replacementInitialization;

    assert.ok(Date.now() - replacementStartedAt < 300, 'replacement handshake must not wait for the old 700ms timeout');
    assert.equal(service.initializingUnits.has(1), false, 'the current client initialization must be released');
    await oldInitialization;
  } finally {
    await service.disconnect();
  }
});

test('opens detector TCP as a raw RTU byte stream without calling connectTCP', async () => {
  const originalConnectTCP = ModbusRTU.prototype.connectTCP;
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-connect-timeout-'));
  const requests = [];
  const server = createServer((socket) => socket.on('data', (data) => {
    requests.push(Buffer.from(data));
    socket.write(createWriteResponse());
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  ModbusRTU.prototype.connectTCP = function forbiddenDetectorTcpConnect() {
    throw new Error('火焰探测器不得调用 modbus-serial.connectTCP()');
  };
  const unit = {
    index: 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: port,
  };
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port,
    units: [unit],
  }, { lockPath: join(lockDirectory, 'detector.lock') });
  service.on('error', () => {});

  try {
    await service.connect();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(requests.length > 0, 'the raw TCP socket must receive the send-mode request');
    assert.equal(requests[0].subarray(0, 13).toString('hex'), 'ff10300000020400010008c043');
  } finally {
    ModbusRTU.prototype.connectTCP = originalConnectTCP;
    await service.disconnect();
    await new Promise((resolve) => server.close(resolve));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});

test('keeps waveform listeners active for every configured TCP port', async () => {
  const servers = [];
  const sockets = [];
  const ports = [];
  const lockDirectory = await mkdtemp(join(tmpdir(), 'flame-detector-multi-port-'));
  const frame = createWaveformFrame(200);

  try {
    for (let index = 0; index < 3; index += 1) {
      const server = createServer((socket) => {
        sockets.push(socket);
        setTimeout(() => socket.write(frame), 10 + index * 10);
      });
      servers.push(server);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      ports.push(server.address().port);
    }

    const service = new FlameDetectorService({
      mode: 'TCP',
      ip: '127.0.0.1',
      port: ports[0],
      units: ports.map((port, index) => ({
        index: index + 1,
        address: 1,
        enabled: true,
        connMode: 'TCP',
        tcpHost: '127.0.0.1',
        tcpPort: port,
      })),
    }, { lockPath: join(lockDirectory, 'detector.lock') });
    service.on('error', () => {});

    await service.connect();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && service.getCurrentState().units.some((unit) => unit.historySampleTotal === 0)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual(
      service.getCurrentState().units.slice(0, 3).map((unit) => unit.historySampleTotal > 0),
      [true, true, true],
    );
    await service.disconnect();
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(lockDirectory, { recursive: true, force: true });
  }
});
