import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Save, Settings2, ShieldCheck } from 'lucide-react';
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

export interface ProductModelSelectorProps {
  config: ProductDetectionConfig | null;
  locked: boolean;
  busy: boolean;
  onUpdate: (patch: Partial<ProductDetectionConfig>) => Promise<void>;
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
  ALARM_RELAY_ACTIVE_AT_BASELINE: '测试开始前火警继电器已处于动作态',
  FAULT_COMMAND_FAILED: '故障模拟指令失败',
  FAULT_INTERNAL_STATE_NOT_SET: '内部故障状态未成立',
  FAULT_RELAY_NOT_ACTUATED: '故障实体继电器未动作',
  FAULT_TRIGGERED_ALARM_RELAY: '故障阶段火警继电器误动作',
  FAULT_RESET_COMMAND_FAILED: '故障模拟复位指令失败',
  FAULT_RESET_INTERNAL_FAILED: '故障内部状态未复位',
  FAULT_RELAY_STUCK_AFTER_RESET: '故障继电器复位后未恢复',
  FAULT_RELAY_ACTIVE_AT_BASELINE: '测试开始前故障继电器已处于动作态',
  RELAY_BASELINE_READ_FAILED: '继电器基线读取失败',
};

function statusText(precheck: ProductPrecheckReport | null, busy: boolean): string {
  if (busy || precheck?.verdict === 'PENDING') return '预检中';
  if (precheck?.verdict === 'PASS') return '预检通过';
  if (precheck?.verdict === 'FAIL') return '预检异常';
  return '等待预检';
}

function reasonText(reason: string): string {
  const namespacedRelayReason = reason.startsWith('RELAY:');
  const raw = namespacedRelayReason ? reason.slice('RELAY:'.length) : reason;
  const phaseStripped = raw.replace(/^(ALARM|FAULT):/, '');
  const isRelayReason = namespacedRelayReason
    || phaseStripped.startsWith('ALARM_')
    || phaseStripped.startsWith('FAULT_')
    || phaseStripped.startsWith('DIO_')
    || phaseStripped.startsWith('RELAY_');
  if (isRelayReason) {
    const stripped = phaseStripped;
    if (raw.includes('RELAY_TEST_GLOBAL_DISABLED')) return '型号要求继电器测试，但设备级总开关未启用';
    if (raw.includes('DIO_NOT_CONFIGURED')) return '型号要求继电器测试，但 DIO Modbus TCP 参数未完整配置';
    if (raw.includes('RELAY_FEEDBACK_MAPPING_MISSING')) return '型号要求继电器测试，但 DIO 反馈通道未完整配置';
    if (raw.includes('_DI_OUT_OF_RANGE')) return 'DIO 反馈通道超出当前输入数量范围';
    if (raw.startsWith('RELAY_FEEDBACK_READ_FAILED:')) return `DIO 反馈读取失败（${raw.slice('RELAY_FEEDBACK_READ_FAILED:'.length)}）`;
    return RELAY_REASON_LABELS[stripped] ?? RELAY_REASON_LABELS[raw] ?? raw;
  }
  return PRECHECK_REASON_LABELS[reason] ?? reason;
}

function relayActionText(verdict: string): string {
  if (verdict === 'PASS') return '通过';
  if (verdict === 'FAIL') return '失败';
  if (verdict === 'SKIPPED') return '跳过';
  return '等待';
}

function relayActionReasons(action: { reasons: string[] }): string[] {
  return [...new Set(action.reasons.map(reasonText))];
}

function probeLabel(key: string): string {
  const index = Number(key.replace('probe', ''));
  return Number.isFinite(index) ? `P${index}` : key;
}

function productModel(config: ProductDetectionConfig | null, type: ProductType): string {
  return config?.profiles?.[type]?.productModel?.trim() || '型号未配置';
}

function cloneConfig(config: ProductDetectionConfig): ProductDetectionConfig {
  return JSON.parse(JSON.stringify(config)) as ProductDetectionConfig;
}

