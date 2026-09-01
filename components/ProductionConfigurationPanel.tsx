import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, FileText, RefreshCw, Save } from 'lucide-react';
import type { RelayDioConfig, RelayFunctionalTestConfig } from '../server/src/relay-functional-test';
import type { ProductionInspectionRecordConfig } from '../server/src/production-inspection-record';

interface Props {
  backendHttpUrl: string;
  locked: boolean;
}

interface RelayPayload {
  config: RelayFunctionalTestConfig;
  missingMappings: string[];
  ready: boolean;
  dioReady?: boolean;
  mappingReady?: boolean;
}

interface ProductionConfigPayload {
  relay: RelayPayload;
  recordConfig: ProductionInspectionRecordConfig;
}

interface ProductionRecordSummary {
  batchId: string;
  generatedAt: number;
  productModel: string;
  conclusion: '合格' | '不合格';
}

const palette = {
  panelTop: '#082537',
  panelBottom: '#04131f',
  field: '#061722',
  border: '#1ccfe166',
  borderSoft: '#2b728299',
  cyan: '#43dced',
  text: '#ccecf5',
  title: '#f0fcff',
  muted: '#7fa9b4',
  dim: '#64818b',
  pass: '#62e7b6',
  warn: '#e2c363',
  fail: '#f27769',
};

const inputStyle = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box' as const,
  border: `1px solid ${palette.borderSoft}`,
  background: palette.field,
  color: palette.text,
  padding: '7px 8px',
  font: 'inherit',
  fontSize: 11,
  outline: 'none',
};

const labelStyle = {
  display: 'grid',
  gap: 5,
  color: palette.muted,
  fontSize: 10.5,
};

function configuredInputCount(relay: RelayPayload | null): number {
  if (!relay) return 0;
  return relay.config.mappings.reduce((count, mapping) => (
    count
    + (isDioChannelAddress(mapping.alarmInputAddress) ? 1 : 0)
    + (isDioChannelAddress(mapping.faultInputAddress) ? 1 : 0)
  ), 0);
}

function isDioChannelAddress(value: string | undefined): boolean {
  const match = /^X(\d+)$/.exec(value?.trim().toUpperCase() || '');
  if (!match) return false;
  const channel = Number(match[1]);
  return Number.isInteger(channel) && channel >= 1 && channel <= 64;
}

function dioErrorText(code: string | undefined): string {
  if (code === 'DIO_NOT_CONFIGURED') return '请先填写 DIO 模块 IP 地址';
  if (code === 'DIO_CONNECTION_FAILED') return 'DIO 模块连接失败，请检查 IP、端口和网络';
  if (code === 'DIO_RESPONSE_INVALID') return 'DIO 模块返回数据格式不正确';
  if (code === 'DIO_READ_FAILED') return 'DIO 输入读取失败';
  return code || 'DIO 连接测试失败';
}

function recordTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function ProductionConfigurationPanel({ backendHttpUrl, locked }: Props) {
  const [relay, setRelay] = useState<RelayPayload | null>(null);
  const [recordConfig, setRecordConfig] = useState<ProductionInspectionRecordConfig | null>(null);
  const [records, setRecords] = useState<ProductionRecordSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dioTesting, setDioTesting] = useState(false);
  const [message, setMessage] = useState('');

  const inputCount = useMemo(() => configuredInputCount(relay), [relay]);
  const mappingsComplete = inputCount === 12;
 const relayReady = relay?.ready === true;
 const dioReady = relay?.dioReady === true;
 const mappingReady = relay?.mappingReady === true || mappingsComplete;
  const messageIsSuccess = message.includes('已保存') || message.includes('测试成功');

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-records?limit=20`);
      if (!response.ok) throw new Error(`生产记录读取失败 (${response.status})`);
      const payload = await response.json() as { records?: ProductionRecordSummary[] };
      setRecords(Array.isArray(payload.records) ? payload.records : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRecordsLoading(false);
    }
  }, [backendHttpUrl]);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-config`);
      if (!response.ok) throw new Error(`生产配置读取失败 (${response.status})`);
      const payload = await response.json() as ProductionConfigPayload;
      setRelay(payload.relay);
      setRecordConfig(payload.recordConfig);
      void loadRecords();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [backendHttpUrl, loadRecords]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!relay || !recordConfig || locked) return;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relayConfig: relay.config, recordConfig }),
      });
      const result = await response.json() as ProductionConfigPayload & { success?: boolean; code?: string; error?: string };
      if (!response.ok || !result.success || !result.relay || !result.recordConfig) throw new Error(result.error || result.code || '生产配置保存失败');

      setRelay(result.relay);
      setRecordConfig(result.recordConfig);
      setMessage('配置已保存并立即应用');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const testDioConnection = async () => {
    if (!relay || controlDisabled || dioTesting) return;
    setDioTesting(true);
    setMessage('正在测试 DIO Modbus TCP 连接…');
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-config/dio/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dio: relay.config.dio }),
      });
      const result = await response.json() as { success?: boolean; inputCount?: number; code?: string; error?: string };
      if (!response.ok || !result.success) {
        throw new Error(dioErrorText(result.code) + (result.error && result.error !== result.code ? `：${result.error}` : ''));
      }
      setMessage(`DIO 连接测试成功，已读取 ${result.inputCount ?? relay.config.dio.inputCount} 路输入`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDioTesting(false);
    }
  };

  const openRecord = (batchId: string) => {
    window.open(`${backendHttpUrl}/api/production-records/${encodeURIComponent(batchId)}/html`, '_blank', 'noopener,noreferrer');
  };

  const openLatestRecord = async () => {
    setMessage('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-records/latest`);
      if (!response.ok) throw new Error('尚无已完成的生产检验记录');
      const record = await response.json() as { batchId: string };
      openRecord(record.batchId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const controlDisabled = locked || loading || !relay;

  return <section className="production-config-panel" aria-labelledby="production-config-title" style={{ width: '100%', border: `1px solid ${palette.border}`, background: `linear-gradient(145deg,${palette.panelTop},${palette.panelBottom})`, color: palette.text, boxShadow: 'inset 0 0 24px rgba(32,204,229,.05)' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 18px', borderBottom: `1px solid ${palette.borderSoft}` }}>
          <div>
            <small style={{ color: palette.cyan, font: '700 10px Consolas, monospace', letterSpacing: '.16em' }}>PRODUCTION CONFIG</small>
            <h2 id="production-config-title" style={{ margin: '4px 0 0', color: palette.title, fontSize: 18 }}>生产检验、记录与继电器反馈</h2>
            <div style={{ marginTop: 5, color: locked ? palette.warn : palette.dim, fontSize: 10.5 }}>{locked ? '当前流程运行中：记录可查看，配置保持只读' : '配置永久保存；正式批次启动时冻结本批次配置与产品编号'}</div>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button type="button" onClick={() => void load()} disabled={loading} title="重新读取后台配置与记录" style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.cyan, cursor: loading ? 'wait' : 'pointer', opacity: loading ? .5 : 1 }}><RefreshCw size={14} /></button>
          </div>
        </header>

        {loading && <div style={{ padding: 28, color: palette.cyan, fontSize: 12 }}>正在读取生产配置…</div>}

        {!loading && relay && recordConfig && <div style={{ padding: 18, display: 'grid', gap: 14 }}>
          <section style={{ border: `1px solid ${palette.borderSoft}`, background: 'rgba(4,19,31,.55)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div>
                <b style={{ color: palette.title, fontSize: 13 }}>继电器反馈检测源</b>
                <div style={{ color: palette.muted, fontSize: 10.5, marginTop: 3 }}>DIO 仅在继电器功能测试期间读取，不改变 PLC I/O 页面，也不做后台实时监视。</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 10.5 }}>
                <b style={{ color: dioReady && mappingReady ? palette.pass : palette.warn }}>{dioReady && mappingReady ? '参数与映射完整' : '待完成配置'}</b>
                <div style={{ marginTop: 2, color: palette.dim }}>{relayReady ? 'Modbus TCP · 测试可用' : 'Modbus TCP'}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.35fr .7fr .55fr .8fr', gap: 8 }}>
              <label style={labelStyle}>设备 IP<input disabled={controlDisabled} value={relay.config.dio.host} placeholder="例如 192.168.1.100" onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, host: e.target.value } } })} style={inputStyle} /></label>
              <label style={labelStyle}>TCP 端口<input disabled={controlDisabled} type="number" min={1} max={65535} value={relay.config.dio.port} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, port: Number(e.target.value) } } })} style={inputStyle} /></label>
              <label style={labelStyle}>Unit ID<input disabled={controlDisabled} type="number" min={1} max={255} value={relay.config.dio.unitId} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, unitId: Number(e.target.value) } } })} style={inputStyle} /></label>
              <label style={labelStyle}>读取功能码<select disabled={controlDisabled} value={relay.config.dio.functionCode} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, functionCode: Number(e.target.value) as RelayDioConfig['functionCode'] } } })} style={inputStyle}><option value="4">04 · 输入寄存器</option><option value="2">02 · 离散输入</option></select></label>
              <label style={labelStyle}>起始地址<input disabled={controlDisabled} type="number" min={0} max={65535} value={relay.config.dio.startAddress} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, startAddress: Number(e.target.value) } } })} style={inputStyle} /></label>
              <label style={labelStyle}>输入数量<input disabled={controlDisabled} type="number" min={1} max={64} value={relay.config.dio.inputCount} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, inputCount: Number(e.target.value) } } })} style={inputStyle} /></label>
              <label style={labelStyle}>请求超时 ms<input disabled={controlDisabled} type="number" min={200} max={5000} value={relay.config.dio.requestTimeoutMs} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, dio: { ...relay.config.dio, requestTimeoutMs: Number(e.target.value) } } })} style={inputStyle} /></label>
              <div style={{ display: 'flex', alignItems: 'end', gap: 7 }}>
                <button type="button" onClick={() => void testDioConnection()} disabled={controlDisabled || dioTesting} style={{ flex: 1, minHeight: 30, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.cyan, cursor: controlDisabled || dioTesting ? 'wait' : 'pointer', font: 'inherit', fontSize: 10.5 }}>{dioTesting ? '测试中…' : '测试连接'}</button>
              </div>
            </div>
            <div style={{ marginTop: 9, color: palette.dim, fontSize: 10, lineHeight: 1.6 }}>协议地址从 0 开始；X1 对应协议地址 0x0000。继电器反馈输入只参与测试判定，通讯失败时测试直接判定失败。</div>
          </section>

          <section style={{ border: `1px solid ${palette.borderSoft}`, background: 'rgba(4,19,31,.55)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div>
                <b style={{ color: palette.title, fontSize: 13 }}>继电器功能测试</b>
                <div style={{ color: palette.muted, fontSize: 10.5, marginTop: 3 }}>FAST_BATCH：6 台并行火警 → 复位 → 6 台并行故障 → 复位；不会使用火警+故障联合激励。</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 10.5 }}>
                <b style={{ color: relayReady ? palette.pass : palette.warn }}>DIO 反馈 {inputCount}/12</b>
                <div style={{ marginTop: 2, color: relay.config.enabled ? (relayReady ? palette.pass : palette.warn) : palette.dim }}>{relay.config.enabled ? (relayReady ? '设备级测试已具备执行条件' : mappingsComplete ? '映射已完整，但 DIO 参数未完整' : '总开关已开，但映射未完整') : '设备级测试总开关关闭'}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(0,1fr))', gap: 8, marginBottom: 13 }}>
              <label style={labelStyle}>设备级总开关<select disabled={controlDisabled} value={relay.config.enabled ? '1' : '0'} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, enabled: e.target.value === '1' } })} style={inputStyle}><option value="0">关闭</option><option value="1">启用</option></select></label>
              <label style={labelStyle}>测试模式<select disabled={controlDisabled} value={relay.config.mode} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, mode: e.target.value as RelayFunctionalTestConfig['mode'] } })} style={inputStyle}><option value="FAST_BATCH">FAST_BATCH</option><option value="DIAGNOSTIC">DIAGNOSTIC</option></select></label>
              <label style={labelStyle}>动作超时 ms<input disabled={controlDisabled} type="number" value={relay.config.feedbackTimeoutMs} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, feedbackTimeoutMs: Number(e.target.value) } })} style={inputStyle} /></label>
              <label style={labelStyle}>复位超时 ms<input disabled={controlDisabled} type="number" value={relay.config.resetTimeoutMs} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, resetTimeoutMs: Number(e.target.value) } })} style={inputStyle} /></label>
              <label style={labelStyle}>稳定采样次数<input disabled={controlDisabled} type="number" min={1} max={10} value={relay.config.stableSamples} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, stableSamples: Number(e.target.value) } })} style={inputStyle} /></label>
              <label style={labelStyle}>采样间隔 ms<input disabled={controlDisabled} type="number" min={50} max={1000} value={relay.config.sampleIntervalMs} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, sampleIntervalMs: Number(e.target.value) } })} style={inputStyle} /></label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '.5fr 1fr .9fr 1fr .9fr', gap: 7, color: palette.muted, fontSize: 10.5, padding: '0 6px 6px' }}><b>槽位</b><b>Alarm 反馈通道</b><b>Alarm 正常态</b><b>Fault 反馈通道</b><b>Fault 正常态</b></div>
            {relay.config.mappings.map((mapping, row) => {
              const update = (patch: Partial<typeof mapping>) => {
                const mappings = relay.config.mappings.map((item, index) => index === row ? { ...item, ...patch } : item);
                setRelay({ ...relay, config: { ...relay.config, mappings } });
              };
              const rowReady = isDioChannelAddress(mapping.alarmInputAddress) && isDioChannelAddress(mapping.faultInputAddress);
              return <div key={mapping.detectorIndex} style={{ display: 'grid', gridTemplateColumns: '.5fr 1fr .9fr 1fr .9fr', gap: 7, alignItems: 'center', marginBottom: 6, padding: '5px 6px', border: `1px solid ${rowReady ? 'rgba(98,231,182,.18)' : 'rgba(226,195,99,.16)'}`, background: 'rgba(6,23,34,.72)' }}>
                <b style={{ color: rowReady ? palette.pass : palette.warn }}>D{mapping.detectorIndex}</b>
                <input disabled={controlDisabled} value={mapping.alarmInputAddress} placeholder="如 X1" onChange={(e) => update({ alarmInputAddress: e.target.value })} style={inputStyle} />
                <select disabled={controlDisabled} value={mapping.alarmNormalLevel ? '1' : '0'} onChange={(e) => update({ alarmNormalLevel: e.target.value === '1' })} style={inputStyle}><option value="0">0 · NO 常见</option><option value="1">1 · NC 常见</option></select>
                <input disabled={controlDisabled} value={mapping.faultInputAddress} placeholder="如 X2" onChange={(e) => update({ faultInputAddress: e.target.value })} style={inputStyle} />
                <select disabled={controlDisabled} value={mapping.faultNormalLevel ? '1' : '0'} onChange={(e) => update({ faultNormalLevel: e.target.value === '1' })} style={inputStyle}><option value="0">0 · NO 常见</option><option value="1">1 · NC 常见</option></select>
              </div>;
            })}
            <p style={{ color: palette.dim, fontSize: 10.5, margin: '9px 0 0', lineHeight: 1.6 }}>请输入 DIO 通道 X1～X64。具体型号启用继电器测试后，DIO 参数或 12 路反馈映射不完整会明确记录为继电器预检失败，绝不会误判为合格。</p>
          </section>

          <section style={{ border: `1px solid ${palette.borderSoft}`, background: 'rgba(4,19,31,.55)', padding: 14 }}>
            <b style={{ color: palette.title, fontSize: 13 }}>自动生产检验记录配置</b>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.45fr 1fr .65fr', gap: 8, marginTop: 11 }}>
              <label style={labelStyle}>检验员<input disabled={locked} value={recordConfig.inspector} placeholder="请输入检验员" onChange={(e) => setRecordConfig({ ...recordConfig, inspector: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>检验标准<input disabled={locked} value={recordConfig.standard} onChange={(e) => setRecordConfig({ ...recordConfig, standard: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>表单编号<input disabled={locked} value={recordConfig.formNumber} onChange={(e) => setRecordConfig({ ...recordConfig, formNumber: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>版本<input disabled={locked} value={recordConfig.formVersion} onChange={(e) => setRecordConfig({ ...recordConfig, formVersion: e.target.value })} style={inputStyle} /></label>
            </div>
            <p style={{ color: palette.dim, fontSize: 10.5, margin: '9px 0 0', lineHeight: 1.6 }}>本配置在正式批次启动时冻结；完成后自动保存结构化 JSON、完整原始归档、打印 HTML 与 Word 兼容 `.doc`，正式记录同时进入 MQTT 可靠上传队列。</p>
          </section>

          <section style={{ border: `1px solid ${palette.borderSoft}`, background: 'rgba(4,19,31,.55)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div><b style={{ color: palette.title, fontSize: 13 }}>最近生产检验记录</b><div style={{ marginTop: 3, color: palette.dim, fontSize: 10 }}>最近 20 批 · 自动归档 · 可查看打印或导出 Word</div></div>
              <button type="button" disabled={recordsLoading} onClick={() => void loadRecords()} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, padding: '6px 9px', cursor: recordsLoading ? 'wait' : 'pointer', opacity: recordsLoading ? .5 : 1, font: 'inherit', fontSize: 10 }}><RefreshCw size={12} />刷新</button>
            </div>
            <div style={{ marginTop: 10, borderTop: `1px solid ${palette.borderSoft}` }}>
              {recordsLoading && <div style={{ padding: '12px 6px', color: palette.cyan, fontSize: 10.5 }}>正在读取记录…</div>}
              {!recordsLoading && records.length === 0 && <div style={{ padding: '12px 6px', color: palette.dim, fontSize: 10.5 }}>暂无已完成生产批次。完成正式流程后会自动出现在这里。</div>}
              {!recordsLoading && records.map((record) => <div key={record.batchId} style={{ display: 'grid', gridTemplateColumns: '1.15fr 1.45fr .7fr auto', gap: 9, alignItems: 'center', minHeight: 38, padding: '6px', borderBottom: `1px solid ${palette.borderSoft}`, fontSize: 10.5 }}>
                <div><b style={{ color: palette.title }}>{record.productModel || '型号未记录'}</b><div style={{ marginTop: 2, color: palette.dim, font: '9px Consolas, monospace' }}>{record.batchId}</div></div>
                <span style={{ color: palette.muted }}>{recordTime(record.generatedAt)}</span>
                <b style={{ color: record.conclusion === '合格' ? palette.pass : palette.fail }}>{record.conclusion}</b>
                <div style={{ display: 'flex', gap: 5 }}>
                  <button type="button" onClick={() => openRecord(record.batchId)} title="查看/打印记录" style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.cyan, cursor: 'pointer' }}><ExternalLink size={12} /></button>
                  <a href={`${backendHttpUrl}/api/production-records/${encodeURIComponent(record.batchId)}/doc`} title="导出 Word 兼容记录" style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, textDecoration: 'none' }}><Download size={12} /></a>
                </div>
              </div>)}
            </div>
          </section>

          {message && <div style={{ padding: '8px 10px', border: `1px solid ${messageIsSuccess ? 'rgba(98,231,182,.28)' : 'rgba(242,119,105,.28)'}`, color: messageIsSuccess ? palette.pass : palette.fail, background: 'rgba(6,23,34,.72)', fontSize: 10.5 }}>{message}</div>}

          <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ color: locked ? palette.warn : palette.dim, fontSize: 10 }}>{locked ? '流程运行期间为只读模式，历史记录仍可查看/导出。' : mappingsComplete ? '12 路反馈通道已填写；保存后由后台重新校验。' : `仍有 ${12 - inputCount} 路反馈通道未填写。`}</span>
            <div style={{ display: 'flex', gap: 7 }}>
              <button type="button" onClick={() => void openLatestRecord()} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, padding: '7px 11px', cursor: 'pointer', font: 'inherit', fontSize: 10.5 }}><FileText size={13} />最新记录</button>
              <button type="button" disabled={saving || locked || !relay || !recordConfig} onClick={() => void save()} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${palette.cyan}`, background: palette.cyan, color: '#06202b', padding: '7px 12px', cursor: saving || locked ? 'not-allowed' : 'pointer', opacity: saving || locked ? .5 : 1, font: 'inherit', fontSize: 10.5, fontWeight: 700 }}><Save size={13} />{saving ? '保存中…' : '保存并应用'}</button>
            </div>
          </footer>
        </div>}

        {!loading && (!relay || !recordConfig) && <div style={{ padding: 28 }}>
          <div style={{ color: palette.fail, fontSize: 12 }}>{message || '生产配置未能完整加载'}</div>
          <button type="button" onClick={() => void load()} style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, padding: '7px 11px', cursor: 'pointer' }}><RefreshCw size={13} />重试</button>
        </div>}
      </section>;
}
