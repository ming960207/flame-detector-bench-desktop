import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateModbusCRC16,
  decodeCustomWaveformFrame,
  decodeModbusRealtimeFrame,
  extractCustomWaveformFrames,
  extractModbusRealtimeFrames,
} from '../dist/modbus/flame-data-decoder.js';

test('decodes the 170-byte standard waveform frame without a trailing checksum byte', () => {
  const frame = Buffer.alloc(170);
  frame[0] = 0x5A;
  frame[1] = 0xA5;

  // 28 standard (three-probe) samples occupy the remaining 168 bytes.
  const firstSample = [1, 2, 3];
  firstSample.forEach((value, channel) => frame.writeInt16LE(value, 2 + channel * 2));

  const decoded = decodeCustomWaveformFrame(frame);

  assert.equal(decoded.samples.length, 28);
  assert.deepEqual(decoded.samples[0], { probe1: 1, probe2: 2, probe3: 3 });
});

test('decodes the captured 29-byte standard waveform frame with its extra word', () => {
  const frame = Buffer.from(
    '5A A5 01 80 61 01 21 01 01 01 01 80 71 01 51 01 11 80 81 01 81 01 01 80 81 01 51 01 33'.replaceAll(' ', ''),
    'hex',
  );
  const nextFrame = Buffer.from(
    '5A A5 01 80 21 01 01 01 01 80 11 01 01 01 01 80 F1 00 F1 00 01 80 21 01 31 01 71'.replaceAll(' ', ''),
    'hex',
  );
  const extracted = extractCustomWaveformFrames(Buffer.concat([frame, nextFrame]), [27, 29, 35, 170]);
  assert.deepEqual(extracted.frames.map((item) => item.length), [29, 27]);

  const decoded = decodeCustomWaveformFrame(extracted.frames[0]);
  assert.equal(decoded.samples.length, 4);
  assert.equal(decoded.checksum, 0x33);
  assert.equal(decoded.checksumValid, true);
  assert.deepEqual(decoded.samples[0], { probe1: -32767, probe2: 353, probe3: 289 });
});

function createModbusRealtimeFrame(registers, address = 1) {
  const frame = Buffer.alloc(5 + registers.length * 2);
  frame[0] = address;
  frame[1] = 0x03;
  frame[2] = registers.length * 2;
  registers.forEach((value, index) => frame.writeUInt16BE(value & 0xFFFF, 3 + index * 2));
  const crc = calculateModbusCRC16(frame.subarray(0, -2));
  frame[frame.length - 2] = crc & 0xFF;
  frame[frame.length - 1] = (crc >> 8) & 0xFF;
  return frame;
}

test('extracts and decodes a Modbus realtime push frame on the port that received it', () => {
  const registers = Array(67).fill(0);
  registers[3] = 0x0102;
  registers[4] = 0x0304;
  registers[5] = 0x0506;
  const frame = createModbusRealtimeFrame(registers);

  const extracted = extractModbusRealtimeFrames(frame, [0x86]);

  assert.equal(extracted.frames.length, 1);
  assert.deepEqual(extracted.remainder, Buffer.alloc(0));
  const decoded = decodeModbusRealtimeFrame(extracted.frames[0]);
  assert.deepEqual(decoded.samples[0], { probe1: 0x0102, probe3: 0x0304, probe2: 0x0506 });
});
