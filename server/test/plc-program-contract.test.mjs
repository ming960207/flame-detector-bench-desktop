import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLC_EMC_MAPPING, PLC_PROGRAM } from '../dist/plc-program-contract.js';
import { hasVerticalFeedbackWithSafeTimeout } from '../../scripts/field-readiness.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

function extractNetwork(awl, number) {
  const lines = awl.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^Network\\s+${number}\\s*$`).test(line));
  assert.notEqual(start, -1, `Network ${number} not found`);
  const end = lines.findIndex((line, index) => index > start && /^Network\s+\d+\s*$/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function evaluateNetwork(network, state, { positiveEdge = false } = {}) {
  let rlo = false;
  for (const line of network.split(/\r?\n/)) {
    const instruction = line.trim().match(/^(LD|A|AN|O|EU|=)\s*([A-Z0-9.]+)?$/);
    if (!instruction) continue;

    const [, opcode, operand] = instruction;
    switch (opcode) {
      case 'LD':
        rlo = Boolean(state[operand]);
        break;
      case 'A':
        rlo = rlo && Boolean(state[operand]);
        break;
      case 'AN':
        rlo = rlo && !Boolean(state[operand]);
        break;
      case 'O':
        rlo = rlo || Boolean(state[operand]);
        break;
      case 'EU':
        rlo = rlo && positiveEdge;
        break;
      case '=':
        state[operand] = rlo;
        break;
      default:
        throw new Error(`Unsupported test instruction: ${opcode}`);
    }
  }
}

function evaluateQ06(awl, inputs, previousSafetyLimit) {
  const state = { ...inputs };
  evaluateNetwork(extractNetwork(awl, 242), state);
  evaluateNetwork(extractNetwork(awl, 250), state, {
    positiveEdge: Boolean(inputs['M2.2']) && !previousSafetyLimit,
  });
  evaluateNetwork(extractNetwork(awl, 251), state);
  return state['Q0.6'];
}

test('maps the EMC control bit to the physical relay output', () => {
  assert.equal(PLC_EMC_MAPPING.controlBit.address, 'M11.2');
  assert.equal(PLC_EMC_MAPPING.safetyGate.address, 'M31.7');
  assert.equal(PLC_EMC_MAPPING.physicalOutput.address, 'Q0.7');

  const relay = PLC_PROGRAM.relays.find(({ address }) => address === 'Q0.7');
  assert.ok(relay);
  assert.match(relay.label, /电磁干扰继电器/);
});

test('makes the I1.0 emergency stop dominant over manual enable and output latches', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  const stopNetwork = extractNetwork(awl, 2);
  const outputGateNetwork = extractNetwork(awl, 226);
  const tail = awl.slice(awl.lastIndexOf('Network 252'));

  assert.match(stopNetwork, /LDN\s+I1\.0[\s\S]*O\s+M2\.0[\s\S]*=\s+M1\.0/);
  assert.doesNotMatch(stopNetwork, /AN\s+M2\.4/);
  assert.match(outputGateNetwork, /LD\s+M0\.3/);
  assert.doesNotMatch(outputGateNetwork, /O\s+M2\.4/);
  assert.match(tail, /LDN\s+I1\.0[\s\S]*R\s+Q0\.0,\s*8[\s\S]*R\s+Q1\.0,\s*4/);
});

test('clears the emergency process alarm when I1.0 is restored', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  const alarmNetwork = extractNetwork(awl, 4);

  assert.match(alarmNetwork, /LD\s+M20\.0[\s\S]*=\s+M0\.2/);
  assert.doesNotMatch(alarmNetwork, /\bS\s+M0\.2/);
});

test('holds Q0.6 while I1.0 is open and returns control after recovery', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  const normalNetwork = extractNetwork(awl, 251);
  const holdNetwork = extractNetwork(awl, 253);
  const shutdownNetwork = extractNetwork(awl, 252);

  assert.match(normalNetwork, /LD\s+M25\.1[\s\S]*O\s+M25\.0[\s\S]*=\s+Q0\.6/);
  assert.match(holdNetwork, /LDN\s+I1\.0[\s\S]*S\s+Q0\.6,\s*1/);
  assert.doesNotMatch(holdNetwork, /\bEU\b|M25\.2/);
  assert.match(shutdownNetwork, /LDN\s+I1\.0[\s\S]*R\s+Q0\.0,\s*8[\s\S]*R\s+Q1\.0,\s*4/);
  assert.doesNotMatch(shutdownNetwork, /AN\s+M25\.2/);
});

test('does not depend on an HMI reset bit for clearing the safety alarm', () => {
  assert.equal(PLC_PROGRAM.internal.some(({ address }) => address === 'M2.1'), false);

  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  assert.doesNotMatch(awl, /\bM2\.1\b/);
  assert.doesNotMatch(awl, /\bS\s+M0\.2\b/);
  assert.match(awl, /\bLD\s+M20\.0\s*\r?\n\s*=\s+M0\.2\b/);

  const contract = JSON.parse(readFileSync(`${workspaceRoot}config/plc-hmi-upper-contract.json`, 'utf8'));
  assert.equal(contract.lifecycleCommands.RESET, undefined);
  assert.equal(contract.plcProgram.internal.some(({ address }) => address === 'M2.1'), false);
});

test('uses the vertical limit inputs from the current PLC and HMI assets', () => {
  const verticalInputs = PLC_PROGRAM.inputs
    .filter(({ key }) => key === 'verticalDownFeedback' || key === 'verticalUpFeedback')
    .map(({ address }) => address);
  assert.deepEqual(verticalInputs, ['I0.4', 'I0.3']);

  const contract = JSON.parse(readFileSync(`${workspaceRoot}config/plc-hmi-upper-contract.json`, 'utf8'));
  assert.deepEqual(
    contract.plcProgram.inputs
      .filter(({ key }) => key === 'verticalDownFeedback' || key === 'verticalUpFeedback')
      .map(({ address }) => address),
    ['I0.4', 'I0.3'],
  );
  assert.deepEqual(contract.safety.verticalFeedback, ['I0.4', 'I0.3']);
});

test('maps the automatic start input to I1.3 across PLC and upper-computer contracts', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  assert.match(awl, /\bLD\s+I1\.3\s*\r?\n\s*EU\b/);
  assert.doesNotMatch(awl, /\bLD\s+I1\.1\s*\r?\n\s*EU\b/);
  assert.equal(PLC_PROGRAM.inputs.find(({ key }) => key === 'autoStartInput')?.address, 'I1.3');

  const contract = JSON.parse(readFileSync(`${workspaceRoot}config/plc-hmi-upper-contract.json`, 'utf8'));
  assert.equal(
    contract.plcProgram.inputs.find(({ key }) => key === 'autoStartInput')?.address,
    'I1.3',
  );
});

test('keeps Q0.6 low at idle and emits one safety-limit pulse', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  const q06Networks = [242, 250, 251].map((number) => extractNetwork(awl, number)).join('\n');
  assert.doesNotMatch(q06Networks, /\bM3[2-9]\.[0-7]\b/);
  assert.match(q06Networks, /\bM25\.0\b/);
  assert.match(q06Networks, /\bM25\.1\b/);
  const idle = {
    'M0.0': false,
    'M0.3': true,
    'Q0.5': false,
    'M31.4': false,
    'M2.2': false,
  };

  assert.equal(evaluateQ06(awl, idle, false), false);
  assert.equal(evaluateQ06(awl, { ...idle, 'M2.2': true }, false), true);
  assert.equal(evaluateQ06(awl, { ...idle, 'M2.2': true }, true), false);
  assert.equal(evaluateQ06(awl, idle, true), false);
  assert.equal(evaluateQ06(awl, { ...idle, 'M0.0': true }, false), true);
});

test('keeps the heat-position vertical dwell at the configured ten seconds', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  assert.match(extractNetwork(awl, 37), /\bLD\s+M10\.3\b[\s\S]*\bTON\s+T45,\s*\+100\b/);
  assert.match(extractNetwork(awl, 38), /\bLD\s+T45\b[\s\S]*=\s+M12\.3\b/);
});

test('stabilizes thirty seconds, publishes a thirty-second noise window, then starts the heat test', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  assert.match(extractNetwork(awl, 48), /\bLD\s+M15\.0\b[\s\S]*\bTON\s+T63,\s*\+300\b/);
  assert.match(extractNetwork(awl, 48), /\bLD\s+T63\b[\s\S]*\bA\s+M15\.0\b[\s\S]*=\s+M25\.2\b/);
  assert.match(extractNetwork(awl, 47), /\bLD\s+M25\.2\b[\s\S]*\bTON\s+T51,\s*\+300\b/);
  assert.match(extractNetwork(awl, 74), /\bLD\s+T51\b[\s\S]*\bS\s+M10\.4,\s*1\b/);
  assert.match(extractNetwork(awl, 48), /\bLD\s+M15\.1\b[\s\S]*\bTON\s+T38,\s*\+100\b/);
  assert.match(extractNetwork(awl, 108), /\bLD\s+T38\b[\s\S]*\bS\s+M11\.0,\s*1\b/);

  assert.equal(PLC_PROGRAM.internal.find(({ key }) => key === 'noiseCaptureWindow')?.address, 'M25.2');
});

test('disconnects vertical motor relays while waiting for signal stabilization', () => {
  const awlFiles = ['PLC.awl', 'PLC0_中文注释_GBK.awl'];

  for (const file of awlFiles) {
    const awl = readFileSync(`${workspaceRoot}${file}`, 'utf8');

    assert.match(
      extractNetwork(awl, 72),
      /\bLD\s+M12\.3\b[\s\S]*\bR\s+M29\.1,\s*1\b/,
      `${file} must clear the downward vertical command at the heat stabilization entry`,
    );
    assert.match(
      extractNetwork(awl, 106),
      /\bLD\s+M12\.7\b[\s\S]*\bR\s+M29\.1,\s*1\b/,
      `${file} must clear the downward vertical command at the flash stabilization entry`,
    );

    for (const networkNumber of [228, 229]) {
      assert.match(
        extractNetwork(awl, networkNumber),
        /\bAN\s+M15\.0\b[\s\S]*\bAN\s+M15\.1\b/,
        `${file} network ${networkNumber} must inhibit vertical relay output during both stabilization waits`,
      );
    }

    const heatStabilization = {
      'M30.1': false,
      'M29.1': true,
      'M29.2': false,
      'Q0.4': true,
      'M27.5': false,
      'M31.7': true,
      'M15.0': true,
      'M15.1': false,
    };
    evaluateNetwork(extractNetwork(awl, 228), heatStabilization);
    evaluateNetwork(extractNetwork(awl, 239), heatStabilization);
    assert.equal(heatStabilization['Q0.4'], false, `${file} must drop Q0.4 during heat stabilization`);

    const flashStabilization = {
      'M30.2': false,
      'M29.1': true,
      'M29.2': false,
      'Q1.1': true,
      'M27.2': false,
      'M31.7': true,
      'M15.0': false,
      'M15.1': true,
    };
    evaluateNetwork(extractNetwork(awl, 229), flashStabilization);
    evaluateNetwork(extractNetwork(awl, 240), flashStabilization);
    assert.equal(flashStabilization['Q1.1'], false, `${file} must drop Q1.1 during flash stabilization`);
  }
});

test('powers the heat source from stabilization through heat interference, then switches it off', () => {
  const awlFiles = ['PLC.awl', 'PLC0_中文注释_GBK.awl'];

  for (const file of awlFiles) {
    const awl = readFileSync(`${workspaceRoot}${file}`, 'utf8');
    const heatOutputNetwork = extractNetwork(awl, 227);
    const physicalHeatRelayNetwork = extractNetwork(awl, 243);

    assert.match(
      heatOutputNetwork,
      /\bO\s+M15\.0\b[\s\S]*\bO\s+M10\.4\b/,
      `${file} must combine stabilization and heat-interference states for Q0.1`,
    );

    const phases = [
      ['stabilization', { 'M15.0': true, 'M10.4': false }, true],
      ['heat interference', { 'M15.0': false, 'M10.4': true }, true],
      ['after heat interference', { 'M15.0': false, 'M10.4': false }, false],
    ];
    for (const [phase, inputs, expected] of phases) {
      const state = { 'M30.0': false, 'M31.7': true, ...inputs };
      evaluateNetwork(heatOutputNetwork, state);
      evaluateNetwork(physicalHeatRelayNetwork, state);
      assert.equal(state['Q0.1'], expected, `${file} Q0.1 state is incorrect ${phase}`);
    }
  }
});

test('runs five heat-source triggers with one-second timing windows', () => {
  const awl = readFileSync(`${workspaceRoot}PLC.awl`, 'utf8');
  const heatSequence = awl.slice(awl.indexOf('Network 74'), awl.indexOf('Network 90'));

  assert.equal((heatSequence.match(/S\s+M13\.[0-4],\s*1/g) ?? []).length, 5);
  assert.equal((heatSequence.match(/TON\s+T(?:37|40|41|42|43),\s*\+10/g) ?? []).length, 5);
  assert.equal((heatSequence.match(/S\s+M29\.3,\s*1/g) ?? []).length, 3);
  assert.match(heatSequence, /LD\s+T43[\s\S]*R\s+M10\.4,\s*1[\s\S]*S\s+M10\.5,\s*1/);
});

test('field readiness recognizes current vertical feedback and timeout syntax', () => {
  const awl = [
    'LD M10.0', 'A I0.3', '= M12.0',
    'LD M10.0', 'AN I0.3', 'TON T44, +20', 'LD T44', '= M15.0',
    'LD M10.3', 'A I0.4', '= M12.3',
    'LD M10.3', 'AN I0.4', 'TON T45, +25', 'LD T45', '= M15.1',
    'LD M10.5', 'A I0.3', '= M12.5',
    'LD M10.5', 'AN I0.3', 'TON T46, +25', 'LD T46', '= M15.2',
    'LD M10.7', 'A I0.4', '= M12.7',
    'LD M10.7', 'AN I0.4', 'TON T47, +20', 'LD T47', '= M15.3',
    'LD M20.0', 'O M15.0', 'O M15.1', 'O M15.2', 'O M15.3', '= M0.2',
    'S M2.0, 1', 'R Q0.0, 8', 'R Q1.0, 4',
  ].join('\n');

  assert.equal(hasVerticalFeedbackWithSafeTimeout(awl), true);
  assert.equal(hasVerticalFeedbackWithSafeTimeout(awl.replaceAll('I0.3', 'I1.3')), false);
});
