import { useEffect, useMemo, useState } from 'react';
import { Settings2, ShieldCheck, X } from 'lucide-react';
import type { FieldDetectorBatchVerdict } from '../server/src/closure/field-detector-verdict';
import { productCodeRuleMissingFields } from '../server/src/product-code';
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
  detectorVerdict: FieldDetectorBatchVerdict | null;
  onUpdate: (patch: Partial<ProductDetectionConfig> | ProductDetectionConfig) => Promise<void>;
}

const PRECHECK_REASON_LABELS: Record<string, string> = {
  SOFTWARE_VERSION_NOT_CONFIGURED: '未配置版本基准',
  SOFTWARE_VERSION_MISMATCH: '软件版本不一致',
  PROBE_COUNT_MISMATCH: '探头数量不一致',
  DETECTOR_FAULT_AT_PRECHECK: '检测前设备故障',
  PRECHECK_READ_FAILED: '状态读取失败',
  SENSITIVITY_READ_FAILED: '灵敏度读取失败',
  RELAY_FUNCTIONAL_TEST_FAILED: '继电器功能测试失败',
};

const RELAY_REASON_LABELS: Record<string, string> = {
  ALARM_COMMAND_FAILED: '火警模拟指令失败',
  ALARM_INTERNAL_STATE_NOT_SET: '内部火警状态未成立',
  ALARM_RELAY_NOT_ACTUATED: '火警实体继电器未动作',
  ALARM_TRIGGERED_FAULT_RELAY: '火警阶段故障继电器误动作',
  ALARM_RESET_COMMAND_FAILED: '火警阶段复位指令失败',
  ALARM_RESET_INTERNAL_FAILED: '火警内部状态未复位',
  ALARM_RELAY_STUCK_AFTER_RESET: '火警继电器复位后未恢复',
  FAULT_COMMAND_FAILED: '故障模拟指令失败',
  FAULT_INTERNAL_STATE_NOT_SET: '内部故障状态未成立',
  FAULT_RELAY_NOT_ACTUATED: '故障实体继电器未动作',
  FAULT_TRIGGERED_ALARM_RELAY: '故障阶段火警继电器误动作',
  FAULT_RESET_COMMAND_FAILED: '故障阶段复位指令失败',
  FAULT_RESET_INTERNAL_FAILED: '故障内部状态未复位',
  FAULT_RELAY_STUCK_AFTER_RESET: '故障继电器复位后未恢复',
  RELAY_BASELINE_READ_FAILED: '继电器基线读取失败',
};

function statusText(precheck: ProductPrecheckReport | null, busy: boolean): string {
  if (busy || precheck?.verdict === 'PENDING') return '产品预检中';
  if (precheck?.verdict === 'PASS') return '产品预检通过';
  if (precheck?.verdict === 'FAIL') return '产品预检异常';
  return '等待检测位 1 预检';
}

function reasonText(reason: string): string {
  if (reason.startsWith('RELAY:')) {
    const raw = reason.slice('RELAY:'.length);
    const stripped = raw.replace(/^ALARM:/, '').replace(/^FAULT:/, '');
    if (raw.includes('RELAY_TEST_GLOBAL_DISABLED')) return '型号要求继电器测试，但设备级总开关未启用';
    if (raw.includes('RELAY_FEEDBACK_MAPPING_MISSING')) return '型号要求继电器测试，但 PLC DI 映射未完整配置';
    return RELAY_REASON_LABELS[stripped] ?? raw;
  }
  return PRECHECK_REASON_LABELS[reason] ?? reason;
}

function probeLabel(key: string): string {
  const index = Number(key.replace('probe', ''));
  return Number.isFinite(index) ? `P${index}` : key;
}

