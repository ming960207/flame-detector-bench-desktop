import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractLatestCompletedBatchId, startDiagnosticLogAutoUpload } from '../src/diagnostic-log-auto-upload.js';

function waitFor<T>(promise: Promise<T>, timeoutMs = 1500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
  ]);
}

test('extractLatestCompletedBatchId returns the most recent completed batch marker', () => {
  const text = [
    '批次：field-waveform-old | 结果：不合格',
    'other log text',
    '批次：field-waveform-new | 结果：合格',
  ].join('\n');
  assert.equal(extractLatestCompletedBatchId(text), 'field-waveform-new');
});

test('automatic diagnostic upload triggers once when a new completed result log is written', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flame-bench-auto-upload-'));
  const file = join(directory, 'test-results-2026-09-09.log');
  let resolveUpload: ((batchId: string | null) => void) | undefined;
  const uploaded = new Promise<string | null>((resolve) => { resolveUpload = resolve; });
  const calls: Array<string | null> = [];

  const runtime = startDiagnosticLogAutoUpload({
    directory,
    debounceMs: 50,
    log: () => undefined,
    error: (message) => { throw new Error(message); },
    upload: async (batchId) => {
      calls.push(batchId);
      resolveUpload?.(batchId);
    },
  });

  try {
    writeFileSync(file, '================================\n', 'utf8');
    appendFileSync(file, '批次：field-waveform-automatic-1 | 结果：合格\n', 'utf8');
    const batchId = await waitFor(uploaded);
    assert.equal(batchId, 'field-waveform-automatic-1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(calls, ['field-waveform-automatic-1']);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pre-existing result log does not upload on startup but a later append does', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flame-bench-auto-upload-existing-'));
  const file = join(directory, 'test-results-2026-09-09.log');
  writeFileSync(file, '批次：field-waveform-existing | 结果：合格\n', 'utf8');
  const calls: Array<string | null> = [];
  let resolveUpload: ((batchId: string | null) => void) | undefined;
  const uploaded = new Promise<string | null>((resolve) => { resolveUpload = resolve; });

  const runtime = startDiagnosticLogAutoUpload({
    directory,
    debounceMs: 50,
    log: () => undefined,
    error: (message) => { throw new Error(message); },
    upload: async (batchId) => {
      calls.push(batchId);
      resolveUpload?.(batchId);
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(calls, []);
    appendFileSync(file, '批次：field-waveform-later | 结果：不合格\n', 'utf8');
    const batchId = await waitFor(uploaded);
    assert.equal(batchId, 'field-waveform-later');
    assert.deepEqual(calls, ['field-waveform-later']);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
