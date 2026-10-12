import assert from 'node:assert/strict';
import test from 'node:test';
import { ALARM_INDICATOR_OBSERVATION_MS, RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import {
  normalizeRelayFunctionalTestConfig,
  relayFunctionalTestMissingMappings,
  relayFunctionalTestReady,
  type RelayFunctionalTestPhase,
  type RelayFeedbackMapping,
} from '../src/relay-functional-test.js';

function createMapping(indexes: number[]): RelayFeedbackMapping[] {
  return indexes.map((index) => ({
    detectorIndex: index,
    alarmInputAddress: `X${(index - 1) * 2 + 1}`,
    faultInputAddress: `X${(index - 1) * 2 + 2}`,
    alarmNormalLevel: false,
    faultNormalLevel: false,
  }));
}

test('relay mapping readiness requires both physical DI addresses for every enabled detector', () => {
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1', faultInputAddress: '',
      alarmNormalLevel: false, faultNormalLevel: false,
    }],
  });
  assert.deepEqual(relayFunctionalTestMissingMappings(config, [1]), ['D1_FAULT_DI']);
  assert.equal(relayFunctionalTestReady(config, [1]), false);

  const ready = normalizeRelayFunctionalTestConfig({
    ...config,
    dio: { ...config.dio, host: '192.168.1.100' },
    mappings: [{ ...config.mappings[0], faultInputAddress: 'X2' }],
  }, config);
  assert.deepEqual(relayFunctionalTestMissingMappings(ready, [1]), []);
  assert.equal(relayFunctionalTestReady(ready, [1]), true);
});

test('FAST_BATCH runs alarm/reset/fault/reset while keeping each stage parallel', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);
  const inputs: Record<string, boolean> = { X1: false, X2: false, X3: false, X4: false };
  const events: string[] = [];
  const phases: RelayFunctionalTestPhase[] = [];

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      const label = state.fire && state.fault ? 'alarm+fault' : state.fire ? 'alarm' : state.fault ? 'fault' : 'normal';
      events.push(`simulate:${index}:${label}`);
      internal.set(index, { ...state });
      inputs[`X${(index - 1) * 2 + 1}`] = state.fire;
      inputs[`X${(index - 1) * 2 + 2}`] = state.fault;
    },
    async reset(index) {
      events.push(`reset:${index}`);
      internal.set(index, { fire: false, fault: false });
      inputs[`X${(index - 1) * 2 + 1}`] = false;
      inputs[`X${(index - 1) * 2 + 2}`] = false;
    },
    async readLatched(index) {
      return { ...(internal.get(index) ?? { fire: false, fault: false }) };
    },
  };

  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1, 2]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config, (event) => phases.push(event.phase));
  const report = await coordinator.run('batch-1');

  assert.equal(report.verdict, 'PASS');
  assert.equal(report.units.length, 2);
  assert.ok(report.units.every((unit) => unit.alarm.verdict === 'PASS' && unit.fault.verdict === 'PASS'));

  assert.deepEqual(events.slice(0, 6).sort(), [
    'simulate:1:alarm', 'simulate:1:alarm', 'simulate:1:alarm',
    'simulate:2:alarm', 'simulate:2:alarm', 'simulate:2:alarm',
  ]);
  assert.deepEqual(events.slice(6, 8).sort(), ['reset:1', 'reset:2']);
  assert.deepEqual(events.slice(8, 14).sort(), [
    'simulate:1:fault', 'simulate:1:fault', 'simulate:1:fault',
    'simulate:2:fault', 'simulate:2:fault', 'simulate:2:fault',
  ]);
  assert.deepEqual(events.slice(14, 16).sort(), ['reset:1', 'reset:2']);
  assert.deepEqual(events.slice(16).sort(), ['reset:1', 'reset:2']);
  assert.equal(events.some((event) => event.includes('alarm+fault')), false);
  assert.deepEqual(phases, [
    'BASELINE',
    'ALARM_COMMAND', 'ALARM_VERIFY', 'ALARM_RESET', 'ALARM_RESET_VERIFY',
    'FAULT_COMMAND', 'FAULT_VERIFY', 'FAULT_RESET', 'FAULT_RESET_VERIFY',
    'COMPLETE',
  ]);
});

