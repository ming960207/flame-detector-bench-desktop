import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCustomWaveformFrame,
  extractCustomWaveformFrames,
} from '../src/modbus/flame-data-decoder.js';

function frame27(seed: number): Buffer {
  const frame = Buffer.alloc(27);
  frame[0] = 0x5A;
  frame[1] = 0xA5;
  for (let offset = 2; offset < 26; offset += 2) frame.writeInt16LE(seed + offset, offset);
  return frame;
}

function captured29(): Buffer {
  return Buffer.from(
    '5AA5018061012101010101807101510111808101810101808101510133',
    'hex',
  );
}

test('custom waveform extraction resynchronizes across startup text between frames', () => {
  const extracted = extractCustomWaveformFrames(
    Buffer.concat([frame27(100), Buffer.from('startup_JLink_OK:V90220'), frame27(200)]),
    [27, 29, 35, 170],
  );

  assert.deepEqual(extracted.frames.map((frame) => frame.length), [27, 27]);
  assert.equal(extracted.remainder.length, 0);
  assert.equal(decodeCustomWaveformFrame(extracted.frames[0]!).samples.length, 4);
});

test('custom waveform extraction keeps the validated 29-byte frame when the next header is offset by noise', () => {
  const extracted = extractCustomWaveformFrames(
    Buffer.concat([captured29(), Buffer.from([0x00, 0x01]), frame27(300)]),
    [27, 29, 35, 170],
  );

  assert.deepEqual(extracted.frames.map((frame) => frame.length), [29, 27]);
  assert.equal(extracted.remainder.length, 0);
  assert.equal(decodeCustomWaveformFrame(extracted.frames[0]!).checksumValid, true);
});
