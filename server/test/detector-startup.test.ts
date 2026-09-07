import assert from 'node:assert/strict';
import test from 'node:test';
import { DetectorStartupTracker } from '../src/modbus/detector-startup.js';

test('detector startup becomes TEST_READY only after five consecutive valid frames', () => {
  let now = 1_000;
  const tracker = new DetectorStartupTracker(1, 1, () => now);

  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);
  tracker.markModeSwitchOk();

  for (let index = 0; index < 4; index += 1) {
    now += 10;
    const snapshot = tracker.observeFrame([{ probe1: 8, probe2: 2_772, probe3: 3_275 }]);
    assert.equal(snapshot.state, 'FIRST_FRAME_RECEIVED');
    assert.equal(snapshot.channelValidStreak, index + 1);
  }

  now += 10;
  const ready = tracker.observeFrame([{ probe1: 8, probe2: 2_772, probe3: 3_275 }]);
  assert.equal(ready.state, 'TEST_READY');
  assert.equal(ready.firstFrameAt, 1_010);
  assert.equal(ready.firstValidSampleAt, 1_010);
  assert.equal(ready.channelFirstValidAt.probe1, 1_010);
  assert.equal(ready.channelFirstValidAt.probe2, 1_010);
  assert.equal(ready.channelFirstValidAt.probe3, 1_010);
  assert.equal(ready.channelSyncAt, 1_050);
  assert.equal(ready.testReadyAt, 1_050);
});

test('an invalid channel breaks the consecutive-frame barrier', () => {
  const tracker = new DetectorStartupTracker(2, 1, () => 2_000);
  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);
  tracker.markModeSwitchOk();

  for (let index = 0; index < 4; index += 1) {
    tracker.observeFrame([{ probe1: 1, probe2: 2, probe3: 3 }]);
  }
  const pending = tracker.observeFrame([{ probe1: Number.NaN, probe2: 2, probe3: 3 }]);
  assert.equal(pending.state, 'FIRST_FRAME_RECEIVED');
  assert.equal(pending.channelValidStreak, 0);
  assert.equal(pending.testReadyAt, null);
});

test('valid frames without a confirmed mode switch never become test ready', () => {
  const tracker = new DetectorStartupTracker(3, 1, () => 3_000);
  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);

  for (let index = 0; index < 5; index += 1) {
    tracker.observeFrame([{ probe1: 1, probe2: 2, probe3: 3 }]);
  }

  const pending = tracker.snapshot();
  assert.equal(pending.state, 'FIRST_FRAME_RECEIVED');
  assert.equal(pending.channelSyncAt, 3_000);
  assert.equal(pending.testReadyAt, null);
  const ready = tracker.markModeSwitchOk();
  assert.equal(ready.state, 'TEST_READY');
  assert.equal(ready.testReadyAt, 3_000);
});