test('DIAGNOSTIC completes one detector before activating the next detector', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);
  const inputs: Record<string, boolean> = { X1: false, X2: false, X3: false, X4: false };
  const events: string[] = [];
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      events.push(`D${index}:${state.fire ? 'alarm' : state.fault ? 'fault' : 'normal'}`);
      internal.set(index, { ...state });
      inputs[`X${(index - 1) * 2 + 1}`] = state.fire;
      inputs[`X${(index - 1) * 2 + 2}`] = state.fault;
    },
    async reset(index) {
      events.push(`D${index}:reset`);
      internal.set(index, { fire: false, fault: false });
      inputs[`X${(index - 1) * 2 + 1}`] = false;
      inputs[`X${(index - 1) * 2 + 2}`] = false;
    },
    async readLatched(index) { return { ...(internal.get(index) ?? { fire: false, fault: false }) }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'DIAGNOSTIC',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1, 2]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('diagnostic-1');

  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(events.slice(0, 10), [
    'D1:alarm', 'D1:alarm', 'D1:alarm', 'D1:reset',
    'D1:fault', 'D1:fault', 'D1:fault', 'D1:reset',
    'D2:alarm', 'D2:alarm',
  ]);
  assert.deepEqual(events.slice(10, 16), [
    'D2:alarm', 'D2:reset', 'D2:fault', 'D2:fault', 'D2:fault', 'D2:reset',
  ]);
  assert.deepEqual(events.slice(16).sort(), ['D1:reset', 'D2:reset']);
});

test('FAST_BATCH reports alarm contact failure without invalidating a passing fault phase', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = false;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('batch-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.units[0]?.alarm.verdict, 'FAIL');
  assert.equal(report.units[0]?.fault.verdict, 'PASS');
  assert.ok(report.units[0]?.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'));
});

test('DIO feedback read failures are reported as communication failures', async () => {
  let internal = { fire: false, fault: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) { internal = { ...state }; },
    async reset() { internal = { fire: false, fault: false }; },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    dio: { host: '192.168.1.100' },
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, {
    async readInputs() { throw Object.assign(new Error('socket closed'), { code: 'DIO_CONNECTION_FAILED' }); },
  }, config);
  const report = await coordinator.run('dio-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.units[0]?.alarm.reasons.includes('RELAY_FEEDBACK_READ_FAILED:DIO_CONNECTION_FAILED'));
  assert.equal(report.units[0]?.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'), false);
  assert.ok(report.units[0]?.alarm.reasons.some((reason) => reason.startsWith('EMERGENCY_RESET_FEEDBACK_READ_FAILED:')));
});

test('combined alarm+fault simulation is never used by FAST_BATCH production flow', async () => {
  let combinedCalls = 0;
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      if (state.fire && state.fault) combinedCalls += 1;
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1]),
  });

  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('no-combined');

  assert.equal(report.verdict, 'PASS');
  assert.equal(combinedCalls, 0);
});

test('emergency cleanup failure is explicit and forces the relay test to fail', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let resetCalls = 0;
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      resetCalls += 1;
      throw new Error('reset transport unavailable');
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 100,
    resetTimeoutMs: 100,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('cleanup-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.ok(resetCalls >= 3);
  assert.ok(report.units[0]?.alarm.reasons.includes('EMERGENCY_RESET_COMMAND_FAILED'));
  assert.ok(report.units[0]?.fault.reasons.includes('EMERGENCY_RESET_COMMAND_FAILED'));
});

test('DIAGNOSTIC retries transient internal baseline reads instead of forcing a retest', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let readLatchedCalls = 0;
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() {
      readLatchedCalls += 1;
      if (readLatchedCalls <= 2) throw new Error('temporary detector read timeout');
      return { ...internal };
    },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'DIAGNOSTIC',
    stableSamples: 1,
    sampleIntervalMs: 20,
    feedbackTimeoutMs: 300,
    resetTimeoutMs: 300,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('baseline-retry');

  assert.equal(report.verdict, 'PASS');
  assert.ok(readLatchedCalls >= 3);
  assert.equal(report.units[0]?.alarm.reasons.includes('RELAY_BASELINE_READ_FAILED'), false);
  assert.equal(report.units[0]?.fault.reasons.includes('RELAY_BASELINE_READ_FAILED'), false);
});

