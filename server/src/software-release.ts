import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const REPOSITORY_URL = 'https://github.com/ming960207/flame-detector-bench-desktop';
const DEFAULT_BRANCH = 'refactor/unified-backend';
const COMMAND_TIMEOUT_MS = 15_000;
const LOG_UPLOAD_TIMEOUT_MS = 120_000;

interface RuntimeMarker {
  branch?: string;
  softwareCommit?: string;
  repositoryCommit?: string;
  builtAtShanghai?: string;
  operation?: string;
}

interface RollbackState {
  status?: string;
  previousSoftwareCommit?: string;
  updateTargetCommit?: string;
  recordedAtShanghai?: string;
  updatedToSoftwareCommit?: string;
}

export interface SoftwareVersionSnapshot {
  available: boolean;
  repository: string;
  branch: string;
  packageVersion: string;
  current: {
    commit: string | null;
    shortCommit: string | null;
    commitDate: string | null;
    builtAt: string | null;
    operation: string | null;
  };
  latest: {
    commit: string;
    shortCommit: string;
  } | null;
  updateAvailable: boolean;
  rollback: {
    available: boolean;
    targetCommit: string | null;
    shortTargetCommit: string | null;
    recordedAt: string | null;
    status: string | null;
  };
  capabilities: {
    update: boolean;
    rollback: boolean;
    logSubmit: boolean;
  };
  message?: string;
}

export interface SoftwareActionResult {
  accepted: boolean;
  action: 'update' | 'rollback' | 'logs';
  message: string;
  output?: string;
}