export function shouldSyncProductDraft(
  draft: ProductDetectionConfig | null,
  lastSynced: ProductDetectionConfig | null,
  incoming: ProductDetectionConfig,
): boolean {
  if (!draft || !lastSynced) return true;
  const draftSnapshot = JSON.stringify(draft);
  return draftSnapshot === JSON.stringify(lastSynced) || draftSnapshot === JSON.stringify(incoming);
}

function allocationText(precheck: ProductPrecheckReport | null): { text: string; tone: 'muted' | 'pass' | 'warn' | 'fail' } {
  const allocation = precheck?.productCodeAllocation;
  if (!allocation) return { text: '等待批次启动', tone: 'muted' };
  if (allocation.status === 'GENERATED') {
    const codes = allocation.items.map((item) => item.productCode).filter(Boolean) as string[];
    return { text: codes.length === 6 ? `${codes[0]} … ${codes[5]}` : '已生成产品编号', tone: 'pass' };
  }
  if (allocation.status === 'RULE_MISSING') return { text: '规则缺失，记录显示未生成', tone: 'warn' };
  if (allocation.status === 'DISABLED') return { text: '该型号关闭自动编号', tone: 'muted' };
  return { text: '编号系统异常，不影响检测', tone: 'fail' };
}

const palette = {
  panelTop: 'rgba(8,37,55,.98)',
  panelBottom: 'rgba(4,19,31,.98)',
  border: 'rgba(28,207,225,.40)',
  borderSoft: 'rgba(43,114,130,.62)',
  text: '#ccecf5',
  title: '#f0fcff',
  muted: '#7fa9b4',
  dim: '#64818b',
  cyan: '#43dced',
  pass: '#62e7b6',
  warn: '#e2c363',
  fail: '#f27769',
  field: '#061722',
  fieldBorder: '#2b7282',
};

const fieldStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  minWidth: 0,
  padding: '7px 8px',
  color: palette.text,
  border: `1px solid ${palette.fieldBorder}`,
  background: palette.field,
  font: 'inherit',
  fontSize: 11,
  outline: 'none',
};

function toneColor(tone: 'muted' | 'pass' | 'warn' | 'fail'): string {
  if (tone === 'pass') return palette.pass;
  if (tone === 'warn') return palette.warn;
  if (tone === 'fail') return palette.fail;
  return palette.muted;
}

export function ProductModelSelector({ config, locked, busy, onUpdate }: ProductModelSelectorProps) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const selectedModel = config ? productModel(config, config.selectedType) : '配置未加载';

  const switchProductModel = async (selectedType: ProductType) => {
    if (!config || locked || busy || switching || selectedType === config.selectedType) return;
    setSwitching(true);
    setError('');
    try {
      await onUpdate({ selectedType });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSwitching(false);
    }
  };

  return <span className="wutos-result-model-control" title={error || (locked ? '流程运行中型号已锁定' : '选择本批次生产型号')}>
    <span className="wutos-result-model-control__label">产品型号</span>
    <select
      aria-label="当前产品型号"
      value={config?.selectedType ?? ''}
      disabled={!config || locked || busy || switching}
      onChange={(event) => void switchProductModel(event.target.value as ProductType)}
    >
      {!config && <option value="">{selectedModel}</option>}
      {config && PRODUCT_TYPE_ORDER.map((type) => <option value={type} key={type}>{productModel(config, type)} · {config.profiles[type]?.label ?? '类别未配置'}</option>)}
    </select>
    <span className={`wutos-result-model-control__state ${error ? 'is-error' : locked ? 'is-locked' : busy || switching ? 'is-busy' : ''}`}>
      {error ? '保存失败' : locked ? '已锁定' : busy || switching ? '保存中' : config ? '已同步' : '未连接'}
    </span>
  </span>;
}

