import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, RefreshCw, Save, Settings2, X } from 'lucide-react';
import type { RelayFunctionalTestConfig } from '../server/src/relay-functional-test';
import type { ProductionInspectionRecordConfig } from '../server/src/production-inspection-record';

interface Props {
  backendHttpUrl: string;
  locked: boolean;
}

interface RelayPayload {
  config: RelayFunctionalTestConfig;
  missingMappings: string[];
  ready: boolean;
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
    + (mapping.alarmInputAddress?.trim() ? 1 : 0)
    + (mapping.faultInputAddress?.trim() ? 1 : 0)
  ), 0);
}

export function ProductionConfigurationPanel({ backendHttpUrl, locked }: Props) {
  const [open, setOpen] = useState(false);
  const [relay, setRelay] = useState<RelayPayload | null>(null);
  const [recordConfig, setRecordConfig] = useState<ProductionInspectionRecordConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const inputCount = useMemo(() => configuredInputCount(relay), [relay]);
  const mappingsComplete = inputCount === 12;

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const [relayResponse, recordResponse] = await Promise.all([
        fetch(`${backendHttpUrl}/api/relay-functional-test-config`),
        fetch(`${backendHttpUrl}/api/production-inspection-config`),
      ]);
      if (!relayResponse.ok) throw new Error(`继电器配置读取失败 (${relayResponse.status})`);
      if (!recordResponse.ok) throw new Error(`检验记录配置读取失败 (${recordResponse.status})`);
      const relayPayload = await relayResponse.json() as RelayPayload;
      const recordPayload = await recordResponse.json() as { config: ProductionInspectionRecordConfig };
      setRelay(relayPayload);
      setRecordConfig(recordPayload.config);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [backendHttpUrl]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const save = async () => {
    if (!relay || !recordConfig || locked) return;
    setSaving(true);
    setMessage('');
    try {
      const relayResponse = await fetch(`${backendHttpUrl}/api/relay-functional-test-config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(relay.config),
      });
      const relayResult = await relayResponse.json() as RelayPayload & { success?: boolean; code?: string; error?: string };
      if (!relayResponse.ok || !relayResult.success) throw new Error(relayResult.error || relayResult.code || '继电器配置保存失败');

      const recordResponse = await fetch(`${backendHttpUrl}/api/production-inspection-config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recordConfig),
      });
      const recordResult = await recordResponse.json() as { success?: boolean; config?: ProductionInspectionRecordConfig; code?: string; error?: string };
      if (!recordResponse.ok || !recordResult.success || !recordResult.config) throw new Error(recordResult.error || recordResult.code || '检验记录配置保存失败');

      setRelay({ config: relayResult.config, missingMappings: relayResult.missingMappings, ready: relayResult.ready });
      setRecordConfig(recordResult.config);
      setMessage('配置已保存并立即应用');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const openLatestRecord = async () => {
    setMessage('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-records/latest`);
      if (!response.ok) throw new Error('尚无已完成的生产检验记录');
      const record = await response.json() as { batchId: string };
      window.open(`${backendHttpUrl}/api/production-records/${encodeURIComponent(record.batchId)}/html`, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setOpen(true);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const controlDisabled = locked || loading || !relay;

  return <>
    <div style={{ position: 'fixed', right: 28, bottom: 24, zIndex: 85, display: 'flex', gap: 7 }}>
      <button type="button" onClick={() => void openLatestRecord()} title="查看最新自动生产检验记录" style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${palette.borderSoft}`, background: 'rgba(6,27,43,.96)', color: palette.text, padding: '7px 10px', cursor: 'pointer', font: 'inherit', fontSize: 10.5 }}><FileText size={14} />检验记录</button>
      <button type="button" onClick={() => setOpen(true)} title={locked ? '流程运行中可查看，禁止修改' : '继电器 DI 与生产记录配置'} style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${palette.borderSoft}`, background: 'rgba(6,27,43,.96)', color: locked ? palette.warn : palette.text, padding: '7px 10px', cursor: 'pointer', font: 'inherit', fontSize: 10.5 }}><Settings2 size={14} />生产配置{locked ? ' · 只读' : ''}</button>
    </div>

    {open && <div style={{ position: 'fixed', inset: 0, zIndex: 230, padding: 16, background: 'rgba(2,8,16,.84)', display: 'grid', placeItems: 'center' }} role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="production-config-title" style={{ width: 'min(1120px, 100%)', maxHeight: '92vh', overflow: 'auto', border: `1px solid ${palette.border}`, background: `linear-gradient(145deg,${palette.panelTop},${palette.panelBottom})`, color: palette.text, boxShadow: '0 24px 80px rgba(0,0,0,.48), inset 0 0 24px rgba(32,204,229,.05)' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 18px', borderBottom: `1px solid ${palette.borderSoft}` }}>
          <div>
            <small style={{ color: palette.cyan, font: '700 10px Consolas, monospace', letterSpacing: '.16em' }}>PRODUCTION CONFIG</small>
            <h2 id="production-config-title" style={{ margin: '4px 0 0', color: palette.title, fontSize: 18 }}>生产检验与继电器反馈配置</h2>
            <div style={{ marginTop: 5, color: locked ? palette.warn : palette.dim, fontSize: 10.5 }}>{locked ? '当前流程运行中：允许查看，所有修改控件保持只读' : '配置保存后永久生效；正式批次启动时锁定本批次配置'}</div>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button type="button" onClick={() => void load()} disabled={loading} title="重新读取后台配置" style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.cyan, cursor: loading ? 'wait' : 'pointer', opacity: loading ? .5 : 1 }}><RefreshCw size={14} /></button>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭" style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, cursor: 'pointer' }}><X size={15} /></button>
          </div>
        </header>

        {loading && <div style={{ padding: 28, color: palette.cyan, fontSize: 12 }}>正在读取生产配置…</div>}

        {!loading && relay && recordConfig && <div style={{ padding: 18, display: 'grid', gap: 14 }}>
          <section style={{ border: `1px solid ${palette.borderSoft}`, background: 'rgba(4,19,31,.55)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div>
                <b style={{ color: palette.title, fontSize: 13 }}>继电器功能测试</b>
                <div style={{ color: palette.muted, fontSize: 10.5, marginTop: 3 }}>FAST_BATCH：6 台并行火警 → 复位 → 6 台并行故障 → 复位；不会使用火警+故障联合激励。</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 10.5 }}>
                <b style={{ color: mappingsComplete ? palette.pass : palette.warn }}>PLC DI {inputCount}/12</b>
                <div style={{ marginTop: 2, color: relay.config.enabled ? (mappingsComplete ? palette.pass : palette.warn) : palette.dim }}>{relay.config.enabled ? (mappingsComplete ? '设备级测试已具备映射条件' : '总开关已开，但映射未完整') : '设备级总开关关闭'}</div>
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

            <div style={{ display: 'grid', gridTemplateColumns: '.5fr 1fr .9fr 1fr .9fr', gap: 7, color: palette.muted, fontSize: 10.5, padding: '0 6px 6px' }}><b>槽位</b><b>Alarm DI</b><b>Alarm 正常态</b><b>Fault DI</b><b>Fault 正常态</b></div>
            {relay.config.mappings.map((mapping, row) => {
              const update = (patch: Partial<typeof mapping>) => {
                const mappings = relay.config.mappings.map((item, index) => index === row ? { ...item, ...patch } : item);
                setRelay({ ...relay, config: { ...relay.config, mappings } });
              };
              const rowReady = Boolean(mapping.alarmInputAddress?.trim() && mapping.faultInputAddress?.trim());
              return <div key={mapping.detectorIndex} style={{ display: 'grid', gridTemplateColumns: '.5fr 1fr .9fr 1fr .9fr', gap: 7, alignItems: 'center', marginBottom: 6, padding: '5px 6px', border: `1px solid ${rowReady ? 'rgba(98,231,182,.18)' : 'rgba(226,195,99,.16)'}`, background: 'rgba(6,23,34,.72)' }}>
                <b style={{ color: rowReady ? palette.pass : palette.warn }}>D{mapping.detectorIndex}</b>
                <input disabled={controlDisabled} value={mapping.alarmInputAddress} placeholder="未配置" onChange={(e) => update({ alarmInputAddress: e.target.value })} style={inputStyle} />
                <select disabled={controlDisabled} value={mapping.alarmNormalLevel ? '1' : '0'} onChange={(e) => update({ alarmNormalLevel: e.target.value === '1' })} style={inputStyle}><option value="0">0 · NO 常见</option><option value="1">1 · NC 常见</option></select>
                <input disabled={controlDisabled} value={mapping.faultInputAddress} placeholder="未配置" onChange={(e) => update({ faultInputAddress: e.target.value })} style={inputStyle} />
                <select disabled={controlDisabled} value={mapping.faultNormalLevel ? '1' : '0'} onChange={(e) => update({ faultNormalLevel: e.target.value === '1' })} style={inputStyle}><option value="0">0 · NO 常见</option><option value="1">1 · NC 常见</option></select>
              </div>;
            })}
            <p style={{ color: palette.dim, fontSize: 10.5, margin: '9px 0 0', lineHeight: 1.6 }}>EM DE16 的实际 I 地址未确定前保持空即可，软件不会猜地址。具体型号启用继电器测试后，12 路映射不完整会明确记录为继电器预检失败，绝不会误判为合格。</p>
          </section>

          <section style={{ border: `1px solid ${palette.borderSoft}`, background: 'rgba(4,19,31,.55)', padding: 14 }}>
            <b style={{ color: palette.title, fontSize: 13 }}>自动生产检验记录</b>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.45fr 1fr .65fr', gap: 8, marginTop: 11 }}>
              <label style={labelStyle}>检验员<input disabled={locked} value={recordConfig.inspector} placeholder="请输入检验员" onChange={(e) => setRecordConfig({ ...recordConfig, inspector: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>检验标准<input disabled={locked} value={recordConfig.standard} onChange={(e) => setRecordConfig({ ...recordConfig, standard: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>表单编号<input disabled={locked} value={recordConfig.formNumber} onChange={(e) => setRecordConfig({ ...recordConfig, formNumber: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>版本<input disabled={locked} value={recordConfig.formVersion} onChange={(e) => setRecordConfig({ ...recordConfig, formVersion: e.target.value })} style={inputStyle} /></label>
            </div>
            <p style={{ color: palette.dim, fontSize: 10.5, margin: '9px 0 0', lineHeight: 1.6 }}>本配置在正式批次启动时冻结；完成后自动保存结构化 JSON、完整原始归档、打印 HTML 与 Word 兼容 `.doc`，正式记录同时进入 MQTT 可靠上传队列。</p>
          </section>

          {message && <div style={{ padding: '8px 10px', border: `1px solid ${message.includes('已保存') ? 'rgba(98,231,182,.28)' : 'rgba(242,119,105,.28)'}`, color: message.includes('已保存') ? palette.pass : palette.fail, background: 'rgba(6,23,34,.72)', fontSize: 10.5 }}>{message}</div>}

          <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ color: locked ? palette.warn : palette.dim, fontSize: 10 }}>{locked ? '流程运行期间为只读模式，批次结束后可修改。' : mappingsComplete ? '12 路 DI 已填写；保存后由后台重新校验。' : `仍有 ${12 - inputCount} 路 DI 未填写。`}</span>
            <div style={{ display: 'flex', gap: 7 }}>
              <button type="button" onClick={() => void openLatestRecord()} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, padding: '7px 11px', cursor: 'pointer', font: 'inherit', fontSize: 10.5 }}><FileText size={13} />最新记录</button>
              <button type="button" onClick={() => setOpen(false)} style={{ border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, padding: '7px 11px', cursor: 'pointer', font: 'inherit', fontSize: 10.5 }}>关闭</button>
              <button type="button" disabled={saving || locked || !relay || !recordConfig} onClick={() => void save()} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${palette.cyan}`, background: palette.cyan, color: '#06202b', padding: '7px 12px', cursor: saving || locked ? 'not-allowed' : 'pointer', opacity: saving || locked ? .5 : 1, font: 'inherit', fontSize: 10.5, fontWeight: 700 }}><Save size={13} />{saving ? '保存中…' : '保存并应用'}</button>
            </div>
          </footer>
        </div>}

        {!loading && (!relay || !recordConfig) && <div style={{ padding: 28 }}>
          <div style={{ color: palette.fail, fontSize: 12 }}>{message || '生产配置未能完整加载'}</div>
          <button type="button" onClick={() => void load()} style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${palette.borderSoft}`, background: palette.field, color: palette.text, padding: '7px 11px', cursor: 'pointer' }}><RefreshCw size={13} />重试</button>
        </div>}
      </section>
    </div>}
  </>;
}
