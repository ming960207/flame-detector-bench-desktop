import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import test from 'node:test';
import { DetectorStartupTracker } from '../src/modbus/detector-startup.js';
import { FlameDetectorService } from '../src/modbus/flame-detector-service.js';
import { SEND_MODE_BROADCAST_FRAME_HEX } from '../src/modbus/flame-detector-device.js';
import { calculateModbusCRC16 } from '../src/modbus/flame-data-decoder.js';
import { normalizeFlameConfig } from '../src/closure/field-status-server.js';

test('detector startup becomes TEST_READY only after five consecutive valid frames', () => {
  let now = 1_000;
  const tracker = new DetectorStartupTracker(1, 1, () => now);

  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);
  tracker.markModeSwitchOk();

  for (let index = 0; index < 4; index += 1) {
    now += 10;
    const snapshot = tracker.observeFrame([{ probe1: 8, probe2: 2_772, probe3: 3_275 }]);
    assert.equal(snapshot.state, 'FIRST_FRAME_RECEIVED');
    assert.equal(snapshot.channelValidStreak, index + 1);
  }

  now += 10;
  const ready = tracker.observeFrame([{ probe1: 8, probe2: 2_772, probe3: 3_275 }]);
  assert.equal(ready.state, 'TEST_READY');
  assert.equal(ready.firstFrameAt, 1_010);
  assert.equal(ready.firstValidSampleAt, 1_010);
  assert.equal(ready.channelFirstValidAt.probe1, 1_010);
  assert.equal(ready.channelFirstValidAt.probe2, 1_010);
  assert.equal(ready.channelFirstValidAt.probe3, 1_010);
  assert.equal(ready.channelSyncAt, 1_050);
  assert.equal(ready.testReadyAt, 1_050);
});

test('an invalid channel breaks the consecutive-frame barrier', () => {
  const tracker = new DetectorStartupTracker(2, 1, () => 2_000);
  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);
  tracker.markModeSwitchOk();

  for (let index = 0; index < 4; index += 1) {
    tracker.observeFrame([{ probe1: 1, probe2: 2, probe3: 3 }]);
  }
  const pending = tracker.observeFrame([{ probe1: Number.NaN, probe2: 2, probe3: 3 }]);
  assert.equal(pending.state, 'FIRST_FRAME_RECEIVED');
  assert.equal(pending.channelValidStreak, 0);
  assert.equal(pending.testReadyAt, null);
});

test('valid frames without a confirmed mode switch never become test ready', () => {
  const tracker = new DetectorStartupTracker(3, 1, () => 3_000);
  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);

  for (let index = 0; index < 5; index += 1) {
    tracker.observeFrame([{ probe1: 1, probe2: 2, probe3: 3 }]);
  }

  const pending = tracker.snapshot();
  assert.equal(pending.state, 'FIRST_FRAME_RECEIVED');
  assert.equal(pending.channelSyncAt, 3_000);
  assert.equal(pending.testReadyAt, null);
  const ready = tracker.markModeSwitchOk();
  assert.equal(ready.state, 'TEST_READY');
  assert.equal(ready.testReadyAt, 3_000);
});

test('startup can wait for the vertical lower limit without becoming a terminal failure', () => {
  const tracker = new DetectorStartupTracker(4, 1, () => 4_000);
  tracker.markPowerOn();
  tracker.markCommunicationReady();
  assert.equal(tracker.markWaitingForLowerLimit().state, 'WAITING_FOR_VERTICAL_LOWER_LIMIT');
  assert.equal(tracker.markModeSwitching(4).state, 'MODE_SWITCHING');
  assert.equal(tracker.snapshot().failureReason, undefined);
});

test('flame service exposes the vertical lower-limit gate for continuous ACK retries', async () => {
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31_001,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31_001 }],
  });
  assert.equal(service.getReadyReport()?.verticalDownLimitGateEnabled, true);
  assert.equal(service.getReadyReport()?.verticalDownLimitReached, false);
  service.setVerticalDownLimit(true);
  assert.equal(service.getReadyReport()?.verticalDownLimitReached, true);
  await service.disconnect();
});

test('disabling the lower-limit gate allows immediate waveform mode initialization', async () => {
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31_001,
    waveformModeSwitchLowerLimitGateEnabled: false,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31_001 }],
  });
  const report = service.getReadyReport();
  assert.equal(report.verticalDownLimitGateEnabled, false);
  assert.notEqual(report.units[0]?.startup.state, 'WAITING_FOR_VERTICAL_LOWER_LIMIT');
  await service.disconnect();
});

test('preparing a new waveform batch drops stale parser bytes and last-push state', () => {
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31_001,
    waveformModeSwitchLowerLimitGateEnabled: false,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31_001 }],
  }, {
    deferWaveformUntilInspection: true,
  });
  const internal = service as unknown as {
    pushBuffers: Map<number, Buffer>;
    modbusPushBuffers: Map<number, Buffer>;
    lastPushAt: Map<number, number>;
  };
  internal.pushBuffers.set(1, Buffer.from([0x5A]));
  internal.modbusPushBuffers.set(1, Buffer.from([1, 0x03]));
  internal.lastPushAt.set(1, Date.now());

  service.prepareWaveformStartup('batch-reset-parser');

  assert.equal(internal.pushBuffers.has(1), false);
  assert.equal(internal.modbusPushBuffers.has(1), false);
  assert.equal(internal.lastPushAt.has(1), false);
});