function shortCommit(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, 12) : null;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validCommit(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

function outputTail(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n')
    .slice(0, 2_000);
}

export class SoftwareReleaseService {
  private readonly repoRoot = resolve(process.env.FLAME_BENCH_REPO_ROOT || process.cwd());
  private readonly branch = process.env.FLAME_BENCH_UPDATE_BRANCH || DEFAULT_BRANCH;
  private busy = false;

  private path(relativePath: string): string {
    return join(this.repoRoot, relativePath);
  }

  private async readJson<T>(relativePath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.path(relativePath), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async command(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
    const result = await execFile(command, args, {
      cwd: this.repoRoot,
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return String(result.stdout ?? '').trim();
  }

  private async git(args: string[]): Promise<string | null> {
    try {
      return await this.command('git', args);
    } catch {
      return null;
    }
  }

  private async packageVersion(): Promise<string> {
    try {
      const packageJson = JSON.parse(await fs.readFile(this.path('package.json'), 'utf8')) as { version?: string };
      return safeText(packageJson.version, 32) || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async latestCommit(): Promise<string | null> {
    const output = await this.git(['-c', 'http.version=HTTP/1.1', 'ls-remote', REPOSITORY_URL, `refs/heads/${this.branch}`]);
    const commit = output?.split(/\s+/)[0]?.trim() ?? '';
    return validCommit(commit) ? commit : null;
  }

  async snapshot(): Promise<SoftwareVersionSnapshot> {
    const marker = await this.readJson<RuntimeMarker>('logs/runtime-build.json');
    const rollbackState = await this.readJson<RollbackState>('logs/rollback-state.json');
    const currentCommit = (await this.git(['rev-parse', 'HEAD'])) || safeText(marker?.softwareCommit, 64) || null;
    const currentDate = currentCommit ? await this.git(['show', '-s', '--format=%cI', currentCommit]) : null;
    const latest = await this.latestCommit();
    const updateScriptAvailable = await fs.access(this.path('scripts/update-current-branch.ps1')).then(() => true).catch(() => false);
    const rollbackScriptAvailable = await fs.access(this.path('scripts/rollback-last-update.ps1')).then(() => true).catch(() => false);
    const rollbackTarget = safeText(rollbackState?.previousSoftwareCommit, 64) || null;

    return {
      available: Boolean(currentCommit),
      repository: REPOSITORY_URL,
      branch: safeText(marker?.branch, 128) || this.branch,
      packageVersion: await this.packageVersion(),
      current: {
        commit: currentCommit,
        shortCommit: shortCommit(currentCommit),
        commitDate: currentDate,
        builtAt: safeText(marker?.builtAtShanghai, 64) || null,
        operation: safeText(marker?.operation, 32) || null,
      },
      latest: latest ? { commit: latest, shortCommit: shortCommit(latest)! } : null,
      updateAvailable: Boolean(currentCommit && latest && currentCommit !== latest),
      rollback: {
        available: Boolean(rollbackTarget && rollbackScriptAvailable),
        targetCommit: rollbackTarget,
        shortTargetCommit: shortCommit(rollbackTarget),
        recordedAt: safeText(rollbackState?.recordedAtShanghai, 64) || null,
        status: safeText(rollbackState?.status, 32) || null,
      },
      capabilities: {
        update: updateScriptAvailable,
        rollback: rollbackScriptAvailable,
        logSubmit: await fs.access(this.path('scripts/upload-current-logs.ps1')).then(() => true).catch(() => false),
      },
      ...(this.busy ? { message: '已有版本操作正在执行' } : {}),
    };
  }

  private async startPowerShellScript(scriptName: string, scriptArgs: string[]): Promise<void> {
    const scriptPath = this.path(`scripts/${scriptName}`);
    await fs.access(scriptPath);
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...scriptArgs,
    ], {
      cwd: this.repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env },
    });
    child.unref();
  }

  async startUpdate(): Promise<SoftwareActionResult> {
    if (this.busy) throw new Error('SOFTWARE_OPERATION_BUSY');
    this.busy = true;
    try {
      const args = process.env.DESKTOP_EMBEDDED_SERVER === '1' ? ['-StartAfterUpdate'] : [];
      await this.startPowerShellScript('update-current-branch.ps1', args);
      return {
        accepted: true,
        action: 'update',
        message: process.env.DESKTOP_EMBEDDED_SERVER === '1'
          ? '更新流程已启动，程序将在构建完成后重启。'
          : '更新流程已启动，完成后请重新运行 start-all.bat。',
      };
    } finally {
      this.busy = false;
    }
  }

  async startRollback(commitInput?: unknown): Promise<SoftwareActionResult> {
    if (this.busy) throw new Error('SOFTWARE_OPERATION_BUSY');
    const commit = safeText(commitInput, 64);
    if (commit && !validCommit(commit)) throw new Error('SOFTWARE_ROLLBACK_COMMIT_INVALID');
    this.busy = true;
    try {
      await this.startPowerShellScript('rollback-last-update.ps1', commit ? ['-Commit', commit] : []);
      return {
        accepted: true,
        action: 'rollback',
        message: process.env.DESKTOP_EMBEDDED_SERVER === '1'
          ? '回退流程已启动，程序将在构建完成后重启。'
          : '回退流程已启动，完成后请重新运行 start-all.bat。',
      };
    } finally {
      this.busy = false;
    }
  }

  async submitLogs(input: { issueReference?: unknown; issueNote?: unknown; batchId?: unknown } = {}): Promise<SoftwareActionResult> {
    if (this.busy) throw new Error('SOFTWARE_OPERATION_BUSY');
    this.busy = true;
    try {
      const args = ['-Automatic'];
      const batchId = safeText(input.batchId, 128);
      const issueReference = safeText(input.issueReference, 200);
      const issueNote = safeText(input.issueNote, 1_000);
      if (batchId) args.push('-BatchId', batchId);
      if (issueReference) args.push('-IssueReference', issueReference);
      if (issueNote) args.push('-IssueNote', issueNote);
      const scriptPath = this.path('scripts/upload-current-logs.ps1');
      const result = await execFile('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...args,
      ], {
        cwd: this.repoRoot,
        timeout: LOG_UPLOAD_TIMEOUT_MS,
        windowsHide: false,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env },
      });
      return {
        accepted: true,
        action: 'logs',
        message: '诊断日志已提交到 GitHub。',
        output: outputTail(String(result.stdout ?? ''), String(result.stderr ?? '')),
      };
    } finally {
      this.busy = false;
    }
  }
}
