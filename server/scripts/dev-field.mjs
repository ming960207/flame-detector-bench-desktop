import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsxCli, 'watch', 'src/main.ts'], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'development',
    CLOSURE_MODE: 'field',
    SERVER_PORT: process.env.SERVER_PORT || '3001',
  },
});

const stop = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(signal, () => stop(signal));

child.once('error', (error) => {
  console.error(`[server:dev:field] 启动失败: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal && !['SIGINT', 'SIGTERM', 'SIGBREAK'].includes(signal)) process.exitCode = 1;
  else if (code !== null) process.exitCode = code;
});
