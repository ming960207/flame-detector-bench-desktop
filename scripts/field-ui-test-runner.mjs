import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const mockPort = Number(process.env.FIELD_UI_MOCK_PORT || 3003);
const previewPort = Number(process.env.FIELD_UI_PREVIEW_PORT || 3002);
process.env.FIELD_UI_URL ||= `http://127.0.0.1:${previewPort}`;
process.env.FIELD_UI_CONTROL_URL ||= `http://127.0.0.1:${mockPort}`;

function start(command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env },
  });
  children.push(child);
  return child;
}

async function waitForPort(port, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`test server exited before port ${port} was ready`);
    try {
      await new Promise((resolveConnect, rejectConnect) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolveConnect();
        });
        socket.once('error', (error) => {
          socket.destroy();
          rejectConnect(error);
        });
      });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`timed out waiting for port ${port}`);
}

async function portIsOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveOpen(false);
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await once(killer, 'exit').catch(() => undefined);
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

async function runSmoke() {
  const child = start(process.execPath, ['scripts/field-ui-smoke.mjs']);
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`field UI smoke failed: code=${code} signal=${signal || 'none'}`);
}

const npmCli = process.env.npm_execpath
  || resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
let exitCode = 0;
try {
  if (await portIsOpen(mockPort)) throw new Error(`field UI mock port ${mockPort} is already in use`);
  const mock = start(process.execPath, ['scripts/field-ui-mock-server.mjs']);
  await waitForPort(mockPort, mock);
  if (await portIsOpen(previewPort)) throw new Error(`field UI preview port ${previewPort} is already in use`);
  const preview = start(process.execPath, [npmCli, 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)]);
  await waitForPort(previewPort, preview);
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
}
process.exitCode = exitCode;
