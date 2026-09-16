import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import test from 'node:test';
import {
  FLAME_DETECTOR_SIMULATION_COMMANDS,
  type FlameDetectorSimulationCommand,
} from '../src/modbus/flame-detector-command.js';
import { FlameDetectorService } from '../src/modbus/flame-detector-service.js';

const expectedFrames: Record<FlameDetectorSimulationCommand, string> = {
  simulateFire: 'FF 10 A0 00 00 02 04 00 00 00 00 3C 43',
  simulateFault: 'FF 10 A0 00 00 02 04 FF FF 00 01 FD A7',
  systemReset: 'FF 10 F0 00 00 01 02 12 34 13 4C',
};

test('simulation command definitions preserve the exact field frames', () => {
  for (const [command, frame] of Object.entries(expectedFrames) as Array<[FlameDetectorSimulationCommand, string]>) {
    assert.equal(FLAME_DETECTOR_SIMULATION_COMMANDS[command].frameHex, frame);
  }
});

async function listenDetector(requests: Buffer[]): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on('data', (data) => requests.push(Buffer.from(data)));
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test('broadcast simulation command is sent to all six connected TCP detectors', async () => {
  const requests = Array.from({ length: 6 }, () => [] as Buffer[]);
  const listeners = await Promise.all(requests.map((received) => listenDetector(received)));
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: listeners[0]!.port,
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
    lockPath: join(tmpdir(), `flame-detector-command-${randomUUID()}.lock`),
  });

  try {
    await service.connect();
    const result = await service.sendSimulationCommand('simulateFire');
    assert.equal(await waitFor(() => requests.every((received) => received.length > 0)), true);
    assert.deepEqual(result.sentUnits, [1, 2, 3, 4, 5, 6]);
    for (const received of requests) {
      assert.equal(received[0]?.toString('hex').toUpperCase(), expectedFrames.simulateFire.replaceAll(' ', ''));
    }
  } finally {
    await service.disconnect();
    await Promise.all(listeners.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});
