import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { Socket } from 'node:net';
import test from 'node:test';
import { RawTcpModbusClient } from '../src/modbus/flame-detector-raw-client.js';
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
