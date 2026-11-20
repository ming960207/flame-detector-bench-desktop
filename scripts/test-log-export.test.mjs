import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, archiveMayContainDate } from './test-log-export.mjs';

test('按北京时间选择跨 UTC 日界的归档', () => {
  assert.equal(archiveMayContainDate('20261119T160000Z-field-waveform-1', '2026-11-20'), true);
  assert.equal(archiveMayContainDate('20261120T155959Z-field-waveform-2', '2026-11-20'), true);
  assert.equal(archiveMayContainDate('20261120T160000Z-field-waveform-3', '2026-11-20'), false);
});

test('提取完成时间、噪声及各工序比值，保留数值与缺失值', () => {
 const log = `完成时间：2026-11-20 16:02:26（Asia/Shanghai (UTC+8)）\n批次：b1 | 产品：双波长 | 结果：合格 | 等级：A | 耗时：120秒 | 设备：1\n\n噪声采集诊断\n| 设备 | 采样数 | P2波动 | P2绝对值 | P3波动 | P3绝对值 | 结果 | 说明 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 400 | 112 | 417 | 120 | 369 | 合格 | - |\n\n工序检测明细\n| 工序 | 设备 | 采样数 | 干扰比 | 一致性 | P2/P1 | P2/P3 | P3/P1 | 结果 | 说明 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 热源检测 | 1 | 164 | 0.6 | 0.9 | 23.25 | - | 14 | 合格 | 正常 |\n`;
 const result = parseLog(log, 'archive');
 assert.equal(result.time, '2026-11-20 16:02:26');
 assert.deepEqual(result.noise[0].slice(0, 6), [1,400,112,417,120,369]);
 assert.equal(result.stages[0][6], null);
 assert.equal(result.stages[0][5], 23.25);
});
