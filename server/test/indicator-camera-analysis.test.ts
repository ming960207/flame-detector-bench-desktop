import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { analyzeIndicatorFrame, aggregateSamples, completedIndicatorResults, shouldSampleIndicatorEvidence } from '../../components/indicator-camera-analysis.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/indicator-red-small-spots.json', import.meta.url), 'utf8'));
const roi = { slot: 2, x: 0, y: 0, width: 1, height: 1 };
function image(width = 96, height = 97): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
}
function pixel(frame: ImageData, x: number, y: number, rgb = [230, 35, 45]) {
  frame.data.set([...rgb, 255], (y * frame.width + x) * 4);
}

test('actual screenshot small red LEDs in slots 1–3 are detected inside their ROIs', () => {
  for (const fixture of fixtures) {
    const frame = { width: fixture.width, height: fixture.height, data: new Uint8ClampedArray(gunzipSync(Buffer.from(fixture.rgbaGzip, 'base64'))) } as ImageData;
    const result = analyzeIndicatorFrame(frame, [{ ...roi, slot: fixture.slot }], 'ALARM_VERIFY')[0]!;
    assert.equal(result.lights.red.state, 'ON', `D${fixture.slot}, ratio=${result.lights.red.matchRatio}`);
  }
});

test('small connected LED survives sparse sampling alignment and large ROI', () => {
  const frame = image();
  for (let y = 31; y < 34; y++) for (let x = 31; x < 35; x++) pixel(frame, x, y);
  assert.equal(analyzeIndicatorFrame(frame, [roi], 'ALARM_VERIFY')[0]!.lights.red.state, 'ON');
});

test('connected green and yellow LEDs retain their colour classification', () => {
  for (const [colour, rgb] of [['green', [30, 230, 45]], ['yellow', [230, 200, 35]]] as const) {
    const frame = image();
    for (let y = 31; y < 35; y++) for (let x = 31; x < 35; x++) pixel(frame, x, y, [...rgb]);
    const result = analyzeIndicatorFrame(frame, [roi], 'FAULT_VERIFY')[0]!;
    assert.equal(result.lights[colour].state, 'ON');
    assert.equal(result.lights.red.state, 'OFF');
  }
});

test('isolated red noise, white glare and light outside ROI do not pass', () => {
  const frame = image();
  for (let y = 0; y < frame.height; y += 5) for (let x = 0; x < frame.width; x += 5) pixel(frame, x, y);
  assert.equal(analyzeIndicatorFrame(frame, [roi], 'ALARM_VERIFY')[0]!.lights.red.state, 'OFF');
  frame.data.fill(255);
  assert.equal(analyzeIndicatorFrame(frame, [roi], 'ALARM_VERIFY')[0]!.lights.red.state, 'OFF');
  frame.data.fill(0);
  for (let y = 31; y < 35; y++) for (let x = 70; x < 74; x++) pixel(frame, x, y);
  assert.equal(analyzeIndicatorFrame(frame, [{ ...roi, width: 0.5 }], 'ALARM_VERIFY')[0]!.lights.red.state, 'OFF');
});

test('red light still requires evidence from two frames in the alarm phase', () => {
  const frame = image();
  for (let y = 31; y < 35; y++) for (let x = 31; x < 35; x++) pixel(frame, x, y);
  const sample = { capturedAt: 1, phase: 'ALARM_VERIFY' as const, slots: analyzeIndicatorFrame(frame, [roi], 'ALARM_VERIFY') };
  assert.equal(aggregateSamples([sample], 'ALARM_VERIFY', [roi])[0]!.verdict, 'WAITING');
  assert.equal(aggregateSamples([sample, { ...sample, capturedAt: 241 }], 'ALARM_VERIFY', [roi])[0]!.verdict, 'PASS');
  assert.equal(aggregateSamples([{ ...sample, phase: 'BASELINE' }], 'ALARM_VERIFY', [roi])[0]!.verdict, 'WAITING');
});

test('UVC auto samples from position one even before product precheck starts, then stops after completion', () => {
  const base = { batchId: 'batch-1', positionOneReady: true, precheckBusy: false, relayBatchId: null, relayActive: false, relayPhase: 'MANUAL' as const };
  assert.equal(shouldSampleIndicatorEvidence(base), true);
  assert.equal(shouldSampleIndicatorEvidence({ ...base, positionOneReady: false }), false);
  assert.equal(shouldSampleIndicatorEvidence({ ...base, positionOneReady: false, precheckBusy: true }), true);
  assert.equal(shouldSampleIndicatorEvidence({ ...base, positionOneReady: false, relayBatchId: 'old-batch', relayActive: true }), false);
  assert.equal(shouldSampleIndicatorEvidence({ ...base, relayBatchId: 'batch-1', relayPhase: 'COMPLETE', relayActive: false }), false);
});

test('early red lamp captured during ALARM_COMMAND can be used only after a stable dark-red baseline', () => {
  const baseFrame = image();
  for (let y = 31; y < 35; y++) for (let x = 31; x < 35; x++) pixel(baseFrame, x, y, [30, 230, 45]);
  const alarmFrame = image();
  for (let y = 31; y < 35; y++) for (let x = 31; x < 35; x++) pixel(alarmFrame, x, y, [230, 30, 45]);

  const observed = (frame: ImageData, phase: 'BASELINE' | 'ALARM_COMMAND', count = 2) =>
    aggregateSamples(Array.from({ length: count }, (_, i) => ({
      capturedAt: i * 160, phase, slots: analyzeIndicatorFrame(frame, [roi], phase),
    })), phase, [roi]);

  const phases = new Map();
  phases.set('BASELINE', observed(baseFrame, 'BASELINE'));
  phases.set('ALARM_COMMAND', observed(alarmFrame, 'ALARM_COMMAND'));
  const early = completedIndicatorResults(phases, [roi])[0]!;
  assert.equal(early.lights.red.state, 'ON');
  assert.equal(early.verdict, 'PASS');

  phases.set('BASELINE', observed(alarmFrame, 'BASELINE'));
  const invalid = completedIndicatorResults(phases, [roi])[0]!;
  assert.equal(invalid.lights.red.state, 'UNKNOWN', 'red already ON before command must never prove a rising transition');

  phases.set('BASELINE', observed(baseFrame, 'BASELINE'));
  phases.set('ALARM_COMMAND', observed(alarmFrame, 'ALARM_COMMAND', 1));
  assert.equal(completedIndicatorResults(phases, [roi])[0]!.lights.red.state, 'UNKNOWN', 'single red frame cannot pass');
});