test('transient relay DI baseline read failures are retried instead of forcing a retest', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let readInputsCalls = 0;
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 20,
    feedbackTimeoutMs: 300,
    resetTimeoutMs: 300,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, {
    async readInputs() {
      readInputsCalls += 1;
      if (readInputsCalls <= 2) throw Object.assign(new Error('temporary DIO timeout'), { code: 'DIO_CONNECTION_FAILED' });
      return { ...inputs };
    },
  }, config);
  const report = await coordinator.run('baseline-dio-retry');

  assert.equal(report.verdict, 'PASS');
  assert.ok(readInputsCalls >= 3);
  assert.equal(report.units[0]?.alarm.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:')), false);
  assert.equal(report.units[0]?.fault.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:')), false);
});

function fixture(options: { slowDiagnostic?: boolean; droppedCommands?: boolean; transientFeedback?: boolean; stuck?: boolean; slowFeedback?: boolean; missingFeedback?: boolean; bouncing?: boolean; resetFeedbackFailure?: boolean; slowRescueCallback?: boolean } = {}) {
  const inputs: Record<string, boolean> = {};
  const commands = new Map<string, number>();
  const elapsed = new Map<string, number>();
  let phase: RelayFunctionalTestPhase = 'BASELINE';
  let phaseStarted = Date.now();
  let diagnosticReads = 0;
  let feedbackReads = 0;
  for (let index = 1; index <= 6; index++) {
    inputs[`X${2 * index - 1}`] = false;
    inputs[`X${2 * index}`] = true;
  }
  const config = normalizeRelayFunctionalTestConfig({ feedbackTimeoutMs: 400, resetTimeoutMs: 400, stableSamples: 3, sampleIntervalMs: 50 });
  const coordinator = new RelayFunctionalTestCoordinator({
    enabledDetectorIndexes: () => [1, 2, 3, 4, 5, 6],
    async simulate(index, state) {
      const key = `${index}:${state.fire ? 'alarm' : 'fault'}`;
      const count = (commands.get(key) ?? 0) + 1;
      commands.set(key, count);
      if (index === 2 && (options.stuck || (options.droppedCommands && count <= 3))) return;
      inputs[`X${2 * index - 1}`] = state.fire;
      inputs[`X${2 * index}`] = !state.fault;
      if (options.slowRescueCallback && index === 2 && count === 4) await new Promise((resolve) => setTimeout(resolve, 700));
    },
    async reset(index) {
      inputs[`X${2 * index - 1}`] = false;
      inputs[`X${2 * index}`] = true;
    },
    async readLatched(index) {
      diagnosticReads++;
      if (options.slowDiagnostic && index === 2 && phase === 'ALARM_VERIFY') await new Promise((resolve) => setTimeout(resolve, 700));
      return { fire: inputs[`X${2 * index - 1}`]!, fault: !inputs[`X${2 * index}`] };
    },
  }, {
    async readInputs() {
      feedbackReads++;
      if (phase === 'ALARM_VERIFY' && options.slowFeedback) await new Promise((resolve) => setTimeout(resolve, 700));
      if ((options.transientFeedback && phase === 'ALARM_VERIFY' && Date.now() - phaseStarted < 170)
        || (options.resetFeedbackFailure && phase === 'ALARM_RESET_VERIFY' && Date.now() - phaseStarted < 170)) {
        throw Object.assign(new Error('temporary disconnect'), { code: 'DIO_CONNECTION_FAILED' });
      }
      if (options.missingFeedback && phase === 'ALARM_VERIFY') return {};
      if (options.bouncing && phase === 'ALARM_VERIFY') return { ...inputs, X3: feedbackReads % 2 === 0 };
      return { ...inputs };
    },
  }, config, (event) => {
    elapsed.set(phase, Date.now() - phaseStarted);
    phase = event.phase;
    phaseStarted = Date.now();
  });
  return { coordinator, commands, elapsed, diagnosticReads: () => diagnosticReads };
}


