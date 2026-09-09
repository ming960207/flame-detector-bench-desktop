import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface DiagnosticLogAutoUploadRuntime {
  close(): Promise<void>;
}

export interface DiagnosticLogAutoUploadOptions {
  directory?: string;
  debounceMs?: number;
  upload?: (batchId: string | null) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

interface PendingUpload {
  key: string;
  batchId: string | null;
}

const DEFAULT_DEBOUNCE_MS = 800;
const TAIL_BYTES = 128 * 1024;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UPLOAD_SCRIPT = join(REPO_ROOT, 'scripts', 'upload-current-logs.ps1');

function defaultResultLogDirectory(): string {
  return process.env.TEST_RESULT_LOG_DIR || join(process.env.APP_DATA_DIR || process.cwd(), 'logs');
}

function noopRuntime(): DiagnosticLogAutoUploadRuntime {
  return { async close() { /* no-op */ } };
}

function isResultLogName(name: string): boolean {
  return /^test-results(?:-\d{4}-\d{2}-\d{2})?\.log$/i.test(name);
}

function readTail(file: string): string {
  const size = statSync(file).size;
  if (size <= 0) return '';
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

export function extractLatestCompletedBatchId(text: string): string | null {
  const matches = Array.from(text.matchAll(/批次：([^|\r\n]+)/g));
  const latest = matches.at(-1)?.[1]?.trim();
  return latest || null;
}

async function runPowerShellUpload(batchId: string | null): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('AUTOMATIC_LOG_UPLOAD_REQUIRES_WINDOWS');
  }
  if (!existsSync(UPLOAD_SCRIPT)) {
    throw new Error(`AUTOMATIC_LOG_UPLOAD_SCRIPT_MISSING: ${UPLOAD_SCRIPT}`);
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', UPLOAD_SCRIPT,
    '-Automatic',
  ];
  if (batchId) args.push('-BatchId', batchId);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`AUTOMATIC_LOG_UPLOAD_EXIT_${code ?? 'UNKNOWN'}`));
    });
  });
}

export function startDiagnosticLogAutoUpload(options: DiagnosticLogAutoUploadOptions = {}): DiagnosticLogAutoUploadRuntime {
  const log = options.log ?? ((message) => console.log(message));
  const errorLog = options.error ?? ((message) => console.error(message));
  const customUpload = options.upload;

  if (process.env.FLAME_BENCH_AUTO_UPLOAD_LOGS === '0') {
    log('[日志自动上传] 已通过 FLAME_BENCH_AUTO_UPLOAD_LOGS=0 禁用');
    return noopRuntime();
  }
  if (!customUpload && process.platform !== 'win32') {
    log('[日志自动上传] 当前非 Windows 环境，自动上传未启用');
    return noopRuntime();
  }

  const directory = options.directory ?? defaultResultLogDirectory();
  const debounceMs = Math.max(50, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const upload = customUpload ?? runPowerShellUpload;
  const knownSizes = new Map<string, number>();
  const queuedKeys = new Set<string>();
  const queue: PendingUpload[] = [];
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let processing = false;
  let closed = false;

  const seedSizes = () => {
    for (const name of readdirSync(directory)) {
      if (!isResultLogName(name)) continue;
      const file = join(directory, name);
      try { knownSizes.set(file, statSync(file).size); } catch { /* ignore transient file changes */ }
    }
  };

  const processQueue = async () => {
    if (processing || closed) return;
    processing = true;
    try {
      while (!closed && queue.length > 0) {
        const item = queue.shift()!;
        queuedKeys.delete(item.key);
        const label = item.batchId ?? item.key;
        log(`[日志自动上传] 检测完成，开始上传 batch=${label}`);
        try {
          await upload(item.batchId);
          log(`[日志自动上传] 上传完成 batch=${label}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errorLog(`[日志自动上传] 上传失败 batch=${label}: ${message}`);
        }
      }
    } finally {
      processing = false;
      if (!closed && queue.length > 0) void processQueue();
    }
  };

  const enqueue = (key: string, batchId: string | null) => {
    if (queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ key, batchId });
    void processQueue();
  };

  const scanForCompletedTests = () => {
    if (closed) return;
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if (!isResultLogName(name)) continue;
      const file = join(directory, name);
      try {
        const stat = statSync(file);
        const previousSize = knownSizes.get(file);
        knownSizes.set(file, stat.size);
        if (previousSize === undefined || stat.size <= 0 || stat.size === previousSize) continue;
        const batchId = extractLatestCompletedBatchId(readTail(file));
        const key = `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
        enqueue(key, batchId);
      } catch {
        // The result logger may rotate/replace the file between watch events.
      }
    }
  };

  try {
    mkdirSync(directory, { recursive: true });
    seedSizes();
    watcher = watch(directory, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanForCompletedTests, debounceMs);
    });
    watcher.on('error', (error) => {
      errorLog(`[日志自动上传] 结果日志监听异常: ${error.message}`);
    });
    log(`[日志自动上传] 已启用，监听完整测试结果: ${directory}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorLog(`[日志自动上传] 启动失败，不影响检测流程: ${message}`);
    return noopRuntime();
  }

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
