import { useEffect, useMemo, useState } from 'react';
import { Settings2, ShieldCheck, X } from 'lucide-react';
import {
  PRODUCT_TYPE_ORDER,
  formatSoftwareVersion,
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
  type ProductType,
} from '../server/src/product-profile';

interface Props {
  config: ProductDetectionConfig | null;
  locked: boolean;
  precheck: ProductPrecheckReport | null;
  busy: boolean;
  onUpdate: (patch: Partial<ProductDetectionConfig> | ProductDetectionConfig) => Promise<void>;
}

function statusText(precheck: ProductPrecheckReport | null, busy: boolean): string {
  if (busy || precheck?.verdict === 'PENDING') return '产品预检中';
  if (precheck?.verdict === 'PASS') return '产品预检通过';
  if (precheck?.verdict === 'FAIL') return '产品预检异常';
  return '等待检测位 1 预检';
}

export function ProductTypeControl({ config, locked, precheck, busy, onUpdate }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<ProductDetectionConfig | null>(config);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { if (config) setDraft(JSON.parse(JSON.stringify(config)) as ProductDetectionConfig); }, [config]);

  const profile = useMemo(() => config ? selectedProductProfile(config) : null, [config]);
  const failed = precheck?.units.filter((unit) => unit.verdict === 'FAIL').length ?? 0;
  const precheckTone = precheck?.verdict === 'FAIL' ? '#ff6b73' : precheck?.verdict === 'PASS' ? '#62e5a9' : '#f4cf68';

  const updateSelectedType = async (selectedType: ProductType) => {
    if (locked || !config) return;
    setMessage('');
    try {
      await onUpdate({ selectedType });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const saveProfiles = async () => {
    if (!draft || locked) return;
    setSaving(true);
    setMessage('');
    try {
      await onUpdate(draft);
      setSettingsOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <>
    <section style={{
      position: 'fixed',
      zIndex: 80,
      top: 86,
      right: 28,
      width: 330,
      padding: '12px 14px',
      border: '1px solid rgba(74,214,232,.38)',
      borderRadius: 10,
      background: 'rgba(3,22,34,.94)',
      boxShadow: '0 10px 32px rgba(0,0,0,.28)',
      color: '#d7f4f7',
      fontFamily: 'Microsoft YaHei UI, sans-serif',
      backdropFilter: 'blur(10px)',
    }} aria-label="产品类型选择">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div><small style={{ color: '#69b9c4', letterSpacing: 1 }}>PRODUCT PROFILE</small><div style={{ fontWeight: 700 }}>产品类型</div></div>
        <button type="button" onClick={() => setSettingsOpen(true)} disabled={locked} title={locked ? '流程运行中不可修改产品配置' : '产品检测配置'} style={{ border: '1px solid rgba(104,214,225,.3)', background: '#082d3b', color: '#bcecf1', borderRadius: 7, padding: '6px 8px', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? .55 : 1 }}><Settings2 size={15} /></button>
      </div>
      <select value={config?.selectedType ?? 'THREE_WAVELENGTH'} disabled={!config || locked} onChange={(event) => void updateSelectedType(event.target.value as ProductType)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 7, border: '1px solid rgba(93,210,224,.35)', background: '#061c28', color: '#e2fbff', fontWeight: 700 }}>
        {PRODUCT_TYPE_ORDER.map((type) => <option value={type} key={type}>{config?.profiles[type]?.label ?? type}</option>)}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 9, fontSize: 12 }}>
        <span style={{ color: '#84aeb5' }}>期望版本 <b style={{ color: '#e8f8fa' }}>{profile?.expectedSoftwareVersion ? formatSoftwareVersion(profile.expectedSoftwareVersion) : '未配置'}</b></span>
        <span style={{ color: '#84aeb5' }}>期望探头 <b style={{ color: '#e8f8fa' }}>{profile?.expectedProbeCount ?? '-'} 路</b></span>
        <span style={{ color: '#84aeb5' }}>批次状态 <b style={{ color: locked ? '#f4cf68' : '#62e5a9' }}>{locked ? '已锁定' : '可选择'}</b></span>
        <span style={{ color: '#84aeb5' }}>预检 <b style={{ color: precheckTone }}>{statusText(precheck, busy)}</b></span>
      </div>
      {precheck && <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(105,191,202,.18)', color: '#9cc4ca', fontSize: 11 }}>
        实际检查 {precheck.units.length} 台 · {failed ? `${failed} 台异常` : precheck.verdict === 'PASS' ? '版本/探头数一致' : '等待结果'}
      </div>}
      {message && <div style={{ marginTop: 7, color: '#ff8088', fontSize: 11 }}>{message}</div>}
    </section>

    {settingsOpen && draft && <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,7,12,.72)', display: 'grid', placeItems: 'center' }} role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="product-settings-title" style={{ width: 'min(760px, calc(100vw - 32px))', maxHeight: '82vh', overflow: 'auto', border: '1px solid rgba(72,218,230,.42)', borderRadius: 12, background: '#061a26', color: '#dff6f8', boxShadow: '0 24px 80px rgba(0,0,0,.45)' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: '1px solid rgba(90,196,210,.18)' }}>
          <div><small style={{ color: '#55c6d3' }}>PRODUCT DETECTION CONFIG</small><h2 id="product-settings-title" style={{ margin: '4px 0 0' }}>产品检测配置</h2></div>
          <button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭" style={{ border: 0, background: 'transparent', color: '#c7eef2', cursor: 'pointer' }}><X /></button>
        </header>
        <div style={{ padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.5fr .8fr', gap: 10, color: '#76aab2', fontSize: 12, padding: '0 8px 7px' }}><b>产品类型</b><b>期望软件版本</b><b>期望探头数</b></div>
          {PRODUCT_TYPE_ORDER.map((type) => {
            const item = draft.profiles[type];
            return <div key={type} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.5fr .8fr', gap: 10, alignItems: 'center', padding: 8, marginBottom: 7, borderRadius: 8, background: 'rgba(9,45,58,.62)' }}>
              <strong>{item.label}</strong>
              <input value={item.expectedSoftwareVersion} placeholder="例如 01.02.03.04" onChange={(event) => setDraft({ ...draft, profiles: { ...draft.profiles, [type]: { ...item, expectedSoftwareVersion: event.target.value } } })} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(87,189,202,.32)', borderRadius: 6, background: '#04131d', color: '#e7fbfd', padding: '8px 9px' }} />
              <input type="number" min={1} max={4} value={item.expectedProbeCount} disabled={type !== 'IMAGE_DETECTOR'} onChange={(event) => setDraft({ ...draft, profiles: { ...draft.profiles, [type]: { ...item, expectedProbeCount: Number(event.target.value) } } })} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(87,189,202,.32)', borderRadius: 6, background: type === 'IMAGE_DETECTOR' ? '#04131d' : '#10222a', color: '#e7fbfd', padding: '8px 9px' }} />
            </div>;
          })}
          <p style={{ color: '#83adb4', fontSize: 12, lineHeight: 1.7 }}><ShieldCheck size={14} style={{ verticalAlign: -2, marginRight: 5 }} />版本比较会自动忽略点号、横线和 0x 前缀。双/三/四波长探头数固定为 2/3/4；图探型当前默认 3 路，可按实际协议调整。</p>
          {message && <p style={{ color: '#ff8088', fontSize: 12 }}>{message}</p>}
        </div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, padding: '14px 20px 18px', borderTop: '1px solid rgba(90,196,210,.18)' }}>
          <button type="button" onClick={() => setSettingsOpen(false)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid rgba(101,183,194,.32)', background: '#0a2733', color: '#d2eff2', cursor: 'pointer' }}>取消</button>
          <button type="button" onClick={() => void saveProfiles()} disabled={saving || locked} style={{ padding: '8px 16px', borderRadius: 7, border: 0, background: '#1b8797', color: '#fff', cursor: saving || locked ? 'not-allowed' : 'pointer', opacity: saving || locked ? .6 : 1 }}>{saving ? '保存中…' : '保存产品配置'}</button>
        </footer>
      </section>
    </div>}
  </>;
}
