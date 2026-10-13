import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCompletedResultHold, detectorResultTone, hasCompletedResult } from '../../utils/completed-result-hold.js';
import { createLatestValueScheduler } from '../../utils/waveform.js';
import { decodePLCProcessStatus } from '../src/process-status.js';

function summary(batchId: string | null = 'batch-1', phase = 'COMPLETE', verdict = 'PASS', startedAt = 1000) {
  return {
    waveformAnalysis: { batchId, phase, startedAt },
    detectorVerdict: { grade: verdict === 'PASS' ? 'A_PASS' : verdict, reason: 'original evidence' },
    finalVerdict: { verdict },
    process: decodePLCProcessStatus({ stageCode: 0, stepCode: 0, complete: true, autoRunning: false, alarm: false, returningHome: false, timestamp: 2000 }),
    productSelectionLocked: true,
    productPrecheckBusy: true,
    relayTest: { phase: 'COMPLETE' },
  };
}

test('COMPLETE followed by PENDING within one render window still paints the completed result', () => {
  const hold = createCompletedResultHold<ReturnType<typeof summary>>();
  let flush: (() => void) | undefined;
  let painted: ReturnType<typeof summary> | undefined;
  const scheduler = createLatestValueScheduler<ReturnType<typeof summary>>(
    (callback) => { flush = callback; return 1; },
    () => {},
    (value) => { painted = value; },
  );
  scheduler.push(hold.accept(summary()));
  scheduler.push(hold.accept(summary('batch-1', 'INTERFERENCE', 'PENDING')));
  flush!();
  assert.equal(painted?.finalVerdict.verdict, 'PASS');
  assert.equal(hasCompletedResult(painted!), true);
});

test('PLC idle, missing batch and same-batch recomputation do not rewrite completed evidence', () => {
  const hold = createCompletedResultHold<ReturnType<typeof summary>>();
  const completed = summary();
  hold.accept(completed);
  for (const incoming of [summary('batch-1', 'IDLE', 'PENDING'), summary(null, 'IDLE', 'PENDING'), summary('batch-1', 'COMPLETE', 'FAIL')]) {
    const live = { ...incoming, process: { ...incoming.process, complete: false, stage: 'IDLE' as const, processStage: 'IDLE' as const, alarm: true, io: { inputs: { emergencyStop: true }, outputs: {}, internal: {}, steps: {}, syncedAt: 3000 } }, productSelectionLocked: false, productPrecheckBusy: false, relayTest: { phase: 'WAITING' } };
    const accepted = hold.accept(live);
    assert.equal(accepted.finalVerdict, completed.finalVerdict);
    assert.equal(accepted.detectorVerdict, completed.detectorVerdict);
    assert.equal(accepted.waveformAnalysis, completed.waveformAnalysis);
    assert.equal(accepted.process, live.process);
    assert.equal(accepted.process.alarm, true);
    assert.equal(accepted.process.io?.inputs.emergencyStop, true);
    assert.equal(accepted.productSelectionLocked, false);
    assert.equal(accepted.productPrecheckBusy, false);
    assert.equal(accepted.relayTest.phase, 'WAITING');
  }
});

test('next batch unlocks immediately and delayed previous-batch HTTP responses are ignored', () => {
  const hold = createCompletedResultHold<ReturnType<typeof summary>>();
  const first = summary();
  hold.accept(first);
  const second = summary('batch-2', 'NOISE', 'PENDING', 3000);
  assert.equal(hold.accept(second), second);
  assert.equal(hold.completed(), null);
  assert.equal(hasCompletedResult(second), false);
  assert.equal(hold.accept(first), second);
  const finished = summary('batch-2', 'COMPLETE', 'FAIL', 3000);
  assert.equal(hold.accept(finished).finalVerdict.verdict, 'FAIL');
  assert.equal(hold.accept(first).finalVerdict, finished.finalVerdict);
});

test('PENDING and missing batch cannot lock a result', () => {
  for (const incoming of [summary(null), summary('batch-1', 'COMPLETE', 'PENDING')]) {
    const hold = createCompletedResultHold<ReturnType<typeof summary>>();
    assert.equal(hold.accept(incoming), incoming);
    assert.equal(hold.completed(), null);
    assert.equal(hasCompletedResult(incoming), false);
  }
});

test('live fault toggles do not change a completed result card; active-run faults and final failures stay red', () => {
  for (const fault of [false, true, false, true]) {
    assert.equal(detectorResultTone(fault, 'A_PASS', true), 'pass');
    assert.equal(detectorResultTone(fault, 'B_PASS', true), 'pass');
    assert.equal(detectorResultTone(fault, 'FAIL', true), 'fail');
  }
  assert.equal(detectorResultTone(true, 'A_PASS', false), 'fail');
  assert.equal(detectorResultTone(false, 'PENDING', false), 'pending');
});

test('UI wiring uses latched completion for the workflow and preserves raw PLC I/O and alarm input', () => {
  const app = readFileSync(new URL('../../components/FieldProcessStatusApp.tsx', import.meta.url), 'utf8');
  const dashboard = readFileSync(new URL('../../components/WutosDashboard.tsx', import.meta.url), 'utf8');
  assert.match(app, /value: resultHoldRef.current.accept\(patch.summary\)/);
  assert.match(app, /resultComplete=\{resultComplete\}/);
  assert.match(dashboard, /resultComplete \? WORKFLOW.length - 1 : workflowIndex\(status\)/);
  assert.match(dashboard, /resultComplete \? '已完成' : processLabel\(status\)/);
  assert.match(dashboard, /PLCSignalGroup[^\n]+status=\{status\}/);
  assert.match(dashboard, /alarmRows\(new Date\(\), status,/);
});
