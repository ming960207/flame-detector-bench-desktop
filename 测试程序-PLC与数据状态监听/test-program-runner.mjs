import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, '..');
const runtimeDir = join(currentDir, 'runtime');
const pidFile = join(runtimeDir, 'test-program.pid');
const statusFile = join(runtimeDir, 'test-program.status.json');
const readyFlag = join(runtimeDir, 'test-program.ready');
const failedFlag = join(runtimeDir, 'test-program.failed');
const logFile = join(runtimeDir, 'test-program.log');
const host = '127.0.0.1';
const serverPort = readPort('TEST_PROGRAM_SERVER_PORT', 3004);
const frontendPort = readPort('TEST_PROGRAM_FRONTEND_PORT', 3005);
const formalBackendUrl = process.env.FORMAL_BACKEND_URL || 'http://127.0.0.1:3003';
const startupTimeoutMs = readPositiveInteger('TEST_PROGRAM_STARTUP_TIMEOUT_MS', 20000);

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
  for (const line of String(value).replace(/\r/g, '').split('\n')) {
    if (line) logStream.write(`[${new Date().toISOString()}] [${label}] ${line}\n`);
  }
}
async function removeFile(path) { await rm(path, { force: true }).catch(() => {}); }
async function writeFlag(path, value) { await writeFile(path, `${value}\n`, 'utf8'); }
async function writeStatus(state, message) {
  await writeFile(statusFile, `${JSON.stringify({ state, runnerPid: process.pid, serverPort, frontendPort, formalBackendUrl, ...(message ? { message: errorText(message) } : {}), updatedAt: new Date().toISOString() })}\n`, 'utf8');
}
async function readPid() { try { return Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10); } catch { return undefined; } }
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function isPortAvailable(port) { return new Promise((done) => { const probe = createServer(); probe.once('error', () => done(false)); probe.listen(port, host, () => probe.close(() => done(true))); }); }
function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveResult, reject) => {
    const attempt = () => {
      if (Date.now() >= deadline) return reject(new Error(`HTTP startup timeout: ${url}`));
      const request = httpGet(url, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) resolveResult();
        else setTimeout(attempt, 200).unref();
      });
      request.setTimeout(1000, () => request.destroy());
      request.once('error', () => setTimeout(attempt, 200).unref());
    };
    attempt();
  });
}
function stopService({ child, label }) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; done(); };
    child.once('close', finish);
    const timeout = setTimeout(finish, 3000); timeout.unref();
    if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], () => {}); else child.kill('SIGTERM');
    logLine('runner', `stop requested for ${label}`);
  });
}
async function removeOwnedPid() { if (ownsPid && await readPid() === process.pid) await removeFile(pidFile); }
function shutdown(state, message) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopping = true;
    try {
      await writeStatus(state, message);
      if (state === 'failed') await writeFlag(failedFlag, 'failed');
    } catch (error) { logLine('runner', errorText(error)); }
    await Promise.all(services.map(stopService));
    await removeOwnedPid();
    await removeFile(readyFlag);
    if (state !== 'failed') await removeFile(failedFlag);
    logStream?.end();
  })();
  return shutdownPromise;
}
function requestFailure(message) { if (stopping) return shutdownPromise; process.exitCode = 1; return shutdown('failed', message); }
function startService(label, command, args, environment) {
  const child = spawn(command, args, { cwd: projectRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  services.push({ label, child });
  child.stdout?.on('data', (chunk) => logLine(label, chunk));
  child.stderr?.on('data', (chunk) => logLine(`${label}:stderr`, chunk));
  child.once('error', (error) => { void requestFailure(`${label} failed to start: ${errorText(error)}`); });
  child.once('exit', (code, signal) => { if (!stopping) void requestFailure(`${label} exited early: code=${code ?? 'none'} signal=${signal ?? 'none'}`); });
  logLine('runner', `${label} started with PID ${child.pid}`);
}
async function startFlow() {
  await mkdir(runtimeDir, { recursive: true });
  logStream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  await removeFile(readyFlag);
  await removeFile(failedFlag);
  const existingPid = await readPid();
  if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) throw new Error(`TEST_PROGRAM_ALREADY_RUNNING:${existingPid}`);
  await removeFile(pidFile);
  await writeFile(pidFile, `${process.pid}\n`, 'utf8');
  ownsPid = true;
  await writeStatus('starting');
  logLine('runner', `server port=${serverPort}; frontend port=${frontendPort}; formal source=${formalBackendUrl}`);
  if (!(await isPortAvailable(serverPort))) throw new Error(`SERVER_PORT_IN_USE:${serverPort}`);
  if (!(await isPortAvailable(frontendPort))) throw new Error(`FRONTEND_PORT_IN_USE:${frontendPort}`);
  const common = {
    ...process.env,
    FORMAL_BACKEND_URL: formalBackendUrl,
    FORMAL_BACKEND_WS_URL: `${formalBackendUrl.replace(/^http/i, 'ws')}`,
    TEST_PROGRAM_PORT: String(serverPort),
    TEST_PROGRAM_DATA_DIR: process.env.TEST_PROGRAM_DATA_DIR || join(runtimeDir, 'data'),
    TEST_PROGRAM_RESULT_LOG_DIR: process.env.TEST_PROGRAM_RESULT_LOG_DIR || join(runtimeDir, 'logs')
  };
  startService('observer', process.execPath, [join(projectRoot, 'server', 'dist', 'test-program-main.js')], common);
  startService('frontend', process.execPath, [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', host, '--port', String(frontendPort), '--strictPort'], {
    ...common,
    VITE_RUNTIME_MODE: 'test',
    VITE_TEST_PROGRAM_API_URL: `http://${host}:${serverPort}`,
    VITE_TEST_PROGRAM_WS_URL: `ws://${host}:${serverPort}`
  });
  await Promise.all([
    waitForHttp(`http://${host}:${serverPort}/api/test-program/health`, startupTimeoutMs),
    waitForHttp(`http://${host}:${frontendPort}/`, startupTimeoutMs)
  ]);
  if (stopping) throw new Error('TEST_PROGRAM_STOPPED_DURING_STARTUP');
  await writeStatus('ready');
  await writeFlag(readyFlag, 'ready');
  logLine('runner', 'test program is ready');
}
async function main() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => { void shutdown('stopped', signal).then(() => process.exit(0)); });
  }
  try {
    await startFlow();
  } catch (error) {
    if (ownsPid) await shutdown('failed', errorText(error));
    else { logLine('runner', errorText(error)); logStream?.end(); }
    process.exitCode = 1;
  }
}
await main();
