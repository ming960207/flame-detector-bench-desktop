import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

interface DiagnosticSourceSnapshot {
  sourcePath: string;
  archivePath: string;
  start: number;
  end: number;
  truncated: boolean;
  content: Buffer;
}

interface GitHubRefResponse {
  object?: { sha?: string };
}

interface GitHubCommitResponse {
  sha?: string;
  tree?: { sha?: string };
}

interface GitHubObjectResponse {
  sha?: string;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message = `GITHUB_API_${status}`,
  ) {
    super(`${message}: ${body.slice(0, 600)}`);
  }
}

const DEFAULT_DEBOUNCE_MS = 800;
const TAIL_BYTES = 128 * 1024;
const DEFAULT_MAX_DELTA_BYTES = 24 * 1024 * 1024;
const AUTO_UPLOAD_RETRY_DELAYS_MS = [0, 2_000, 5_000] as const;
const DEFAULT_GITHUB_OWNER = 'ming960207';
const DEFAULT_GITHUB_REPO = 'flame-detector-bench-desktop';
const DEFAULT_GITHUB_BRANCH = 'refactor/unified-backend';
const GITHUB_API_BASE = 'https://api.github.com';

function defaultResultLogDirectory(): string {
  return process.env.TEST_RESULT_LOG_DIR || join(process.env.APP_DATA_DIR || process.cwd(), 'logs');
}

function defaultDesktopLogDirectory(resultDirectory: string): string {
  const configured = process.env.DESKTOP_LOG_DIR;
  if (configured) return configured;
  // Packaged Electron sets APP_DATA_DIR to userData/runtime while its session log
  // stays next to the executable. In source/development mode both log families are
  // normally under the project logs directory, so keep the result directory.
  if (process.env.DESKTOP_EMBEDDED_SERVER === '1' && process.env.APP_DATA_DIR) {
    return join(dirname(process.execPath), 'logs');
  }
  return resultDirectory;
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

function readRange(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function compactStamp(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function safeBatchSlug(batchId: string | null): string {
  const value = (batchId || 'completed-test').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return (value || 'completed-test').slice(0, 80);
}

function uniqueExistingFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path) || !existsSync(path)) continue;
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(path);
    result.push(path);
  }
  return result;
}

function resultLogFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter(isResultLogName)
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

function diagnosticSourceFiles(resultDirectory: string, desktopLogDirectory: string): string[] {
  const testProgramDirectory = process.env.TEST_PROGRAM_LOG_DIR || '';
  return uniqueExistingFiles([
    ...resultLogFiles(resultDirectory),
    join(resultDirectory, 'detector-lifecycle.log'),
    join(resultDirectory, 'latest.log'),
    join(desktopLogDirectory, 'latest.log'),
    ...(testProgramDirectory ? [join(testProgramDirectory, 'test-results.log')] : []),
  ]);
}

function archiveRelativePath(file: string, resultDirectory: string, desktopLogDirectory: string): string {
  if (file.startsWith(resultDirectory)) return `backend/${basename(file)}`;
  if (file.startsWith(desktopLogDirectory)) return `desktop/${basename(file)}`;
  return `extra/${basename(file)}`;
}

export function extractLatestCompletedBatchId(text: string): string | null {
  const matches = Array.from(text.matchAll(/批次：([^|\r\n]+)/g));
  const latest = matches.at(-1)?.[1]?.trim();
  return latest || null;
}

class GitHubDiagnosticUploader {
  private readonly offsets = new Map<string, number>();
  private readonly resultDirectory: string;
  private readonly desktopLogDirectory: string;
  private readonly maxDeltaBytes: number;
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;

