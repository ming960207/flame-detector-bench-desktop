import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildMESProductPayload,
  defaultMESConfig,
  MESPublisher,
  type MESConfig,
  type MESProductSubmission,
} from '../src/mes-publisher.js';
import type { ProductionInspectionProductResult } from '../src/production-inspection-record.js';
import type { ProductionInspectionRecordStore } from '../src/production-inspection-record-store.js';
import type { ProductionRunArchive } from '../src/production-run-coordinator.js';

function product(productCode: string, verdict: '合格' | '不合格', slot: number): ProductionInspectionProductResult {
  return { productCode, verdict, slot } as ProductionInspectionProductResult;
}

const config: MESConfig = {
  enabled: true,
  baseUrl: 'http://mes.test',
  apiKey: 'test-key',
  operatorName: '',
  requestTimeoutMs: 2_000,
};

test('MES 无历史配置时默认启用自动上传', () => {
  const previous = process.env.MES_ENABLED;
  try {
    delete process.env.MES_ENABLED;
    assert.equal(defaultMESConfig().enabled, true);
  } finally {
    if (previous === undefined) delete process.env.MES_ENABLED;
    else process.env.MES_ENABLED = previous;
  }
});

test('MES 产品录入载荷关联上传附件并区分合格状态', () => {
  const submission: MESProductSubmission = {
    productCode: '410205901010100001',
    inspectionStatus: 0,
    inspectionResult: '检测结果：不合格',
    jbrName: '张三',
    remark: '批次 batch-1，槽位 D1',
  };
  const payload = buildMESProductPayload(submission, [{ url: 'file-1' }]);
  assert.equal(payload.deviceCode, '410205901010100001');
  assert.equal(payload.inspectionStatus, 0);
  assert.equal(payload.jbrName, '张三');
  assert.equal(payload.files, '[{"url":"file-1"}]');
  assert.match(String(payload.inspectionResult), /不合格/);
});

test('MES 上传先上传检验报告，再逐个录入产品编号', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-mes-test-'));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/DeviceBom/UploadFile')) {
      assert.equal(init?.method, 'POST');
      assert.ok(init?.body instanceof FormData);
      return new Response(JSON.stringify({ code: 1, msg: '上传成功', data: [{ url: 'report-1', fileName: 'report.doc', fileOriginName: 'report.doc' }] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { deviceCode: string; files: string };
    assert.match(body.files, /report-1/);
    return new Response(JSON.stringify({ code: 1, msg: '操作成功', data: null }), { status: 200 });
  };
  const recordStore = { loadHtml: async () => '<html><body>检验报告</body></html>' } as unknown as ProductionInspectionRecordStore;
  const archive = {
    batchId: 'batch-1',
    inspectionRecord: {
      batchId: 'batch-1',
      productModel: 'GHT-1050',
      inspector: '张三',
      products: [product('410205901010100001', '合格', 1), product('410205901010100002', '不合格', 2)],
    },
  } as ProductionRunArchive;
  try {
    const publisher = new MESPublisher(config, {
      outboxFile: join(directory, 'outbox.json'),
      fetchImpl,
      log: (message) => logs.push(message),
    });
    assert.equal(await publisher.publishArchive(archive, recordStore), true);
    assert.equal(calls.length, 3);
    assert.match(calls[0]!.url, /UploadFile$/);
    assert.match(calls[1]!.url, /BriefCreateOrUpdate$/);
    assert.match(calls[2]!.url, /BriefCreateOrUpdate$/);
    assert.equal(publisher.getPublicStatus().pendingJobs, 0);
    assert.ok(logs.some((message) => message.includes('[MES] MES自动上传成功：批次 batch-1')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MES 未启用时记录自动上传跳过原因', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flame-mes-disabled-test-'));
  const logs: string[] = [];
  const publisher = new MESPublisher({ ...config, enabled: false }, {
    outboxFile: join(directory, 'outbox.json'),
    log: (message) => logs.push(message),
  });
  try {
    assert.equal(await publisher.publishArchive({ batchId: 'batch-disabled' } as ProductionRunArchive, {} as ProductionInspectionRecordStore), false);
    assert.ok(logs.some((message) => message.includes('[MES] MES自动上传跳过：批次 batch-disabled，功能未启用')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