function allocationText(precheck: ProductPrecheckReport | null): { text: string; color: string } {
  const allocation = precheck?.productCodeAllocation;
  if (!allocation) return { text: '等待批次启动', color: '#9bb8bd' };
  if (allocation.status === 'GENERATED') {
    const codes = allocation.items.map((item) => item.productCode).filter(Boolean) as string[];
    return { text: codes.length === 6 ? `已预占 ${codes[0]} … ${codes[5]}` : '已生成产品编号', color: '#62e5a9' };
  }
  if (allocation.status === 'RULE_MISSING') return { text: '规则缺失 · 记录显示未生成', color: '#f4cf68' };
  if (allocation.status === 'DISABLED') return { text: '该型号关闭自动编号', color: '#9bb8bd' };
  return { text: '编号系统异常 · 不影响产品检测', color: '#ff9b75' };
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

export function ProductTypeControl({ config, locked, precheck, busy, detectorVerdict, onUpdate }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<ProductDetectionConfig | null>(config);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { if (config) setDraft(JSON.parse(JSON.stringify(config)) as ProductDetectionConfig); }, [config]);

  const profile = useMemo(() => config ? selectedProductProfile(config) : null, [config]);
  const failedUnits = precheck?.units.filter((unit) => unit.verdict === 'FAIL') ?? [];
  const noDataUnits = detectorVerdict?.units.filter((unit) => (unit.noDataProbes?.length ?? 0) > 0) ?? [];
  const precheckTone = precheck?.verdict === 'FAIL' ? '#ff6b73' : precheck?.verdict === 'PASS' ? '#62e5a9' : '#f4cf68';
  const codeMissing = profile ? productCodeRuleMissingFields(profile.productCodeRule) : [];
  const allocation = allocationText(precheck);
  const relayReport = precheck?.relayFunctionalTest;
  const relayText = !profile?.relayFunctionalTestEnabled
    ? '型号关闭'
    : !relayReport
      ? '等待执行'
      : relayReport.verdict === 'PASS' ? '通过' : relayReport.verdict === 'FAIL' ? '失败' : relayReport.verdict;
  const relayTone = !profile?.relayFunctionalTestEnabled ? '#9bb8bd' : relayReport?.verdict === 'PASS' ? '#62e5a9' : relayReport?.verdict === 'FAIL' ? '#ff6b73' : '#f4cf68';

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
      position: 'fixed', zIndex: 80, top: 86, right: 28, width: 350, padding: '12px 14px',
      border: '1px solid rgba(74,214,232,.38)', borderRadius: 10, background: 'rgba(3,22,34,.94)',
      boxShadow: '0 10px 32px rgba(0,0,0,.28)', color: '#d7f4f7', fontFamily: 'Microsoft YaHei UI, sans-serif', backdropFilter: 'blur(10px)',
    }} aria-label="产品类型选择">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div><small style={{ color: '#69b9c4', letterSpacing: 1 }}>PRODUCT PROFILE</small><div style={{ fontWeight: 700 }}>产品类型 / 型号</div></div>
        <button type="button" onClick={() => setSettingsOpen(true)} disabled={locked} title={locked ? '流程运行中不可修改产品配置' : '产品检测配置'} style={{ border: '1px solid rgba(104,214,225,.3)', background: '#082d3b', color: '#bcecf1', borderRadius: 7, padding: '6px 8px', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? .55 : 1 }}><Settings2 size={15} /></button>
      </div>
      <select value={config?.selectedType ?? 'THREE_WAVELENGTH'} disabled={!config || locked} onChange={(event) => void updateSelectedType(event.target.value as ProductType)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 7, border: '1px solid rgba(93,210,224,.35)', background: '#061c28', color: '#e2fbff', fontWeight: 700 }}>
        {PRODUCT_TYPE_ORDER.map((type) => <option value={type} key={type}>{config?.profiles[type]?.productModel || config?.profiles[type]?.label || type}</option>)}
      </select>
      <div style={{ marginTop: 7, color: '#b8dde1', fontSize: 12 }}>{profile?.label ?? '-'} · {profile?.productModel || '型号未配置'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 9, fontSize: 12 }}>
        <span style={{ color: '#84aeb5' }}>期望版本 <b style={{ color: '#e8f8fa' }}>{profile?.expectedSoftwareVersion ? formatSoftwareVersion(profile.expectedSoftwareVersion) : '未配置'}</b></span>
        <span style={{ color: '#84aeb5' }}>期望探头 <b style={{ color: '#e8f8fa' }}>{profile?.expectedProbeCount ?? '-'} 路</b></span>
        <span style={{ color: '#84aeb5' }}>继电器测试 <b style={{ color: relayTone }}>{relayText}</b></span>
        <span style={{ color: '#84aeb5' }}>编号规则 <b style={{ color: codeMissing.length ? '#f4cf68' : '#62e5a9' }}>{codeMissing.length ? '未完整配置' : '已配置'}</b></span>
        <span style={{ color: '#84aeb5' }}>批次状态 <b style={{ color: locked ? '#f4cf68' : '#62e5a9' }}>{locked ? '已锁定' : '可选择'}</b></span>
        <span style={{ color: '#84aeb5' }}>预检 <b style={{ color: precheckTone }}>{statusText(precheck, busy)}</b></span>
      </div>
      <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'rgba(10,47,59,.62)', color: allocation.color, fontSize: 11 }}>产品编号：{allocation.text}</div>
      {codeMissing.length > 0 && <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: 'rgba(132,70,10,.25)', color: '#ffd990', fontSize: 11 }}>编号规则缺失不影响正常检测；完成记录中的产品编号显示“未生成”。</div>}
      {precheck && <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(105,191,202,.18)', color: '#9cc4ca', fontSize: 11 }}>
        <div>实际检查 {precheck.units.length} 台 · {failedUnits.length ? `${failedUnits.length} 台异常` : precheck.verdict === 'PASS' ? '版本 / 探头 / 灵敏度预检通过' : '等待结果'}</div>
        {relayReport && <div style={{ marginTop: 4, color: relayTone }}>继电器：{relayReport.mode} · {relayText}</div>}
        {failedUnits.length > 0 && <div style={{ display: 'grid', gap: 5, marginTop: 7 }}>
          {failedUnits.slice(0, 6).map((unit) => <div key={unit.index} style={{ padding: '6px 7px', borderRadius: 6, background: 'rgba(115,22,31,.28)', border: '1px solid rgba(255,107,115,.18)', color: '#ffc0c4' }}>
            <b>探测器 {unit.index}</b> · {unit.reasons.map(reasonText).join(' / ')}
            <div style={{ marginTop: 2, color: '#bc9397' }}>
              版本 {unit.actualSoftwareVersion ?? '读取失败'} / {unit.expectedSoftwareVersion ? formatSoftwareVersion(unit.expectedSoftwareVersion) : '未配置'} · 探头 {unit.actualProbeCount ?? '-'}/{unit.expectedProbeCount} · 灵敏度 {unit.sensitivityLevel ?? '-'}
            </div>
          </div>)}
        </div>}
      </div>}
      {noDataUnits.length > 0 && <div style={{ marginTop: 8, padding: '7px 8px', borderRadius: 7, background: 'rgba(132,70,10,.28)', border: '1px solid rgba(245,188,76,.24)', color: '#ffd990', fontSize: 11 }}>
        <b>波形无数据异常</b>
        {noDataUnits.map((unit) => <div key={unit.index} style={{ marginTop: 3 }}>探测器 {unit.index}：{unit.noDataProbes?.map(probeLabel).join(' / ')} 无有效数据（高绝对值 / 低波动）</div>)}
      </div>}
      {message && <div style={{ marginTop: 7, color: '#ff8088', fontSize: 11 }}>{message}</div>}
    </section>

    {settingsOpen && draft && <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,7,12,.72)', display: 'grid', placeItems: 'center' }} role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="product-settings-title" style={{ width: 'min(1080px, calc(100vw - 32px))', maxHeight: '88vh', overflow: 'auto', border: '1px solid rgba(72,218,230,.42)', borderRadius: 12, background: '#061a26', color: '#dff6f8', boxShadow: '0 24px 80px rgba(0,0,0,.45)' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: '1px solid rgba(90,196,210,.18)' }}>
          <div><small style={{ color: '#55c6d3' }}>PRODUCT DETECTION CONFIG</small><h2 id="product-settings-title" style={{ margin: '4px 0 0' }}>产品检测与编号配置</h2></div>
          <button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭" style={{ border: 0, background: 'transparent', color: '#c7eef2', cursor: 'pointer' }}><X /></button>
        </header>
        <div style={{ padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1.25fr 1.25fr .65fr .75fr .65fr .65fr .65fr .65fr', gap: 8, color: '#76aab2', fontSize: 11, padding: '0 8px 7px' }}>
            <b>产品类型</b><b>产品型号</b><b>期望软件版本</b><b>探头数</b><b>继电器</b><b>ABCC</b><b>EE</b><b>FF</b><b>GG</b>
          </div>
          {PRODUCT_TYPE_ORDER.map((type) => {
            const item = draft.profiles[type];
            const missing = productCodeRuleMissingFields(item.productCodeRule);
            const updateItem = (patch: Partial<typeof item>) => setDraft({ ...draft, profiles: { ...draft.profiles, [type]: { ...item, ...patch } } });
            const updateCode = (patch: Partial<typeof item.productCodeRule>) => updateItem({ productCodeRule: { ...item.productCodeRule, ...patch } });
            return <div key={type} style={{ padding: 8, marginBottom: 8, borderRadius: 8, background: 'rgba(9,45,58,.62)', border: missing.length ? '1px solid rgba(245,188,76,.16)' : '1px solid transparent' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1.25fr 1.25fr .65fr .75fr .65fr .65fr .65fr .65fr', gap: 8, alignItems: 'center' }}>
                <strong>{item.label}</strong>
                <input value={item.productModel} placeholder="GHT-1050-02" onChange={(event) => updateItem({ productModel: event.target.value })} style={inputStyle} />
                <input value={item.expectedSoftwareVersion} placeholder="例如 01.02.03.04" onChange={(event) => updateItem({ expectedSoftwareVersion: event.target.value })} style={inputStyle} />
                <input type="number" min={1} max={4} value={item.expectedProbeCount} disabled={type !== 'IMAGE_DETECTOR'} onChange={(event) => updateItem({ expectedProbeCount: Number(event.target.value) })} style={{ ...inputStyle, background: type === 'IMAGE_DETECTOR' ? '#04131d' : '#10222a' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: item.relayFunctionalTestEnabled ? '#8af0bd' : '#a3bcc1', fontSize: 11 }}><input type="checkbox" checked={item.relayFunctionalTestEnabled} onChange={(event) => updateItem({ relayFunctionalTestEnabled: event.target.checked })} />启用</label>
                <input value={item.productCodeRule.productNameCode} maxLength={4} placeholder="4102" onChange={(event) => updateCode({ productNameCode: event.target.value })} style={inputStyle} />
                <input value={item.productCodeRule.softwareVersionCode} maxLength={2} placeholder="01" onChange={(event) => updateCode({ softwareVersionCode: event.target.value })} style={inputStyle} />
                <input value={item.productCodeRule.hardwareVersionCode} maxLength={2} placeholder="01" onChange={(event) => updateCode({ hardwareVersionCode: event.target.value })} style={inputStyle} />
                <input value={item.productCodeRule.producerCode} maxLength={2} placeholder="01" onChange={(event) => updateCode({ producerCode: event.target.value })} style={inputStyle} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 6, fontSize: 10.5, color: missing.length ? '#e9bf72' : '#76aeb6' }}>
                <span>{missing.length ? `编码规则未完整配置（${missing.join(', ')}），不影响检测流程` : '编码规则完整 · 流水号按产品型号独立、每月从 00001 重新开始'}</span>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={item.productCodeRule.enabled} onChange={(event) => updateCode({ enabled: event.target.checked })} />自动生成产品编号</label>
              </div>
            </div>;
          })}
          <p style={{ color: '#83adb4', fontSize: 12, lineHeight: 1.7 }}><ShieldCheck size={14} style={{ verticalAlign: -2, marginRight: 5 }} />版本比较会自动忽略点号、横线和 0x 前缀。双/三/四波长探头数固定为 2/3/4；图探型可按实际协议调整。EE/FF/GG 当前默认均为 01。编号规则缺失或编号存储异常都不会阻塞正常检测。</p>
          <p style={{ color: '#83adb4', fontSize: 12, lineHeight: 1.7 }}>继电器功能测试为产品型号级开关；关闭时生产记录中的火警动作、故障动作显示“合格”，后台保留 DEFAULT_PASS/RELAY_TEST_DISABLED。启用时还必须配置设备级总开关与 12 路 PLC DI 映射。</p>
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