  constructor(resultDirectory: string) {
    this.resultDirectory = resultDirectory;
    this.desktopLogDirectory = defaultDesktopLogDirectory(resultDirectory);
    this.maxDeltaBytes = positiveIntegerEnv('FLAME_BENCH_AUTO_UPLOAD_MAX_FILE_BYTES', DEFAULT_MAX_DELTA_BYTES);
    this.token = String(process.env.FLAME_BENCH_GITHUB_TOKEN || '').trim();
    this.owner = String(process.env.FLAME_BENCH_GITHUB_OWNER || DEFAULT_GITHUB_OWNER).trim();
    this.repo = String(process.env.FLAME_BENCH_GITHUB_REPO || DEFAULT_GITHUB_REPO).trim();
    this.branch = String(process.env.FLAME_BENCH_GITHUB_BRANCH || DEFAULT_GITHUB_BRANCH).trim();
    this.seedOffsets();
  }

  private seedOffsets(): void {
    for (const file of diagnosticSourceFiles(this.resultDirectory, this.desktopLogDirectory)) {
      try { this.offsets.set(file, statSync(file).size); } catch { /* best effort */ }
    }
  }

  private collectDeltas(): DiagnosticSourceSnapshot[] {
    const snapshots: DiagnosticSourceSnapshot[] = [];
    for (const file of diagnosticSourceFiles(this.resultDirectory, this.desktopLogDirectory)) {
      try {
        const size = statSync(file).size;
        const previous = this.offsets.get(file) ?? 0;
        let start = size < previous ? 0 : previous;
        let truncated = false;
        if (size - start > this.maxDeltaBytes) {
          start = Math.max(0, size - this.maxDeltaBytes);
          truncated = true;
        }
        if (size <= start) continue;
        const content = readRange(file, start, size);
        if (content.length === 0) continue;
        snapshots.push({
          sourcePath: file,
          archivePath: archiveRelativePath(file, this.resultDirectory, this.desktopLogDirectory),
          start,
          end: size,
          truncated,
          content,
        });
      } catch {
        // Logs can rotate while a test is completing. Missing one optional file must
        // not cancel upload of the completed result and remaining diagnostics.
      }
    }
    return snapshots;
  }