test('lower-limit gate setting survives flame configuration normalization', () => {
  const current = {
    mode: 'TCP' as const,
    ip: '127.0.0.1',
    port: 31_001,
    waveformModeSwitchLowerLimitGateEnabled: true,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP' as const, tcpHost: '127.0.0.1', tcpPort: 31_001 }],
  };
  assert.equal(
    normalizeFlameConfig({ waveformModeSwitchLowerLimitGateEnabled: false }, current).waveformModeSwitchLowerLimitGateEnabled,
    false,
  );
});

function modeAck(): Buffer {
  const body = Buffer.from([0x01, 0x10, 0x30, 0x00, 0x00, 0x02]);
  const crc = calculateModbusCRC16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >>> 8) & 0xFF])]);
}

async function listenModeServer(index: number, receivedAt: number[], requests: Buffer[] = []): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let acknowledged = false;
    socket.on('data', (data) => {
      requests.push(Buffer.from(data));
      if (acknowledged) return;
      acknowledged = true;
      receivedAt[index] = Date.now();
      setTimeout(() => socket.write(modeAck()), 120);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');
  return { server, port: address.port };
}

function waveformFrame27(): Buffer {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(offset, offset);
  return frame;
}

async function listenWaveformServer(requests: Buffer[] = []): Promise<{ server: Server; port: number }> {
  const expected = Buffer.from(SEND_MODE_BROADCAST_FRAME_HEX, 'hex');
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let responded = false;
    socket.on('data', (data) => {
      requests.push(Buffer.from(data));
      buffer = Buffer.concat([buffer, Buffer.from(data)]);
      const offset = buffer.indexOf(expected);
      if (responded || offset < 0) return;
      responded = true;
      socket.write(Buffer.concat([modeAck(), waveformFrame27()]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');
  return { server, port: address.port };
}

test('waveform handshake uses the FF broadcast frame', async () => {
  const receivedAt: number[] = [];
  const requests: Buffer[] = [];
  const listener = await listenModeServer(0, receivedAt, requests);
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: listener.port,
    waveformModeSwitchLowerLimitGateEnabled: false,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: listener.port }],
  }, {
    deferWaveformUntilInspection: true,
    lockPath: join(tmpdir(), `flame-detector-address-${randomUUID()}.lock`),
  });

  try {
    await service.connect();
    await service.startWaveformStreaming();
    assert.ok(requests.length > 0, 'the detector mode command was not sent');
    assert.equal(requests[0]?.toString('hex').toUpperCase(), SEND_MODE_BROADCAST_FRAME_HEX);
  } finally {
    await service.disconnect();
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  }
});

test('FF broadcast handshake reaches the TCP waveform decoder', async () => {
  const requests: Buffer[] = [];
  const listener = await listenWaveformServer(requests);
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: listener.port,
    waveformModeSwitchLowerLimitGateEnabled: false,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: listener.port }],
  }, {
    deferWaveformUntilInspection: true,
    lockPath: join(tmpdir(), `flame-detector-waveform-${randomUUID()}.lock`),
  });

  try {
    await service.connect();
    await service.startWaveformStreaming();
    const deadline = Date.now() + 1_000;
    while ((service.getCurrentState().units[0]?.historySampleTotal ?? 0) < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests[0]?.subarray(0, 13).toString('hex').toUpperCase(), SEND_MODE_BROADCAST_FRAME_HEX);
    assert.equal(service.getCurrentState().units[0]?.historySampleTotal, 4);
  } finally {
    await service.disconnect();
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  }
});

test('six detector mode commands are issued concurrently instead of waiting for previous ACKs', async () => {
  const receivedAt: number[] = [];
  const listeners = await Promise.all(Array.from({ length: 6 }, (_, index) => listenModeServer(index, receivedAt)));
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: listeners[0]!.port,
    waveformModeSwitchLowerLimitGateEnabled: false,
    units: listeners.map(({ port }, index) => ({
      index: index + 1,
      address: 1,
      enabled: true,
      connMode: 'TCP' as const,
      tcpHost: '127.0.0.1',
      tcpPort: port,
    })),
  }, {
    deferWaveformUntilInspection: true,
    lockPath: join(tmpdir(), `flame-detector-concurrency-${randomUUID()}.lock`),
  });

  try {
    await service.connect();
    await service.startWaveformStreaming();
    assert.equal(receivedAt.length, 6);
    const skewMs = Math.max(...receivedAt) - Math.min(...receivedAt);
    assert.ok(skewMs < 100, `six mode commands were serialized; observed skew=${skewMs}ms`);
  } finally {
    await service.disconnect();
    await Promise.all(listeners.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test('enabled lower-limit gate blocks every mode command until the limit then releases all six concurrently', async () => {
  const receivedAt: number[] = [];
  const listeners = await Promise.all(Array.from({ length: 6 }, (_, index) => listenModeServer(index, receivedAt)));
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: listeners[0]!.port,
    waveformModeSwitchLowerLimitGateEnabled: true,
    units: listeners.map(({ port }, index) => ({
      index: index + 1,
      address: 1,
      enabled: true,
      connMode: 'TCP' as const,
      tcpHost: '127.0.0.1',
      tcpPort: port,
    })),
  }, {
    lockPath: join(tmpdir(), `flame-detector-limit-gate-${randomUUID()}.lock`),
  });

  try {
    await service.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(receivedAt.filter(Number.isFinite).length, 0);

    service.setVerticalDownLimit(true);
    const deadline = Date.now() + 1_000;
    while (receivedAt.filter(Number.isFinite).length < 6 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(receivedAt.filter(Number.isFinite).length, 6);
    const skewMs = Math.max(...receivedAt) - Math.min(...receivedAt);
    assert.ok(skewMs < 100, `lower-limit release serialized mode commands; observed skew=${skewMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 160));
  } finally {
    await service.disconnect();
    await Promise.all(listeners.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});
