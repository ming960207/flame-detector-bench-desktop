import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWifiPrinterDevices } from '../../components/label-printer-runtime.ts';

test('WiFi 扫描响应按 SDK 契约解析 deviceName、IP 和 tcpPort', () => {
  const devices = normalizeWifiPrinterDevices({
    resultAck: {
      errorCode: 0,
      info: JSON.stringify([
        { deviceName: 'K3W-E828013369', IP: '192.168.1.10', tcpPort: '9200' },
        { deviceName: 'B21-SECOND', IP: '192.168.1.11', tcpPort: 9201 },
        { deviceName: 'invalid-port', IP: '192.168.1.12', tcpPort: 'not-a-port' },
      ]),
    },
  });

  assert.deepEqual(devices, [
    { connectionType: 'wifi', name: 'K3W-E828013369', address: '192.168.1.10', port: 9200 },
    { connectionType: 'wifi', name: 'B21-SECOND', address: '192.168.1.11', port: 9201 },
  ]);
});

test('WiFi 扫描列表支持直接传入数组并去重同一设备端口', () => {
  const devices = normalizeWifiPrinterDevices([
    { deviceName: 'K3W', IP: '192.168.1.20', tcpPort: '9200' },
    { deviceName: 'K3W', IP: '192.168.1.20', tcpPort: 9200 },
  ]);

  assert.deepEqual(devices, [
    { connectionType: 'wifi', name: 'K3W', address: '192.168.1.20', port: 9200 },
  ]);
});
