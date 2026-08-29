import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceFile = fileURLToPath(import.meta.url);
const defaultCurrentDir = dirname(sourceFile);

export function createLaunchPlan({ currentDir = defaultCurrentDir, execPath = process.execPath } = {}) {
  const projectRoot = resolve(currentDir, '..');
  const serverDir = join(projectRoot, 'server');
  const backendEntry = join(serverDir, 'src', 'test-program-main.ts');
  const tsxEntry = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const viteEntry = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const commonOptions = { shell: false, stdio: 'inherit' };

  return {
    requiredFiles: [backendEntry, tsxEntry, viteEntry],
    backend: {
      command: execPath,
      args: [tsxEntry, backendEntry],
      options: {
        ...commonOptions,
        cwd: serverDir,
        env: {
          ...process.env,
          TEST_PROGRAM_PORT: '3004',
          FORMAL_BACKEND_URL: 'http://127.0.0.1:3003',
          FORMAL_BACKEND_WS_URL: 'ws://127.0.0.1:3003',
        },
      },
    },
    frontend: {
      command: execPath,
      args: [viteEntry, '--mode', 'test', '--port', '3005', '--strictPort'],
      options: {
        ...commonOptions,
        cwd: projectRoot,
        env: {
          ...process.env,
          VITE_RUNTIME_MODE: 'test',
          VITE_TEST_PROGRAM_API_URL: 'http://127.0.0.1:3004',
          VITE_TEST_PROGRAM_WS_URL: 'ws://127.0.0.1:3004',
        },
      },
    },
  };
}

export async function validateLaunchPlan(plan) {
  const missingFiles = [];
  for (const path of plan.requiredFiles) {
    try {
      await access(path);
    } catch {
      missingFiles.push(path);
    }
  }
  if (missingFiles.length === 0) return;

  throw new Error([
    '当前文件夹不能单独作为源码运行包复制，缺少父目录中的程序源码或依赖：',
    ...missingFiles.map((path) => `  - ${path}`),
    '',
    '其他电脑请复制并运行本目录中的 FlameDetectorTestProgram.exe；',
    '如需源码调试，请复制完整的“上位机界面原型版”项目，并安装 Node.js 及 npm 依赖。',
  ].join('\n'));
}

function startService(label, spec, services, fail) {
  const child = spawn(spec.command, spec.args, spec.options);
  services.push(child);
  child.once('error', (error) => fail(`${label}启动失败：${error.message}`));
  child.once('exit', (code, signal) => {
    if (code !== 0) fail(`${label}异常退出：code=${code ?? 'none'}, signal=${signal ?? 'none'}`);
  });
  return child;
}

function openBrowser(url) {
  const browser = spawn('explorer.exe', [url], {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.once('error', (error) => {
    console.warn(`[WARN] 无法自动打开浏览器：${error.message}`);
    console.warn(`[WARN] 请手动访问 ${url}`);
  });
  browser.unref();
}

export async function main() {
  const plan = createLaunchPlan();
  await validateLaunchPlan(plan);

  console.log('===================================================');
  console.log('  火焰探测器检测台 - PLC与数据状态监听测试程序');
  console.log('===================================================');
  console.log('');

  const services = [];
  let failed = false;
  const fail = (message) => {
    if (failed) return;
    failed = true;
    process.exitCode = 1;
    console.error(`[ERROR] ${message}`);
    for (const child of services) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(signal, () => {
      for (const child of services) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    });
  }

  console.log('[1/2] 正在启动后端观察器服务 (端口 3004)...');
  startService('后端观察器服务', plan.backend, services, fail);

  setTimeout(() => {
    if (failed) return;
    console.log('[2/2] 正在启动前端测试界面 (端口 3005)...');
    startService('前端测试界面', plan.frontend, services, fail);

    setTimeout(() => {
      if (failed) return;
      const frontendUrl = 'http://127.0.0.1:3005/?mode=test';
      console.log('');
      console.log('===================================================');
      console.log('  [OK] 测试程序启动完成！');
      console.log(`  - 前端界面: ${frontendUrl}`);
      console.log('  - 观察后台: http://127.0.0.1:3004');
      console.log('  - 监听主程序: http://127.0.0.1:3003');
      console.log('===================================================');
      console.log('');
      openBrowser(frontendUrl);
    }, 2000);
  }, 2000);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(sourceFile)) {
  main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  });
}