  private markUploaded(snapshots: DiagnosticSourceSnapshot[]): void {
    for (const snapshot of snapshots) this.offsets.set(snapshot.sourcePath, snapshot.end);
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'flame-detector-bench-auto-log-uploader',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubApiError(response.status, text);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private repoPath(path: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
  }

  private async createBlobs(files: Array<{ path: string; content: Buffer }>): Promise<Array<{ path: string; sha: string }>> {
    const created: Array<{ path: string; sha: string }> = [];
    for (const file of files) {
      const response = await this.api<GitHubObjectResponse>('POST', this.repoPath('/git/blobs'), {
        content: file.content.toString('base64'),
        encoding: 'base64',
      });
      if (!response.sha) throw new Error(`GITHUB_BLOB_SHA_MISSING: ${file.path}`);
      created.push({ path: file.path, sha: response.sha });
    }
    return created;
  }

  private async commitBlobs(
    blobs: Array<{ path: string; sha: string }>,
    message: string,
  ): Promise<string> {
    const encodedBranch = encodeURIComponent(this.branch);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const ref = await this.api<GitHubRefResponse>('GET', this.repoPath(`/git/ref/heads/${encodedBranch}`));
        const parentSha = ref.object?.sha;
        if (!parentSha) throw new Error('GITHUB_BRANCH_HEAD_MISSING');
        const parent = await this.api<GitHubCommitResponse>('GET', this.repoPath(`/git/commits/${parentSha}`));
        const baseTree = parent.tree?.sha;
        if (!baseTree) throw new Error('GITHUB_BASE_TREE_MISSING');
        const tree = await this.api<GitHubObjectResponse>('POST', this.repoPath('/git/trees'), {
          base_tree: baseTree,
          tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
        });
        if (!tree.sha) throw new Error('GITHUB_TREE_SHA_MISSING');
        const commit = await this.api<GitHubCommitResponse>('POST', this.repoPath('/git/commits'), {
          message,
          tree: tree.sha,
          parents: [parentSha],
          author: {
            name: 'Flame Detector Bench',
            email: 'flame-detector-bench@local.invalid',
            date: new Date().toISOString(),
          },
        });
        if (!commit.sha) throw new Error('GITHUB_COMMIT_SHA_MISSING');
        await this.api('PATCH', this.repoPath(`/git/refs/heads/${encodedBranch}`), {
          sha: commit.sha,
          force: false,
        });
        return commit.sha;
      } catch (error) {
        lastError = error;
        const retryableRefRace = error instanceof GitHubApiError && (error.status === 409 || error.status === 422);
        if (!retryableRefRace || attempt >= 3) throw error;
      }
    }
    throw lastError;
  }

  async upload(batchId: string | null): Promise<void> {
    if (!this.token) {
      throw new Error('GITHUB_TOKEN_MISSING: configure FLAME_BENCH_GITHUB_TOKEN once; automatic per-test uploads never prompt interactively');
    }
    if (!this.owner || !this.repo || !this.branch) throw new Error('GITHUB_AUTO_UPLOAD_CONFIGURATION_INVALID');

    const snapshots = this.collectDeltas();
    if (snapshots.length === 0) throw new Error('NO_NEW_DIAGNOSTIC_LOG_DATA');

    const stamp = compactStamp();
    const archiveRoot = `diagnostic-logs/${stamp}-${safeBatchSlug(batchId)}`;
    const manifest = Buffer.from([
      'Flame detector bench automatic diagnostic upload',
      `Captured: ${new Date().toISOString()}`,
      `Batch: ${batchId ?? '-'}`,
      `Repository: ${this.owner}/${this.repo}`,
      `Branch: ${this.branch}`,
      `Result directory: ${this.resultDirectory}`,
      `Desktop log directory: ${this.desktopLogDirectory}`,
      `File count: ${snapshots.length}`,
      ...snapshots.map((item) => (
        `${item.archivePath}: source=${item.sourcePath}; bytes=${item.start}-${item.end}; truncated=${item.truncated ? 'yes' : 'no'}`
      )),
      '',
    ].join('\n'), 'utf8');

    const files = [
      ...snapshots.map((item) => ({ path: `${archiveRoot}/${item.archivePath}`, content: item.content })),
      { path: `${archiveRoot}/manifest.txt`, content: manifest },
    ];
    const blobs = await this.createBlobs(files);
    const commitSha = await this.commitBlobs(
      blobs,
      `logs: auto upload completed batch ${batchId ?? 'unknown'} ${stamp}`,
    );
    this.markUploaded(snapshots);
    // Keep this on stdout so the desktop latest.log also records upload evidence;
    // that line belongs to the next delta rather than recursively modifying this upload.
    console.log(`[日志自动上传] GitHub commit=${commitSha} path=${archiveRoot}`);
  }
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function startDiagnosticLogAutoUpload(options: DiagnosticLogAutoUploadOptions = {}): DiagnosticLogAutoUploadRuntime {
  const log = options.log ?? ((message) => console.log(message));
  const errorLog = options.error ?? ((message) => console.error(message));

  if (process.env.FLAME_BENCH_AUTO_UPLOAD_LOGS === '0') {
    log('[日志自动上传] 已通过 FLAME_BENCH_AUTO_UPLOAD_LOGS=0 禁用');
    return noopRuntime();
  }

  const directory = options.directory ?? defaultResultLogDirectory();
  const debounceMs = Math.max(50, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const nativeUploader = options.upload ? null : new GitHubDiagnosticUploader(directory);
  const upload = options.upload ?? ((batchId: string | null) => nativeUploader!.upload(batchId));
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
        let uploaded = false;
        let lastError: unknown;
        for (const retryDelay of AUTO_UPLOAD_RETRY_DELAYS_MS) {
          if (closed) break;
          await delay(retryDelay);
          try {
            log(`[日志自动上传] 检测完成，开始上传 batch=${label}`);
            await upload(item.batchId);
            log(`[日志自动上传] 上传完成 batch=${label}`);
            uploaded = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!uploaded && lastError) {
          const message = lastError instanceof Error ? lastError.message : String(lastError);
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
        if (stat.size <= 0 || stat.size === previousSize) continue;
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
    log(`[日志自动上传] 已启用，完整测试结果落盘后自动上传: ${directory}`);
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
