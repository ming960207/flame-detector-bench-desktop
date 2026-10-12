import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import test from 'node:test';
import { RawTcpModbusClient, MIN_RTU_COMMAND_GAP_MS } from '../src/modbus/flame-detector-raw-client.js';
import { calculateModbusCRC16 } from '../src/modbus/flame-data-decoder.js';
import { FlameDetectorDevice } from '../src/modbus/flame-detector-device.js';
import { setAlarmFaultSimulation } from '../src/modbus/flame-detector-relay-simulation.js';
import type { FlameConfig } from '../src/config.js';

test('relay FF frame waits for prior port write and does not use detector index as Modbus address', async () => {
  const frames: Buffer[] = [];
  const writeCallbacks: Array<() => void> = [];
  const socket = {
    destroyed: false,
    writable: true,
    write(bytes: Buffer, cb: (error?: Error | null) => void) {
      frames.push(Buffer.from(bytes));
      writeCallbacks.push(() => cb(null));
      return true;
    },
  } as unknown as Socket;
  const client = new RawTcpModbusClient(socket);
  const device = new FlameDetectorDevice(client, { index: 6, address: 6, enabled: true }, { protocol: 'standard' } as FlameConfig);

  const first = client.sendRawFrame(Buffer.from([0x12, 0x34, 0x56]));
  const simulation = setAlarmFaultSimulation(device, true, false);
  await setImmediate();
  assert.equal(frames.length, 1, 'FF simulation may not overtake an outstanding port write');
  assert.equal(frames[0]?.toString('hex'), '123456');
  writeCallbacks.shift()?.();
  await first;
  await setImmediate();
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.[0], 0xff, 'independent port uses FF even when persisted device address is 6');
  assert.equal(frames[1]?.[1], 0x10);
  assert.equal(frames[1]?.readUInt16BE(2), 0xa000);
  assert.equal(frames[1]?.readUInt16BE(4), 2);
  assert.equal(frames[1]?.readUInt16BE(7), 0x0000);
  assert.equal(frames[1]?.readUInt16BE(9), 0x0000);
  writeCallbacks.shift()?.();
  await simulation;
});

test('a rejected TCP write must not be counted as a delivered command', async () => {
  const socket = {
    destroyed: false,
    writable: true,
    write(_frame: Buffer, callback: (error?: Error | null) => void) {
      callback(new Error('write failed'));
      return false;
    },
  } as unknown as Socket;
  const client = new RawTcpModbusClient(socket);
  const device = new FlameDetectorDevice(client, { index: 2, address: 2, enabled: true }, { protocol: 'standard' } as FlameConfig);
  await assert.rejects(() => setAlarmFaultSimulation(device, false, true), /write failed/);
});

function writeAck(start: number, quantity: number): Buffer {
  const body = Buffer.alloc(6);
  body[0] = 0x01;
  body[1] = 0x10;
  body.writeUInt16BE(start, 2);
  body.writeUInt16BE(quantity, 4);
  const crc = calculateModbusCRC16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
}

test('late FC10 ACK for another register cannot confirm an F000 reset; next RTU frame is spaced', async () => {
  const transmitted: Array<{ frame: Buffer; time: number }> = [];
  const source = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    write(data: Buffer, callback?: (error?: Error | null) => void) {
      transmitted.push({ frame: Buffer.from(data), time: Date.now() });
      callback?.(null);
      return true;
    },
  }) as unknown as Socket;
  const client = new RawTcpModbusClient(source, 500);
  let completed = false;
  const reset = client.writeRegisters(1, 0xf000, [0x1234]).then(() => { completed = true; });
  await setImmediate();
  assert.equal(transmitted.length, 1);
  source.emit('data', writeAck(0xa000, 1));
  await setImmediate();
  assert.equal(completed, false, 'stale ACK for A000 must not confirm F000');
  source.emit('data', writeAck(0xf000, 2));
  await setImmediate();
  assert.equal(completed, false, 'wrong FC10 quantity must not confirm the reset');
  source.emit('data', writeAck(0xf000, 1));
  await reset;

  await client.sendRawFrame(Buffer.from([0xff, 0x10, 0x00]));
  assert.equal(transmitted.length, 2);
  assert.ok(transmitted[1]!.time - transmitted[0]!.time >= MIN_RTU_COMMAND_GAP_MS - 15);
});
