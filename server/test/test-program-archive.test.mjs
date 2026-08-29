import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TestProgramArchiveStore } from '../dist/test-program/test-program-archive.js';

test('test program archive writes index, detailed JSON and readable Markdown report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flame-test-program-'));
  try {
    const store = new TestProgramArchiveStore(directory);
    const run = {
      runId: 'run-archive-001',
      status: 'COMPLETED',
      startedAt: 1_000,
      endedAt: 3_000,
      durationMs: 2_000,
      currentStage: 'COMPLETE',
      stages: [{
        sequence: 1,
        stageId: 'HEAT_NOISE_CAPTURE',
        label: '噪声采集阶段',
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        plannedDurationMs: 30_000,
        durationDeltaMs: -29_000,
        withinPlan: true,
        status: 'COMPLETED',
        relaySnapshot: [],
        relayEventCount: 1,
        waveforms: [],
        detectorObservations: [{
          timestamp: 1_100,
          stageId: 'HEAT_NOISE_CAPTURE',
          index: 1,
          address: 1,
          online: true,
          fire: false,
          fault: false,
          sourceReady: true,
          syncOk: true,
          probe1: 10,
          probe2: 20,
          probe3: 30,
          probe4: null,
          probe1Absolute: null,
          probe2Absolute: null,
          probe3Absolute: null,
          probe4Absolute: null,
          probe1Fluctuation: null,
          probe2Fluctuation: null,
          probe3Fluctuation: null,
          probe4Fluctuation: null,
          snr21: 1,
          snr23: 1,
          snr31: 1,
          sensitivity: 1,
          sendMode: 1,
        }],
        detectors: [{
          index: 1,
          address: 1,
          observationCount: 1,
          retainedObservationCount: 1,
          firstAt: 1_100,
          lastAt: 1_100,
          onlineCount: 1,
          offlineCount: 0,
          fireCount: 0,
          faultCount: 0,
          sourceNotReadyCount: 0,
          syncNotOkCount: 0,
          latest: null,
          stats: {},
        }],
        decisionBasis: ['设备1：噪声样本 400，判定 PASS'],
      }, {
        sequence: 2,
        stageId: 'COMPLETE',
        label: '已完成',
        startedAt: 2_000,
        endedAt: 3_000,
        durationMs: 1_000,
        plannedDurationMs: null,
        durationDeltaMs: null,
        withinPlan: null,
        status: 'COMPLETED',
        relaySnapshot: [],
        relayEventCount: 0,
        waveforms: [],
        detectorObservations: [],
        detectors: [],
        decisionBasis: [],
      }],
      relayEvents: [],
      latestRelayOutputs: [],
      decision: { verdict: 'PASS', grade: 'B_PASS', reasons: ['NOISE_RMS_EXCEEDS_LIMIT'], basis: ['PLC COMPLETE', 'HEAT_NOISE_CAPTURE: STAGE_WITHIN_LIMIT'], evaluatedAt: 3_000 },
      evidence: { process: null, detectorState: null, waveformAnalysis: null, detectorVerdict: null, finalVerdict: { verdict: 'PASS', grade: 'B_PASS' } },
      stagePlan: [],
    };

    store.store(run);
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].runId, 'run-archive-001');
    const resultLogFile = join(directory, 'logs', 'test-results.log');
    assert.equal(existsSync(resultLogFile), true);
    const resultLog = readFileSync(resultLogFile, 'utf8');
    assert.match(resultLog, /run=run-archive-001/);
    assert.match(resultLog, /stages=2\/2/);
    assert.match(resultLog, /detectors=1/);
    assert.equal(store.get('run-archive-001').decision.verdict, 'PASS');
    assert.match(store.report('run-archive-001'), /阶段时序与判断/);
    assert.match(store.report('run-archive-001'), /噪声采集阶段/);
    assert.match(store.report('run-archive-001'), /分阶段探测器数值/);
    assert.match(store.report('run-archive-001'), /噪声 RMS 超过上限/);
    assert.doesNotMatch(store.report('run-archive-001'), /NOISE_RMS_EXCEEDS_LIMIT/);
    assert.equal(store.get('../not-allowed'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
