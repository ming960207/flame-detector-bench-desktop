import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { acquireFlameDetectorProcessLock } from '../dist/modbus/flame-detector-process-lock.js';
import { FlameDetectorService } from '../dist/modbus/flame-detector-service.js';

test('rejects a second process while the detector TCP lock is held', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-detector-lock-'));
  const lockPath = join(directory, 'detector.lock');
  const owner = await acquireFlameDetectorProcessLock(lockPath);
  const moduleUrl = pathToFileURL(resolve('server/dist/modbus/flame-detector-process-lock.js')).href;
  const childCode = [
    `import { acquireFlameDetectorProcessLock } from ${JSON.stringify(moduleUrl)};`,
    `try { await acquireFlameDetectorProcessLock(${JSON.stringify(lockPath)}); process.exit(1); }`,
    `catch (error) { process.exit(error?.code === 'FLAME_DETECTOR_PROCESS_LOCKED' ? 0 : 2); }`,
  ].join('\n');

  try {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolveExit(code ?? 99));
    });
    assert.equal(exitCode, 0, 'a second process must be refused by the detector lock');
  } finally {
    await owner.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('prevents a second detector service from opening the same TCP rig', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-detector-service-lock-'));
  const lockPath = join(directory, 'detector.lock');
  let connectionCount = 0;
  const sockets = new Set();
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const unit = {
    index: 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: port,
  };
  const config = { mode: 'TCP', ip: '127.0.0.1', port, units: [unit] };
  const first = new FlameDetectorService(config, { lockPath });
  const second = new FlameDetectorService(config, { lockPath });

  try {
    await first.connect();
    await assert.rejects(
      () => second.connect(),
      (error) => error?.code === 'FLAME_DETECTOR_PROCESS_LOCKED',
    );
    assert.equal(connectionCount, 1, 'the refused service must not open a second sensor socket');
    // The test server does not implement a Modbus response. Close its accepted
    // socket before asking modbus-serial to close the client, otherwise the
    // library can wait for its own long close timeout.
    for (const socket of sockets) socket.destroy();
    await first.disconnect();
    await second.connect();
    assert.equal(connectionCount, 2, 'the lock must be released after the owner disconnects');
  } finally {
    for (const socket of sockets) socket.destroy();
    await first.disconnect();
    await second.disconnect();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not leave the detector lock waiting on an unresponsive TCP peer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-detector-close-'));
  const lockPath = join(directory, 'detector.lock');
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const unit = {
    index: 1,
    address: 1,
    enabled: true,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: port,
  };
  const service = new FlameDetectorService(
    { mode: 'TCP', ip: '127.0.0.1', port, units: [unit] },
    { lockPath },
  );

  try {
    await service.connect();
    const disconnectPromise = service.disconnect();
    const result = await Promise.race([
      disconnectPromise.then(() => 'completed'),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 1500)),
    ]);
    for (const socket of sockets) socket.destroy();
    await disconnectPromise;
    assert.equal(result, 'completed', 'disconnect must not wait for an unresponsive sensor gateway');
  } finally {
    for (const socket of sockets) socket.destroy();
    await service.disconnect();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});
