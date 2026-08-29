import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const flowDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(flowDir, '..', '..');
const runtimeDir = join(flowDir, 'runtime');
const pidFile = join(runtimeDir, 'listener.pid');
const statusFile = join(runtimeDir, 'listener.status.json');
const readyFlag = join(runtimeDir, 'listener.ready');
const failedFlag = join(runtimeDir, 'listener.failed');
const logFile = join(runtimeDir, 'listener.log');
const host = '127.0.0.1';
const serverPort = readPort('TEST_LISTENER_SERVER_PORT', 3003);
const frontendPort = readPort('TEST_LISTENER_FRONTEND_PORT', 3002);
const startupTimeoutMs = readPositiveInteger('TEST_LISTENER_STARTUP_TIMEOUT_MS', 20000);

const services = [];
let logStream;
let ownsPid = false;
let stopping = false;
let shutdownPromise;

function readPort(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function logLine(label, value) {
  if (!logStream) return;
  const text = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of text.split('\n')) {
    if (line.length > 0) logStream.write(`[${new Date().toISOString()}] [${label}] ${line}\n`);
  }
}

async function removeFile(path) {
  await rm(path, { force: true }).catch(() => {});
}

async function writeStatus(state, message) {
  const status = {
    state,
    runnerPid: process.pid,
    serverPort,
    frontendPort,
    ...(message ? { message: errorText(message) } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(statusFile, `${JSON.stringify(status)}\n`, 'utf8');
}

async function writeFlag(path, value) {
  await writeFile(path, `${value}\n`, 'utf8');
}

async function readPid() {
  try {
    const value = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(port) {
  return new Promise((resolveResult) => {
    const probe = createServer();
    probe.once('error', () => resolveResult(false));
    probe.listen(port, host, () => probe.close(() => resolveResult(true)));
  });
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveResult, reject) => {
    let finished = false;
    let timer;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolveResult();
    };

    const attempt = () => {
      if (finished) return;
      if (Date.now() >= deadline) {
        finish(new Error(`HTTP startup timeout: ${url}`));
        return;
      }
      const request = httpGet(url, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) {
          finish();
        } else {
          setTimeout(attempt, 200).unref();
        }
      });
      request.setTimeout(1000, () => request.destroy());
      request.once('error', () => setTimeout(attempt, 200).unref());
    };

    timer = setTimeout(() => finish(new Error(`HTTP startup timeout: ${url}`)), timeoutMs);
    attempt();
  });
}

function stopService(service) {
  const { child, label } = service;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveResult) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveResult();
    };
    child.once('close', finish);
    const timeout = setTimeout(finish, 3000);
    timeout.unref();
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], () => {});
    } else {
      child.kill('SIGTERM');
    }
    logLine('runner', `stop requested for ${label}`);
  });
}

async function removeOwnedPid() {
  if (!ownsPid) return;
  const currentPid = await readPid();
  if (currentPid === process.pid) await removeFile(pidFile);
}

function shutdown(state, message) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopping = true;
    if (message) logLine('runner', message);
    try {
      await writeStatus(state, message);
      if (state === 'failed') await writeFlag(failedFlag, 'failed');
    } catch (error) {
      logLine('runner', `status write failed: ${errorText(error)}`);
    }
    await Promise.all(services.map(stopService));
    await removeOwnedPid();
    await removeFile(readyFlag);
    if (state !== 'failed') await removeFile(failedFlag);
    logStream?.end();
  })();
  return shutdownPromise;
}

function requestFailure(message) {
  if (stopping) return shutdownPromise;
  process.exitCode = 1;
  return shutdown('failed', message);
}

function startService(label, command, args, environment) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const service = { label, child };
  services.push(service);
  child.stdout?.on('data', (chunk) => logLine(label, chunk));
  child.stderr?.on('data', (chunk) => logLine(`${label}:stderr`, chunk));
  child.once('error', (error) => { void requestFailure(`${label} failed to start: ${errorText(error)}`); });
  child.once('exit', (code, signal) => {
    if (!stopping) void requestFailure(`${label} exited before stop: code=${code ?? 'none'} signal=${signal ?? 'none'}`);
  });
  logLine('runner', `${label} started with PID ${child.pid}`);
  return child;
}

async function startFlow() {
  await mkdir(runtimeDir, { recursive: true });
  logStream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  await removeFile(readyFlag);
  await removeFile(failedFlag);

  const existingPid = await readPid();
  if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
    throw new Error(`LISTENER_ALREADY_RUNNING:${existingPid}`);
  }
  await removeFile(pidFile);
  await writeFile(pidFile, `${process.pid}\n`, 'utf8');
  ownsPid = true;
  await writeStatus('starting');
  logLine('runner', `project root: ${projectRoot}`);
  logLine('runner', `server port: ${serverPort}; frontend port: ${frontendPort}`);

  if (!(await isPortAvailable(serverPort))) throw new Error(`SERVER_PORT_IN_USE:${serverPort}`);
  if (!(await isPortAvailable(frontendPort))) throw new Error(`FRONTEND_PORT_IN_USE:${frontendPort}`);

  const serverEnvironment = {
    ...process.env,
    CLOSURE_MODE: 'field',
    SERVER_PORT: String(serverPort),
    TEST_RESULT_LOG_DIR: join(runtimeDir, 'records'),
  };
  const frontendEnvironment = {
    ...process.env,
    VITE_RUNTIME_MODE: 'field',
    VITE_BACKEND_API_URL: `http://${host}:${serverPort}`,
    VITE_BACKEND_WS_URL: `ws://${host}:${serverPort}`,
  };

  startService(
    'backend',
    process.execPath,
    [join(projectRoot, 'server', 'dist', 'field-main.js')],
    serverEnvironment,
  );
  startService(
    'frontend',
    process.execPath,
    [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', host, '--port', String(frontendPort), '--strictPort'],
    frontendEnvironment,
  );

  await Promise.all([
    waitForHttp(`http://${host}:${serverPort}/api/health`, startupTimeoutMs),
    waitForHttp(`http://${host}:${frontendPort}/`, startupTimeoutMs),
  ]);
  if (stopping) throw new Error('LISTENER_STOPPED_DURING_STARTUP');
  await writeStatus('ready');
  await writeFlag(readyFlag, 'ready');
  logLine('runner', 'listener flow is ready');
}

async function main() {
  process.on('SIGINT', () => { void shutdown('stopped').then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void shutdown('stopped').then(() => process.exit(0)); });
  process.on('SIGBREAK', () => { void shutdown('stopped').then(() => process.exit(0)); });
  try {
    await startFlow();
  } catch (error) {
    if (!ownsPid) {
      logLine('runner', errorText(error));
      logStream?.end();
      process.exitCode = 1;
      return;
    }
    await shutdown('failed', errorText(error));
    process.exitCode = 1;
  }
}

await main();
