import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DioModbusTcpInputSource,
  type ModbusTcpClientLike,
} from '../src/relay-feedback-dio.js';
import { DEFAULT_RELAY_DIO_CONFIG } from '../src/relay-functional-test.js';

test('DIO Modbus TCP input source maps FC04 register values to X channels', async () => {
  const calls: Array<[string, number, number]> = [];
  const client: ModbusTcpClientLike = {
    isOpen: true,
    setID: (unitId) => calls.push(['setID', unitId, 0]),
    setTimeout: () => undefined,
    readInputRegisters: async (address, length) => {
      calls.push(['readInputRegisters', address, length]);
      return { data: [0, 1, 0, 1] };
    },
    readDiscreteInputs: async () => ({ data: [] }),
    connectTCP: async () => undefined,
    close: () => undefined,
  };

  const source = new DioModbusTcpInputSource({
    ...DEFAULT_RELAY_DIO_CONFIG,
    host: '192.168.1.100',
    inputCount: 4,
  }, () => client);

  assert.deepEqual(await source.readInputs(), {
    X1: false,
    X2: true,
    X3: false,
    X4: true,
  });
  assert.deepEqual(calls, [
    ['setID', 1, 0],
    ['readInputRegisters', 0, 4],
  ]);
});

test('DIO Modbus TCP source returns an explicit configuration error without host', async () => {
  const source = new DioModbusTcpInputSource(DEFAULT_RELAY_DIO_CONFIG);

  await assert.rejects(
    source.readInputs(),
    (error: unknown) => error instanceof Error && error.message === 'DIO_NOT_CONFIGURED',
  );
});
