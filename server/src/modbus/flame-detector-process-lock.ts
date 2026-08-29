import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const DEFAULT_LOCK_PATH = resolve(tmpdir(), 'flame-detector-bench-tcp.lock');

interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
  command?: string;
}

export interface FlameDetectorProcessLock {
  readonly path: string;
  readonly ownerPid: number;
  release(): Promise<void>;
}

export class FlameDetectorProcessLockError extends Error {
  readonly code = 'FLAME_DETECTOR_PROCESS_LOCKED';

  constructor(readonly path: string, readonly ownerPid?: number) {
    super(`火焰探测器 TCP 已被其他进程占用${ownerPid ? `（PID ${ownerPid}）` : ''}`);
    this.name = 'FlameDetectorProcessLockError';
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LockOwner>;
    if (!Number.isInteger(parsed.pid) || !parsed.token || !Number.isFinite(parsed.createdAt)) return undefined;
    return parsed as LockOwner;
  } catch {
    return undefined;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

/**
 * 跨进程保护探测器 TCP 通道。每个 FlameDetectorService 进程内的连接池
 * 只能限制本进程，打包版与开发版仍可能同时连接同一个串口服务器；这个
 * 原子锁把该互斥边界提升到操作系统进程级别。
 */
export async function acquireFlameDetectorProcessLock(
  requestedPath = DEFAULT_LOCK_PATH,
): Promise<FlameDetectorProcessLock> {
  const path = resolve(requestedPath);
  await mkdir(dirname(path), { recursive: true });

  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
    command: process.argv[1],
  };
  const content = JSON.stringify(owner);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path,
        ownerPid: process.pid,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const current = await readFile(path, 'utf8');
            if (current === content) await unlink(path);
          } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readOwner(path);
      if (existing && isProcessAlive(existing.pid)) {
        throw new FlameDetectorProcessLockError(path, existing.pid);
      }
      // A newly-created lock can be observed before its JSON is written.
      // Give that writer a short window before treating malformed content as stale.
      if (!existing && attempt < 3) {
        await wait(25);
        continue;
      }
      try {
        await unlink(path);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new FlameDetectorProcessLockError(path);
}

export function defaultFlameDetectorProcessLockPath(): string {
  return DEFAULT_LOCK_PATH;
}
