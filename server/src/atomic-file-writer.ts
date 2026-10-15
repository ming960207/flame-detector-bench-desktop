import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const RETRY_DELAYS_MS = [15, 30, 60, 120, 250];

/**
 * Atomically replaces destinationPath with temporaryPath.
 *
 * On Windows, MoveFileEx / rename frequently fails with EPERM, EACCES, or EBUSY
 * if the destination file is briefly opened by an antivirus scanner, file watcher,
 * or concurrent reader.
 *
 * This helper:
 * 1. Tries fs.rename directly.
 * 2. If EPERM, EACCES, or EBUSY occurs, clears read-only attributes (via chmod) and retries with backoff.
 * 3. If rename still cannot replace the file on Windows / EXDEV, falls back to copyFile + unlink.
 * 4. Ensures temporaryPath is unlinked if any error propagates.
 */
export async function replaceFileAtomically(
  temporaryPath: string,
  destinationPath: string,
): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fs.rename(temporaryPath, destinationPath);
      return;
    } catch (error: any) {
      lastError = error;
      const isWindowsLockError =
        process.platform === 'win32' &&
        ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
      const isCrossDevice = error?.code === 'EXDEV';

      if (!isWindowsLockError && !isCrossDevice) {
        throw error;
      }

      if (process.platform === 'win32') {
        try {
          await fs.chmod(destinationPath, 0o666);
        } catch {
          // destination may not exist yet or chmod not allowed; ignore
        }
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // Fallback: copyFile overwrites content in-place without directory-entry replacement
  try {
    if (process.platform === 'win32') {
      try {
        await fs.chmod(destinationPath, 0o666);
      } catch {
        // ignore
      }
    }
    await fs.copyFile(temporaryPath, destinationPath);
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // best-effort cleanup
    }
  } catch (copyError) {
    throw lastError || copyError;
  }
}

export async function writeAtomicFile(
  destinationPath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  await fs.mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (typeof content === 'string') {
      await fs.writeFile(temporaryPath, content, encoding);
    } else {
      await fs.writeFile(temporaryPath, content);
    }
    await replaceFileAtomically(temporaryPath, destinationPath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // best-effort
    }
    throw error;
  }
}