test('healthy relay commands capture transport writes and physical confirmations without a new phase', async () => {
  const { coordinator, commands } = fixture({});
  const report = await coordinator.run('command-delivery-evidence');
  assert.equal(report.verdict, 'PASS');
  for (const unit of report.units) {
    for (const kind of ['alarm', 'fault'] as const) {
      const action = unit[kind];
      assert.equal(action.commandWriteAttempts, 3);
      assert.equal(action.commandWriteAccepted, 3);
      assert.equal(action.rescueWriteAttempts ?? 0, 0);
      assert.equal(action.physicalStateReached, true);
      assert.ok(typeof action.physicalConfirmedAt === 'number');
      assert.ok(typeof action.resetConfirmedAt === 'number');
      assert.equal(action.emergencyRecovered, true);
    }
  }
  assert.equal(commands.get('6:alarm'), 3);
});

test('already-active DIO baseline isolates unsafe slot, leaves peers and PLC phases untouched', async () => {
  const inputs: Record<string, boolean> = { X1: false, X2: false, X3: true, X4: false };
  const writes: number[] = [];
  const config = normalizeRelayFunctionalTestConfig({
    mode: 'FAST_BATCH',
    stableSamples: 1, sampleIntervalMs: 50, feedbackTimeoutMs: 250, resetTimeoutMs: 250,
    mappings: createMapping([1, 2]),
  });
  const coordinator = new RelayFunctionalTestCoordinator({
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      writes.push(index);
      inputs[`X${index * 2 - 1}`] = state.fire;
      inputs[`X${index * 2}`] = state.fault;
    },
    async reset(index) {
      inputs[`X${index * 2 - 1}`] = false;
      inputs[`X${index * 2}`] = false;
    },
    async readLatched() { return { fire: false, fault: false }; },
  }, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('abnormal-initial-contact');
  assert.equal(report.units[0]?.verdict, 'PASS');
  assert.equal(report.units[1]?.verdict, 'FAIL');
  assert.ok(report.units[1]?.alarm.reasons.includes('RELAY_BASELINE_NOT_NORMAL'));
  assert.ok(report.units[1]?.fault.reasons.includes('RELAY_BASELINE_NOT_NORMAL'));
  assert.equal(writes.filter((index) => index === 2).length, 0);
  assert.equal(writes.filter((index) => index === 1).length, 6);
  assert.equal(report.units[1]?.alarm.emergencyRecovered, true);
});

test('one slow internal diagnostic cannot invalidate six healthy relays or extend the production window', async () => {
  const { coordinator, elapsed, diagnosticReads } = fixture({ slowDiagnostic: true });
  const report = await coordinator.run('six-relay-slow-diagnostic');
  assert.equal(report.verdict, 'PASS');
  // Feedback still has its original deadline; the camera window follows it.
  assert.ok(elapsed.get('ALARM_VERIFY')! - ALARM_INDICATOR_OBSERVATION_MS < 450);
  assert.equal(diagnosticReads(), 0, 'production must not enqueue slow internal diagnostic reads');
});

test('only unconfirmed relays receive one rescue command within the original window', async () => {
  const { coordinator, commands, elapsed } = fixture({ droppedCommands: true });
  const report = await coordinator.run('dropped-broadcasts');
  assert.equal(report.verdict, 'PASS');
  assert.equal(commands.get('2:alarm'), 4);
  assert.equal(commands.get('2:fault'), 4);
  assert.equal(commands.get('1:alarm'), 3);
  assert.equal(commands.get('1:fault'), 3);
  // Feedback still has its original deadline; the camera window follows it.
  assert.ok(elapsed.get('ALARM_VERIFY')! - ALARM_INDICATOR_OBSERVATION_MS < 450);
  assert.ok(elapsed.get('FAULT_VERIFY')! < 450);
});

test('feedback can recover after a failed read burst without retaining a false relay failure', async () => {
  const { coordinator } = fixture({ transientFeedback: true });
  const report = await coordinator.run('feedback-recovery');
  assert.equal(report.verdict, 'PASS');
  assert.ok(report.units.every((unit) => unit.alarm.reasons.length === 0));
});

