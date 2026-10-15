import assert from 'node:assert/strict';
import { chmod, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeAtomicFile } from '../src/atomic-file-writer.js';

test('writeAtomicFile persists file correctly and creates parents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flame-atomic-'));
  const file = join(dir, 'nested', 'config.json');
  try {
    await writeAtomicFile(file, '{"ok":true}\n');
    const content = await readFile(file, 'utf8');
    assert.equal(content, '{"ok":true}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeAtomicFile handles read-only files on Windows', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flame-atomic-ro-'));
  const file = join(dir, 'config.json');
  try {
    await writeAtomicFile(file, 'version 1');
    await chmod(file, 0o444);
    await writeAtomicFile(file, 'version 2');
    const content = await readFile(file, 'utf8');
    assert.equal(content, 'version 2');
  } finally {
    await chmod(file, 0o666).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeAtomicFile recovers when destination file is locked by an open handle', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flame-atomic-lock-'));
  const file = join(dir, 'config.json');
  try {
    await writeAtomicFile(file, 'initial content\n');

    // Open file without delete sharing, which triggers EPERM on Windows when rename is called
    const handle = await open(file, 'r');
    try {
      // Writing should fall back to copyFile in-place after rename is refused
      await writeAtomicFile(file, 'updated content\n');
    } finally {
      await handle.close();
    }

    const content = await readFile(file, 'utf8');
    assert.equal(content, 'updated content\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