export function ProductTypeControl({ config, locked, precheck, busy, detectorVerdict, onUpdate }: Props) {
  const [draft, setDraft] = useState<ProductDetectionConfig | null>(config ? cloneConfig(config) : null);
  const lastSyncedConfig = useRef<ProductDetectionConfig | null>(config ? cloneConfig(config) : null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!config) {
      lastSyncedConfig.current = null;
      setDraft(null);
      return;
    }
    const previousSynced = lastSyncedConfig.current;
    setDraft((current) => shouldSyncProductDraft(current, previousSynced, config) ? cloneConfig(config) : current);
    lastSyncedConfig.current = cloneConfig(config);
  }, [config]);

  const profile = useMemo(() => config ? selectedProductProfile(config) : null, [config]);
  const draftProfile = useMemo(() => draft ? selectedProductProfile(draft) : null, [draft]);
  const dirty = useMemo(() => Boolean(config && draft && JSON.stringify(config) !== JSON.stringify(draft)), [config, draft]);
  const failedUnits = precheck?.units.filter((unit) => unit.verdict === 'FAIL') ?? [];
  const noDataUnits = detectorVerdict?.units.filter((unit) => (unit.noDataProbes?.length ?? 0) > 0) ?? [];
  const savedCodeMissing = profile ? productCodeRuleMissingFields(profile.productCodeRule) : [];
  const draftCodeMissing = draftProfile ? productCodeRuleMissingFields(draftProfile.productCodeRule) : [];
  const allocation = allocationText(precheck);
  const relayReport = precheck?.relayFunctionalTest;
  const relayText = !profile?.relayFunctionalTestEnabled
    ? '关闭'
    : !relayReport
      ? '等待执行'
      : relayReport.verdict === 'PASS' ? '通过' : relayReport.verdict === 'FAIL' ? '失败' : relayReport.verdict;
  const relayTone = !profile?.relayFunctionalTestEnabled
    ? palette.muted
    : relayReport?.verdict === 'PASS' ? palette.pass : relayReport?.verdict === 'FAIL' ? palette.fail : palette.warn;
  const precheckTone = precheck?.verdict === 'FAIL' ? palette.fail : precheck?.verdict === 'PASS' ? palette.pass : palette.warn;

  const switchProductModel = async (selectedType: ProductType) => {
    if (!config || locked || switching || selectedType === config.selectedType) return;
    if (dirty) {
      setMessage('当前型号存在未保存修改，请先保存或撤销后再切换型号');
      return;
    }
    setSwitching(true);
    setMessage('');
    try {
      await onUpdate({ selectedType });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitching(false);
    }
  };

  const updateDraftProfile = (patch: Partial<NonNullable<typeof draftProfile>>) => {
    if (!draft || !draftProfile) return;
    const type = draft.selectedType;
    setDraft({
      ...draft,
      profiles: {
        ...draft.profiles,
        [type]: { ...draftProfile, ...patch },
      },
    });
    setMessage('');
  };

  const updateDraftCode = (patch: Partial<NonNullable<typeof draftProfile>['productCodeRule']>) => {
    if (!draftProfile) return;
    updateDraftProfile({ productCodeRule: { ...draftProfile.productCodeRule, ...patch } });
  };

  const resetDraft = () => {
    if (!config) return;
    setDraft(cloneConfig(config));
    setMessage('已撤销未保存修改');
  };

  const saveCurrentProfile = async () => {
    if (!draft || locked || saving || !dirty) return;
    setSaving(true);
    setMessage('');
    try {
      await onUpdate(draft);
      setMessage('配置已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <section
    aria-label="产品型号与检测配置"
    style={{
      width: '100%',
      maxWidth: 'none',
      color: palette.text,
      border: `1px solid ${palette.border}`,
      background: `linear-gradient(145deg,${palette.panelTop},${palette.panelBottom})`,
      boxShadow: 'inset 0 0 18px rgba(32,204,229,.07)',
      fontFamily: '"Microsoft YaHei UI", "Noto Sans SC", sans-serif',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', borderBottom: `1px solid ${palette.borderSoft}` }}>
      <div style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: palette.cyan, font: '700 10px Consolas, monospace', letterSpacing: '.15em' }}>PRODUCT CONFIGURATION</span>
        <strong style={{ display: 'block', marginTop: 4, color: palette.title, fontSize: 15 }}>产品型号与检测配置</strong>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 5, color: palette.muted, fontSize: 10.5 }}>
          <span style={{ color: locked ? palette.warn : palette.pass }}>{locked ? '流程已锁定' : '可编辑配置'}</span>
          <span style={{ color: precheckTone }}>{statusText(precheck, busy)}</span>
          {dirty && <span style={{ color: palette.warn }}>有未保存修改</span>}
        </span>
      </div>
      <Settings2 size={17} color={palette.cyan} aria-hidden="true" />
    </div>

    <div style={{ padding: '13px 14px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div>
          <div style={{ color: palette.title, fontWeight: 700, fontSize: 13 }}>生产产品型号</div>
          <div style={{ marginTop: 2, color: palette.dim, fontSize: 10 }}>选择实际生产型号，内部产品类型不向操作员显示</div>
        </div>
        <Settings2 size={16} color={palette.cyan} />
      </div>

      <select
        value={config?.selectedType ?? ''}
        disabled={!config || locked || switching}
        onChange={(event) => void switchProductModel(event.target.value as ProductType)}
        style={{ ...fieldStyle, padding: '9px 10px', color: palette.title, fontSize: 13, fontWeight: 700 }}
      >
        {!config && <option value="">产品配置未加载</option>}
        {config && PRODUCT_TYPE_ORDER.map((type) => {
          const model = productModel(config, type);
          const label = config.profiles?.[type]?.label?.trim() || '类别未配置';
          return <option value={type} key={type}>{model} · {label}</option>;
        })}
      </select>

      {draftProfile && <>
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 8, marginTop: 11 }}>
          <label style={{ color: palette.muted, fontSize: 10.5 }}>
            型号名称
            <input
              value={draftProfile.productModel}
              disabled={locked}
              placeholder="配置文件中的产品型号"
              onChange={(event) => updateDraftProfile({ productModel: event.target.value })}
              style={{ ...fieldStyle, marginTop: 5, color: palette.title, fontWeight: 700 }}
            />
          </label>
          <label style={{ color: palette.muted, fontSize: 10.5 }}>
            软件版本基准
            <input
              value={draftProfile.expectedSoftwareVersion}
              disabled={locked}
              placeholder="例如 90.26.08.11"
              onChange={(event) => updateDraftProfile({ expectedSoftwareVersion: event.target.value })}
              style={{ ...fieldStyle, marginTop: 5 }}
            />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 8, marginTop: 8 }}>
          <div style={{ color: palette.muted, fontSize: 10.5 }}>
            产品类别
            <div style={{ ...fieldStyle, marginTop: 5, color: palette.dim, opacity: .75 }}>{draftProfile.label}</div>
          </div>
          <label style={{ color: palette.muted, fontSize: 10.5 }}>
            探头数量
            <input
              type="number"
              min={1}
              max={4}
              value={draftProfile.expectedProbeCount}
              disabled={locked}
              onChange={(event) => updateDraftProfile({ expectedProbeCount: Number(event.target.value) })}
              style={{ ...fieldStyle, marginTop: 5 }}
            />
          </label>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 34, marginTop: 9, padding: '0 8px', color: palette.muted, border: `1px solid ${palette.borderSoft}`, background: '#061923', fontSize: 10.5 }}>
          <input
            type="checkbox"
            checked={draftProfile.skipSoftwareVersionCheck}
            disabled={locked}
            onChange={(event) => updateDraftProfile({ skipSoftwareVersionCheck: event.target.checked })}
          />
          跳过软件版本判定（仍发送版本读取指令并记录实际版本）
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 9 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 32, padding: '0 8px', color: palette.muted, border: `1px solid ${palette.borderSoft}`, background: '#061923', fontSize: 10.5 }}>
            <input
              type="checkbox"
              checked={draftProfile.relayFunctionalTestEnabled}
              disabled={locked}
              onChange={(event) => updateDraftProfile({ relayFunctionalTestEnabled: event.target.checked })}
            />
            继电器功能测试
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 32, padding: '0 8px', color: palette.muted, border: `1px solid ${palette.borderSoft}`, background: '#061923', fontSize: 10.5 }}>
            <input
              type="checkbox"
              checked={draftProfile.productCodeRule.enabled}
              disabled={locked}
              onChange={(event) => updateDraftCode({ enabled: event.target.checked })}
            />
            自动生成产品编号
          </label>
        </div>

        <div style={{ marginTop: 11, paddingTop: 10, borderTop: `1px solid ${palette.borderSoft}` }}>
          <div style={{ color: palette.title, fontSize: 11.5, fontWeight: 700 }}>产品编号规则</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.25fr repeat(3,.75fr)', gap: 7, marginTop: 7 }}>
            {[
              ['ABCC', 'productNameCode', 4, '4102'],
              ['EE', 'softwareVersionCode', 2, '01'],
              ['FF', 'hardwareVersionCode', 2, '02'],
              ['GG', 'producerCode', 2, '01'],
            ].map(([label, key, maxLength, placeholder]) => <label key={String(key)} style={{ color: palette.muted, fontSize: 9.5 }}>
              {label}
              <input
                value={String(draftProfile.productCodeRule[key as keyof typeof draftProfile.productCodeRule] ?? '')}
                maxLength={Number(maxLength)}
                disabled={locked}
                placeholder={String(placeholder)}
                onChange={(event) => updateDraftCode({ [key]: event.target.value })}
                style={{ ...fieldStyle, marginTop: 4, textTransform: 'uppercase' }}
              />
            </label>)}
          </div>
          <div style={{ marginTop: 6, color: draftCodeMissing.length ? palette.warn : palette.dim, fontSize: 9.5 }}>
            {draftCodeMissing.length ? '当前草稿的编号规则未完整配置；仍允许保存，也不会阻断正式检测。' : '流水号按产品型号独立，每月从 00001 重新开始。'}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 11, paddingTop: 10, borderTop: `1px solid ${palette.borderSoft}`, fontSize: 10.5 }}>
          <span style={{ color: palette.muted }}>已保存版本 <b style={{ color: palette.title }}>{profile?.expectedSoftwareVersion ? formatSoftwareVersion(profile.expectedSoftwareVersion) : '未配置'}</b></span>
          <span style={{ color: palette.muted }}>版本判定 <b style={{ color: profile?.skipSoftwareVersionCheck ? palette.warn : palette.pass }}>{profile?.skipSoftwareVersionCheck ? '已跳过' : '参与判定'}</b></span>
          <span style={{ color: palette.muted }}>已保存探头 <b style={{ color: palette.title }}>{profile?.expectedProbeCount ?? '-'} 路</b></span>
          <span style={{ color: palette.muted }}>继电器结果 <b style={{ color: relayTone }}>{relayText}</b></span>
          <span style={{ color: palette.muted }}>编号规则 <b style={{ color: savedCodeMissing.length ? palette.warn : palette.pass }}>{savedCodeMissing.length ? '未完整配置' : '已配置'}</b></span>
        </div>

        <div style={{ marginTop: 9, padding: '7px 8px', color: toneColor(allocation.tone), border: `1px solid ${palette.borderSoft}`, background: '#061923', fontSize: 10 }}>本批产品编号：{allocation.text}</div>

        {precheck && <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${palette.borderSoft}`, color: palette.muted, fontSize: 10 }}>
          <div style={{ color: precheckTone }}>实际检查 {precheck.units.length} 台 · {failedUnits.length ? `${failedUnits.length} 台异常` : precheck.verdict === 'PASS' ? '预检通过' : '等待结果'}</div>
          {relayReport && <div style={{ marginTop: 4, color: relayTone }}>继电器：{relayReport.mode} · {relayText}</div>}
          {relayReport && <section style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${palette.borderSoft}` }} aria-label="继电器功能测试结果">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <b style={{ color: palette.title, fontSize: 11.5 }}>最近一次继电器测试结果</b>
              <span style={{ color: relayTone, fontSize: 10.5 }}>{relayText}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6, marginTop: 7 }}>
              {relayReport.units.map((unit) => {
                const reasons = [...relayActionReasons(unit.alarm), ...relayActionReasons(unit.fault)];
                return <div key={unit.detectorIndex} style={{ minWidth: 0, padding: '6px 7px', border: `1px solid ${unit.verdict === 'PASS' ? 'rgba(98,231,182,.32)' : 'rgba(242,119,105,.32)'}`, background: unit.verdict === 'PASS' ? 'rgba(10,54,48,.42)' : 'rgba(64,20,20,.32)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}><b style={{ color: palette.title, fontSize: 10.5 }}>D{unit.detectorIndex}</b><strong style={{ color: unit.verdict === 'PASS' ? palette.pass : palette.fail, fontSize: 10 }}>{relayActionText(unit.verdict)}</strong></div>
                  <div style={{ marginTop: 4, color: palette.muted, fontSize: 9.5 }}>火警 {relayActionText(unit.alarm.verdict)} · 故障 {relayActionText(unit.fault.verdict)}</div>
                  {reasons.length > 0 && <div style={{ marginTop: 4, color: palette.fail, fontSize: 9.5, lineHeight: 1.45 }}>{reasons.join('；')}</div>}
                </div>;
              })}
            </div>
          </section>}
          {failedUnits.length > 0 && <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
            {failedUnits.slice(0, 6).map((unit) => <div key={unit.index} style={{ padding: '5px 6px', color: '#ffaaa0', border: '1px solid rgba(242,119,105,.30)', background: 'rgba(64,20,20,.28)' }}>
              <b>D{unit.index}</b> · {unit.reasons.map(reasonText).join(' / ')}
              <div style={{ marginTop: 2, color: '#a98686' }}>版本 {unit.actualSoftwareVersion ?? '-'} · 探头 {unit.actualProbeCount ?? '-'}/{unit.expectedProbeCount} · 灵敏度 {unit.sensitivityLevel ?? '-'}</div>
            </div>)}
          </div>}
        </div>}

        {noDataUnits.length > 0 && <div style={{ marginTop: 8, padding: '6px 7px', color: palette.warn, border: '1px solid rgba(226,195,99,.28)', background: 'rgba(68,55,12,.22)', fontSize: 10 }}>
          波形异常：{noDataUnits.map((unit) => `D${unit.index} ${unit.noDataProbes?.map(probeLabel).join('/')}`).join('；')}
        </div>}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 11 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: locked ? palette.warn : dirty ? palette.warn : palette.dim, fontSize: 9.5 }}>
            <ShieldCheck size={12} />{locked ? '流程运行中：当前仅可查看配置' : dirty ? '存在未保存修改' : '当前配置已与后台同步'}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {dirty && !locked && <button
              type="button"
              onClick={resetDraft}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 9px', color: palette.text, border: `1px solid ${palette.borderSoft}`, background: palette.field, cursor: 'pointer', font: 'inherit', fontSize: 10.5 }}
            ><RotateCcw size={12} />撤销</button>}
            <button
              type="button"
              disabled={locked || saving || !dirty}
              onClick={() => void saveCurrentProfile()}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 11px',
                color: '#06202b', border: `1px solid ${palette.cyan}`, background: palette.cyan,
                cursor: locked || saving || !dirty ? 'not-allowed' : 'pointer', opacity: locked || saving || !dirty ? .45 : 1,
                font: 'inherit', fontSize: 10.5, fontWeight: 700,
              }}
            >
              <Save size={13} />{saving ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>
      </>}

      {message && <div style={{ marginTop: 8, color: message.includes('已保存') || message.includes('已撤销') ? palette.pass : palette.fail, fontSize: 10 }}>{message}</div>}
    </div>
  </section>;
}