test('a real stuck relay still fails after the bounded rescue command', async () => {
  const { coordinator, elapsed } = fixture({ stuck: true });
  const report = await coordinator.run('stuck-contact');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.units.filter((unit) => unit.verdict === 'FAIL').length, 1);
  assert.ok(report.units[1]!.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'));
  assert.ok(report.units[1]!.fault.reasons.includes('FAULT_RELAY_NOT_ACTUATED'));
  // Feedback still has its original deadline; the camera window follows it.
  assert.ok(elapsed.get('ALARM_VERIFY')! - ALARM_INDICATOR_OBSERVATION_MS < 450);
});

test('a slow DIO read ends at the existing deadline and remains a communication failure', async () => {
  const { coordinator, elapsed } = fixture({ slowFeedback: true });
  const report = await coordinator.run('slow-dio');
  assert.equal(report.verdict, 'FAIL');
  // Feedback still has its original deadline; the camera window follows it.
  assert.ok(elapsed.get('ALARM_VERIFY')! - ALARM_INDICATOR_OBSERVATION_MS < 450);
  assert.ok(report.units.every((unit) => unit.alarm.reasons.some((reason) => reason.startsWith('RELAY_FEEDBACK_READ_FAILED:'))));
  assert.ok(report.units.every((unit) => !unit.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED')));
});

test('an incomplete DIO snapshot cannot pass or masquerade as six defective relays', async () => {
  const { coordinator } = fixture({ missingFeedback: true });
  const report = await coordinator.run('missing-dio-channels');
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.units.every((unit) => unit.alarm.reasons.includes('RELAY_FEEDBACK_READ_FAILED:DIO_RESPONSE_INVALID')));
});

test('rescue does not relax the consecutive stable sample requirement', async () => {
  const { coordinator } = fixture({ bouncing: true });
  const report = await coordinator.run('bouncing-contact');
  assert.equal(report.units[1]!.alarm.verdict, 'FAIL');
  assert.equal(report.units[1]!.alarm.physicalStateReached, false);
  assert.equal(report.units[1]!.fault.verdict, 'PASS');
});

test('reset feedback recovers within its original window without a sticky error', async () => {
  const { coordinator, elapsed } = fixture({ resetFeedbackFailure: true });
  const report = await coordinator.run('reset-feedback-recovery');
  assert.equal(report.verdict, 'PASS');
  assert.ok(elapsed.get('ALARM_RESET_VERIFY')! < 450);
});

test('a slow rescue write remains serialized and gets bounded DIO confirmation grace', async () => {
  const { coordinator, elapsed } = fixture({ droppedCommands: true, slowRescueCallback: true });
  const report = await coordinator.run('slow-rescue-callback');
  assert.equal(report.verdict, 'PASS');
  // A slow callback must be awaited to avoid the F000 reset overtaking it.
  // Exceptional rescue may need a bounded extra window, never a PLC rerun.
  assert.ok(elapsed.get('ALARM_VERIFY')! - ALARM_INDICATOR_OBSERVATION_MS < 1300);
  assert.ok(elapsed.get('FAULT_VERIFY')! < 1300);
});

test('one-pass reset rescue reissues F000 only when physical DIO fails to recover', async () => {
  const inputs = { X1: false, X2: false };
  let resets = 0;
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      resets++;
      // First reset is transport-accepted but intentionally has no effect.
      // A second, serially awaited F000 should recover the physical contacts.
      if (resets === 1) return;
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() { return { fire: inputs.X1, fault: inputs.X2 }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true, mode: 'FAST_BATCH',
    stableSamples: 1, sampleIntervalMs: 50,
    feedbackTimeoutMs: 250, resetTimeoutMs: 600,
    mappings: createMapping([1]),
  });
  const report = await new RelayFunctionalTestCoordinator(
    detectors, { readInputs: () => ({ ...inputs }) }, config,
  ).run('reset-rescue-one-pass');
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.units[0]?.alarm.physicalRecovered, true);
  assert.equal(report.units[0]?.alarm.resetRescueWriteAttempts, 1);
  assert.equal(report.units[0]?.fault.resetRescueWriteAttempts, undefined);
  assert.ok(resets >= 4, 'alarm reset, its rescue, fault reset and final safe cleanup');
});
