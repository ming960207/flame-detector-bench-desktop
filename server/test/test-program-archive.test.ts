import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TestProgramArchiveStore } from '../src/test-program/test-program-archive.js';
import type { TestProgramRun } from '../src/test-program/test-program-types.js';

function completedRun(): TestProgramRun {
  return {
    runId: 'test-archive-<escape>',
    status: 'COMPLETED',
    startedAt: Date.UTC(2026, 8, 8, 8, 0, 0),
    endedAt: Date.UTC(2026, 8, 8, 8, 0, 2),
    durationMs: 2_000,
    currentStage: 'COMPLETE',
    stages: [{
      sequence: 1,
      stageId: 'COMPLETE',
      label: '完成 <阶段>',
      startedAt: Date.UTC(2026, 8, 8, 8, 0, 2),
      endedAt: Date.UTC(2026, 8, 8, 8, 0, 2),
      durationMs: 0,
      plannedDurationMs: null,
      durationDeltaMs: null,
      withinPlan: null,
      status: 'COMPLETED',
      relaySnapshot: [],
      relayEventCount: 0,
      waveforms: [],
      detectorObservations: [],
      detectors: [],
      decisionBasis: ['完成 <阶段>'],
    }],
    relayEvents: [],
    latestRelayOutputs: [],
    decision: {
      verdict: 'PASS',
      grade: 'A_PASS',
      reasons: ['数据 <完整>'],
      basis: ['流程 COMPLETE'],
      evaluatedAt: Date.UTC(2026, 8, 8, 8, 0, 2),
    },
    evidence: {
      process: null,
      detectorState: null,
      waveformAnalysis: null,
      detectorVerdict: null,
      finalVerdict: null,
    },
    stagePlan: [],
  };
}

test('completed test archive writes a local HTML report alongside JSON detail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flame-detector-archive-'));
  try {
    const store = new TestProgramArchiveStore(directory);
    const archive = store.store(completedRun());

    assert.match(archive.reportFile, /\.html$/);
    const reportPath = join(directory, archive.reportFile);
    const html = readFileSync(reportPath, 'utf8');
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /test-archive-&lt;escape&gt;/);
    assert.match(html, /完成 &lt;阶段&gt;/);
    assert.match(html, /合格/);
    assert.doesNotMatch(html, /数据 <完整>/);
    assert.match(store.report(completedRun().runId) ?? '', /<html/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
