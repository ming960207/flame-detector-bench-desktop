import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Map();
let shuttingDown = false;
let requestedExitCode = 0;

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Best effort during shutdown.
  }
}

function finishWhenStopped() {
  if (!shuttingDown || children.size > 0) return;
  process.exit(requestedExitCode);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedExitCode = exitCode;
  for (const child of children.keys()) terminateProcessTree(child);
  setTimeout(() => {
    for (const child of children.keys()) terminateProcessTree(child);
    process.exit(requestedExitCode);
  }, 1500).unref();
  finishWhenStopped();
}

function start(label, args, extraEnv = {}) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: false,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  children.set(child, label);

  child.on('error', (error) => {
    console.error(`[dev:field] ${label} 启动失败:`, error instanceof Error ? error.message : String(error));
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      const suffix = signal ? `signal=${signal}` : `exit=${code ?? 1}`;
      console.error(`[dev:field] ${label} 已退出 (${suffix})，正在停止另一进程。`);
      shutdown(code === 0 ? 0 : 1);
      return;
    }
    finishWhenStopped();
  });

  return child;
}

console.log('[dev:field] 启动正式现场开发环境');
console.log('[dev:field] 统一后端: http://127.0.0.1:3001');
console.log('[dev:field] 主界面:   http://127.0.0.1:3002');
console.log('[dev:field] Ctrl+C 将同时停止前后端。');

start('统一 field 后端', ['run', 'dev', '--prefix', 'server'], {
  NODE_ENV: 'development',
  CLOSURE_MODE: 'field',
  SERVER_PORT: '3001',
});

start('Vite 主界面', ['run', 'dev'], {
  VITE_RUNTIME_MODE: 'field',
  VITE_BACKEND_API_URL: 'http://127.0.0.1:3001',
  VITE_BACKEND_WS_URL: 'ws://127.0.0.1:3001',
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
