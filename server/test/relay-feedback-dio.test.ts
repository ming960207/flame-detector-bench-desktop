import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DioModbusTcpInputSource,
  type ModbusTcpClientLike,
} from '../src/relay-feedback-dio.js';
import {
  DEFAULT_RELAY_DIO_CONFIG,
  DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
} from '../src/relay-functional-test.js';

test('现场继电器测试默认参数与 DIO 接线一致', () => {
  assert.deepEqual(DEFAULT_RELAY_DIO_CONFIG, {
    host: '192.168.0.7',
    port: 8234,
    unitId: 1,
    functionCode: 4,
    startAddress: 0,
    inputCount: 16,
    requestTimeoutMs: 1500,
  });
  assert.equal(DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG.enabled, true);
  assert.deepEqual(
    DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG.mappings.map(({ alarmInputAddress, faultInputAddress }) => [alarmInputAddress, faultInputAddress]),
    [['X1', 'X2'], ['X3', 'X4'], ['X5', 'X6'], ['X7', 'X8'], ['X9', 'X10'], ['X11', 'X12']],
  );
  assert.equal(DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG.mappings.every((mapping) => mapping.alarmNormalLevel === false), true);
  assert.equal(DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG.mappings.every((mapping) => mapping.faultNormalLevel === true), true);
});

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
  const source = new DioModbusTcpInputSource({ ...DEFAULT_RELAY_DIO_CONFIG, host: '' });

  await assert.rejects(
    source.readInputs(),
    (error: unknown) => error instanceof Error && error.message === 'DIO_NOT_CONFIGURED',
  );
});
