import { useCallback, useEffect, useState } from 'react';
import { FileText, Settings2, X } from 'lucide-react';
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

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  border: '1px solid rgba(87,189,202,.32)',
  borderRadius: 6,
  background: '#04131d',
  color: '#e7fbfd',
  padding: '8px 9px',
};

export function ProductionConfigurationPanel({ backendHttpUrl, locked }: Props) {
  const [open, setOpen] = useState(false);
  const [relay, setRelay] = useState<RelayPayload | null>(null);
  const [recordConfig, setRecordConfig] = useState<ProductionInspectionRecordConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [relayResponse, recordResponse] = await Promise.all([
      fetch(`${backendHttpUrl}/api/relay-functional-test-config`),
      fetch(`${backendHttpUrl}/api/production-inspection-config`),
    ]);
    if (relayResponse.ok) setRelay(await relayResponse.json() as RelayPayload);
    if (recordResponse.ok) {
      const payload = await recordResponse.json() as { config: ProductionInspectionRecordConfig };
      setRecordConfig(payload.config);
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
      setMessage('配置已保存并立即应用。');
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
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return <>
    <div style={{ position: 'fixed', right: 28, bottom: 24, zIndex: 85, display: 'flex', gap: 8 }}>
      <button type="button" onClick={() => void openLatestRecord()} title="查看最新自动生产检验记录" style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid rgba(74,214,232,.35)', borderRadius: 8, background: 'rgba(5,35,48,.94)', color: '#c9f3f7', padding: '8px 10px', cursor: 'pointer' }}><FileText size={15} />检验记录</button>
      <button type="button" onClick={() => setOpen(true)} disabled={locked} title={locked ? '流程运行中不可修改生产配置' : '继电器DI与生产记录配置'} style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid rgba(74,214,232,.35)', borderRadius: 8, background: 'rgba(5,35,48,.94)', color: '#c9f3f7', padding: '8px 10px', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? .55 : 1 }}><Settings2 size={15} />生产配置</button>
    </div>

    {open && relay && recordConfig && <div style={{ position: 'fixed', inset: 0, zIndex: 230, background: 'rgba(0,7,12,.76)', display: 'grid', placeItems: 'center' }} role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="production-config-title" style={{ width: 'min(1080px, calc(100vw - 32px))', maxHeight: '90vh', overflow: 'auto', border: '1px solid rgba(72,218,230,.42)', borderRadius: 12, background: '#061a26', color: '#dff6f8', boxShadow: '0 24px 80px rgba(0,0,0,.45)' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: '1px solid rgba(90,196,210,.18)' }}>
          <div><small style={{ color: '#55c6d3' }}>PRODUCTION / RELAY CONFIG</small><h2 id="production-config-title" style={{ margin: '4px 0 0' }}>生产检验与继电器反馈配置</h2></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭" style={{ border: 0, background: 'transparent', color: '#c7eef2', cursor: 'pointer' }}><X /></button>
        </header>

        <div style={{ padding: 20, display: 'grid', gap: 20 }}>
          <section style={{ border: '1px solid rgba(90,196,210,.18)', borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div><b>继电器功能测试</b><div style={{ color: '#86aeb4', fontSize: 11, marginTop: 3 }}>生产 FAST_BATCH：六台并行火警 → 复位 → 六台并行故障 → 复位</div></div>
              <div style={{ color: relay.ready ? '#62e5a9' : '#f4cf68', fontSize: 12 }}>{relay.ready ? '12路反馈映射完整' : `尚缺 ${relay.missingMappings.length} 路映射`}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>设备级总开关<select value={relay.config.enabled ? '1' : '0'} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, enabled: e.target.value === '1' } })} style={inputStyle}><option value="0">关闭</option><option value="1">启用</option></select></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>模式<select value={relay.config.mode} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, mode: e.target.value as RelayFunctionalTestConfig['mode'] } })} style={inputStyle}><option value="FAST_BATCH">FAST_BATCH</option><option value="DIAGNOSTIC">DIAGNOSTIC</option></select></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>动作超时 ms<input type="number" value={relay.config.feedbackTimeoutMs} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, feedbackTimeoutMs: Number(e.target.value) } })} style={inputStyle} /></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>复位超时 ms<input type="number" value={relay.config.resetTimeoutMs} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, resetTimeoutMs: Number(e.target.value) } })} style={inputStyle} /></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>稳定采样次数<input type="number" min={1} max={10} value={relay.config.stableSamples} onChange={(e) => setRelay({ ...relay, config: { ...relay.config, stableSamples: Number(e.target.value) } })} style={inputStyle} /></label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '.55fr 1fr .9fr 1fr .9fr', gap: 8, color: '#76aab2', fontSize: 11, padding: '0 6px 6px' }}><b>槽位</b><b>Alarm DI</b><b>Alarm正常电平</b><b>Fault DI</b><b>Fault正常电平</b></div>
            {relay.config.mappings.map((mapping, row) => {
              const update = (patch: Partial<typeof mapping>) => {
                const mappings = relay.config.mappings.map((item, index) => index === row ? { ...item, ...patch } : item);
                setRelay({ ...relay, config: { ...relay.config, mappings } });
              };
              return <div key={mapping.detectorIndex} style={{ display: 'grid', gridTemplateColumns: '.55fr 1fr .9fr 1fr .9fr', gap: 8, alignItems: 'center', marginBottom: 7 }}>
                <b>D{mapping.detectorIndex}</b>
                <input value={mapping.alarmInputAddress} placeholder="例如 I2.0" onChange={(e) => update({ alarmInputAddress: e.target.value })} style={inputStyle} />
                <select value={mapping.alarmNormalLevel ? '1' : '0'} onChange={(e) => update({ alarmNormalLevel: e.target.value === '1' })} style={inputStyle}><option value="0">0（NO常见）</option><option value="1">1（NC常见）</option></select>
                <input value={mapping.faultInputAddress} placeholder="例如 I2.1" onChange={(e) => update({ faultInputAddress: e.target.value })} style={inputStyle} />
                <select value={mapping.faultNormalLevel ? '1' : '0'} onChange={(e) => update({ faultNormalLevel: e.target.value === '1' })} style={inputStyle}><option value="0">0（NO常见）</option><option value="1">1（NC常见）</option></select>
              </div>;
            })}
            <p style={{ color: '#89abb1', fontSize: 11, margin: '9px 0 0' }}>地址为空时不会猜测 EM DE16 地址；若具体产品型号已启用继电器测试但对应 DI 尚未配置，该批次继电器预检会明确失败而不会误判合格。</p>
          </section>

          <section style={{ border: '1px solid rgba(90,196,210,.18)', borderRadius: 10, padding: 14 }}>
            <b>自动生产检验记录</b>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr .7fr', gap: 10, marginTop: 12 }}>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>检验员<input value={recordConfig.inspector} placeholder="请输入检验员" onChange={(e) => setRecordConfig({ ...recordConfig, inspector: e.target.value })} style={inputStyle} /></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>检验标准<input value={recordConfig.standard} onChange={(e) => setRecordConfig({ ...recordConfig, standard: e.target.value })} style={inputStyle} /></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>表单编号<input value={recordConfig.formNumber} onChange={(e) => setRecordConfig({ ...recordConfig, formNumber: e.target.value })} style={inputStyle} /></label>
              <label style={{ display: 'grid', gap: 5, fontSize: 11 }}>版本<input value={recordConfig.formVersion} onChange={(e) => setRecordConfig({ ...recordConfig, formVersion: e.target.value })} style={inputStyle} /></label>
            </div>
            <p style={{ color: '#89abb1', fontSize: 11, margin: '9px 0 0' }}>配置在批次启动时锁定；完成后自动生成结构化 JSON、完整原始归档和可直接打印的 HTML 检验记录。</p>
          </section>

          {message && <div style={{ color: message.includes('已保存') ? '#62e5a9' : '#ff858c', fontSize: 12 }}>{message}</div>}
          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
            <button type="button" onClick={() => setOpen(false)} style={{ border: '1px solid rgba(110,190,200,.3)', background: '#0b2834', color: '#c9e9ec', borderRadius: 7, padding: '8px 14px', cursor: 'pointer' }}>关闭</button>
            <button type="button" disabled={saving || locked} onClick={() => void save()} style={{ border: '1px solid rgba(81,225,179,.4)', background: '#0b493d', color: '#bdf7db', borderRadius: 7, padding: '8px 16px', cursor: saving || locked ? 'not-allowed' : 'pointer', opacity: saving || locked ? .6 : 1 }}>{saving ? '保存中...' : '保存并应用'}</button>
          </footer>
        </div>
      </section>
    </div>}
  </>;
}
