import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { FieldWaveformAnalysis } from '../src/closure/field-waveform-analysis.js';
import { FlameDetectorService } from '../src/modbus/flame-detector-service.js';
import { SEND_MODE_BROADCAST_FRAME_HEX } from '../src/modbus/flame-detector-device.js';
import { calculateModbusCRC16 } from '../src/modbus/flame-data-decoder.js';
import type { PLCProcessStatus } from '../src/process-status.js';

function modeAck(): Buffer {
  const body = Buffer.from([0x01, 0x10, 0x30, 0x00, 0x00, 0x02]);
  const crc = calculateModbusCRC16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >>> 8) & 0xFF])]);
}

function waveformFrame27(seed = 0): Buffer {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(offset + seed, offset);
  return frame;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function activeNoiseStatus(timestamp: number): PLCProcessStatus {
  return {
    stageCode: 2,
    stepCode: 2,
    autoRunning: true,
    complete: false,
    alarm: false,
    returningHome: false,
    timestamp,
    io: {
      inputs: {},
      outputs: {},
      internal: {
        autoRunning: true,
        noiseCaptureWindow: true,
      },
      steps: {},
      syncedAt: timestamp,
    },
    stage: 'HEAT',
    label: '移动热源',
    processStage: 'HEAT',
    processLabel: '移动热源',
    heatSubstage: 'NOISE_CAPTURE',
    heatSubstageLabel: '噪声采集阶段',
    valid: true,
  };
}

async function listenDelayedRecoveryWaveformServer(): Promise<{
  server: Server;
  port: number;
  close(): Promise<void>;
}> {
  const expected = Buffer.from(SEND_MODE_BROADCAST_FRAME_HEX, 'hex');
  const timers = new Set<NodeJS.Timeout>();
  const sockets = new Set<Socket>();
  const schedule = (socket: Socket, delayMs: number, seed: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!socket.destroyed && socket.writable) socket.write(waveformFrame27(seed));
    }, delayMs);
    timers.add(timer);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, Buffer.from(data)]);
      if (started || buffer.indexOf(expected) < 0) return;
      started = true;

      // First frame proves the normal display path is alive, but one frame is
      // intentionally insufficient for the five-frame TEST_READY barrier.
      socket.write(Buffer.concat([modeAck(), waveformFrame27(0)]));

      // Continue the same TCP stream only after waitForReady's short test timeout.
      // Five later frames both grow the waveform history and let the startup
      // tracker naturally recover to TEST_READY without reconnect/reset actions.
      schedule(socket, 180, 1);
      schedule(socket, 220, 2);
      schedule(socket, 260, 3);
      schedule(socket, 300, 4);
      schedule(socket, 340, 5);
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

  return {
    server,
    port: address.port,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('waitForReady timeout does not break waveform display/analysis flow and late recovery still reaches TEST_READY', { timeout: 3_000 }, async () => {
  const listener = await listenDelayedRecoveryWaveformServer();
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: listener.port,
    units: [{
      index: 1,
      address: 1,
      enabled: true,
      connMode: 'TCP',
      tcpHost: '127.0.0.1',
      tcpPort: listener.port,
    }],
    waveformMaxSamples: 1000,
  }, {
    deferWaveformUntilInspection: true,
    lockPath: join(tmpdir(), `flame-detector-ready-waveform-${randomUUID()}.lock`),
  });
  const analysis = new FieldWaveformAnalysis({ minNoiseSamples: 1, minNoiseRms: 0 });
  const openedAt = Date.now() - 10_100;
  analysis.observeProcess(activeNoiseStatus(openedAt));
  analysis.observeProcess(activeNoiseStatus(openedAt + 10_050));

  let flameStateEvents = 0;
  service.on('flame_state', (state) => {
    flameStateEvents += 1;
    analysis.observeDetectors(state);
  });

  try {
    await service.connect();
    await service.startWaveformStreaming();

    const firstWaveformVisible = await waitFor(
      () => (service.getCurrentState().units[0]?.historySampleTotal ?? 0) >= 4,
    );
    assert.ok(firstWaveformVisible, 'initial waveform never reached the display state');

    const initialState = service.getCurrentState().units[0]!;
    const historyBeforeTimeout = initialState.historySampleTotal ?? 0;
    const visibleSamplesBeforeTimeout = initialState.historySamples?.length ?? 0;
    assert.ok(historyBeforeTimeout > 0, 'waveform history was empty before waitForReady');
    assert.ok(visibleSamplesBeforeTimeout > 0, 'display samples were empty before waitForReady');

    const report = await service.waitForReady({ requiredSlots: [1], timeoutMs: 80 });
    assert.equal(report.ready, false, 'the readiness barrier should time out before delayed recovery frames');
    assert.notEqual(report.units[0]?.startup.state, 'FAILED', 'readiness timeout must not poison startup state');
    assert.equal(service.isDataStreamConnected(), true, 'readiness timeout must not disconnect an active waveform stream');

    const historyAtTimeout = service.getCurrentState().units[0]?.historySampleTotal ?? 0;
    const eventsAtTimeout = flameStateEvents;

    const recovered = await waitFor(() => service.getReadyReport([1], 1_000).ready, 1_500);
    assert.ok(recovered, 'detector did not naturally recover to TEST_READY after timeout');

    const flowContinued = await waitFor(() => {
      const unit = service.getCurrentState().units[0];
      const analysisUnit = analysis.snapshot().units[0];
      return (unit?.historySampleTotal ?? 0) > historyAtTimeout
        && (unit?.historySamples?.length ?? 0) > visibleSamplesBeforeTimeout
        && flameStateEvents > eventsAtTimeout
        && (analysisUnit?.noiseSampleCount ?? 0) > 0;
    });
    assert.ok(flowContinued, 'waveform display/analysis flow stopped after readiness timeout');

    const finalUnit = service.getCurrentState().units[0]!;
    const finalReady = service.getReadyReport([1], 1_000);
    const finalAnalysis = analysis.snapshot().units[0]!;
    assert.equal(finalReady.ready, true);
    assert.equal(finalReady.units[0]?.startup.state, 'TEST_READY');
    assert.ok((finalUnit.historySampleTotal ?? 0) > historyBeforeTimeout, 'historySampleTotal stopped growing');
    assert.ok((finalUnit.historySamples?.length ?? 0) > visibleSamplesBeforeTimeout, 'display history stopped growing');
    assert.ok(flameStateEvents > eventsAtTimeout, 'flame_state broadcasts stopped after timeout');
    assert.ok(finalAnalysis.noiseSampleCount > 0, 'FieldWaveformAnalysis stopped consuming post-timeout waveform data');
  } finally {
    await service.disconnect();
    await listener.close();
  }
});
