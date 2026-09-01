import { useEffect, useState } from 'react';
import type { FC } from 'react';
import { ClipboardCheck, LoaderCircle, Settings2, X } from 'lucide-react';
import type {
  DetectionQualityConfig,
  DetectionQualityThresholds,
  DetectionRatioThresholds,
  DetectorQualityConfig,
  FlameDetectorConfig,
} from '../types';
import type { FieldWaveformAnalysisSnapshot, WaveformAnalysisUnitResult } from '../server/src/closure/field-waveform-analysis';
import type { FlameDetectorState, FlameDetectorUnitState, FlameSample } from '../server/src/types';
import { DEFAULT_WAVEFORM_MAX_SAMPLES, waveformDomain, waveformKeys, waveformSamples, type WaveformDisplayMode } from '../utils/waveform';

const DESKTOP_RUNTIME = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
const FIELD_DEV_HTTP = `http://${window.location.hostname}:3001`;
const FIELD_DEV_PAGE = !DESKTOP_RUNTIME && window.location.port === '3002';
const HTTP = DESKTOP_RUNTIME?.backendHttpUrl || (FIELD_DEV_PAGE ? FIELD_DEV_HTTP : import.meta.env.VITE_BACKEND_API_URL || FIELD_DEV_HTTP);
const AUTO_TEST_STEP_KEYS = ['connection', 'params', 'status', 'realtime', 'mirror', 'report'] as const;

interface FlameTestReport {
  passed: boolean;
  summary: { total: number; passed: number };
  devices: Record<string, { address: number; passed: boolean; steps: Array<{ name: string; passed: boolean; error?: string }> }>;
}

interface Props {
  state: FlameDetectorState | null;
  config: FlameDetectorConfig | null;
  analysis: FieldWaveformAnalysisSnapshot | null;
  onRefresh: () => void;
}

const emptyConfig: FlameDetectorConfig = {
  mode: 'TCP',
  ip: '192.168.16.253',
  port: 31001,
  serialPath: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  units: [31001, 32001, 33001, 34001, 35001, 36001].map((tcpPort, index) => ({
    index: index + 1,
    address: index + 1,
    enabled: true,
    connMode: 'TCP' as const,
    tcpHost: '192.168.16.253',
    tcpPort,
  })),
  pollIntervalMs: 250,
  waveformSendMode: 'active',
  waveformDisplayMode: 'normalized',
  waveformMaxSamples: 1000,
  waveformAnalysis: {
    minNoiseSamples: 400,
    minInterferenceSamples: 80,
    minNoiseRms: 50,
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    interferenceRatio: { numerator: 'probe2', denominator: 'probe3' },
    noiseProbes: ['probe2', 'probe3'],
    consistencyProbes: ['probe2', 'probe3'],
    minConsistencyTrend: 0.75,
    quality: {
      a: { maxNoiseRms: 180, maxNoiseAbsolute: 1000, maxInterferenceRatio: 1.5, minConsistencyTrend: 0.8, minSensitivity: 0 },
      b: { maxNoiseRms: 200, maxNoiseAbsolute: 1000, maxInterferenceRatio: 1.5, minConsistencyTrend: 0.75, minSensitivity: 0 },
      detectors: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1), {
        a: {
          snr21: { min: 0, max: 0 },
          snr23: { min: 0.5, max: 1.5 },
          snr31: { min: 0, max: 0 },
        },
        b: {
          snr21: { min: 0, max: 0 },
          snr23: { min: 0.5, max: 1.5 },
          snr31: { min: 0, max: 0 },
        },
      } satisfies DetectorQualityConfig])),
    },
  },
};

const DEFAULT_QUALITY: DetectionQualityConfig = emptyConfig.waveformAnalysis!.quality!;

type ProbeKey = 'probe1' | 'probe2' | 'probe3' | 'probe4';

const DEFAULT_PROBE_SELECTION: ProbeKey[] = ['probe2', 'probe3'];
const PROBE_OPTIONS: Array<{ value: ProbeKey; label: string }> = [
  { value: 'probe1', label: 'P1' },
  { value: 'probe2', label: 'P2' },
  { value: 'probe3', label: 'P3' },
  { value: 'probe4', label: 'P4' },
];

function cloneConfig(config: FlameDetectorConfig): FlameDetectorConfig {
  return JSON.parse(JSON.stringify(config)) as FlameDetectorConfig;
}

function unitProbeKeys(unit: FlameDetectorUnitState | undefined): Array<keyof FlameSample> {
  return unit && (unit.probe4 !== undefined || unit.probeCount >= 4 || unit.protocol === 'four-wavelength')
    ? ['probe1', 'probe2', 'probe3', 'probe4']
    : ['probe1', 'probe2', 'probe3'];
}

function formatProbe(value: number | undefined) {
  return Number.isFinite(value) ? Number(value).toFixed(0) : '--';
}

function fluctuationFor(unit: FlameDetectorUnitState | undefined, key: keyof FlameSample): number | undefined {
  const explicit = unit?.[`${key}Fluctuation` as keyof FlameDetectorUnitState];
  const hasHistory = (unit?.historySamples?.length ?? unit?.samples?.length ?? 0) > 0;
  return Number.isFinite(Number(explicit)) && (Number(explicit) > 0 || !hasHistory)
    ? Number(explicit)
    : (unit?.[key] as number | undefined);
}

function absoluteFor(unit: FlameDetectorUnitState | undefined, key: keyof FlameSample): number | undefined {
  const explicit = unit?.[`${key}Absolute` as keyof FlameDetectorUnitState];
  const hasHistory = (unit?.rawHistorySamples?.length ?? unit?.rawSamples?.length ?? 0) > 0;
  if (Number.isFinite(Number(explicit)) && (Number(explicit) > 0 || !hasHistory)) return Number(explicit);
  const raw = unit?.rawHistorySamples ?? unit?.rawSamples ?? [];
  return raw.reduce((max, sample) => Math.max(max, Math.abs(Number(sample[key]) || 0)), 0);
}

function formatRatio(value: number | undefined) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : '--';
}

function phaseLabel(phase: FieldWaveformAnalysisSnapshot['phase'] | undefined) {
  if (phase === 'NOISE') return '无干扰噪声检测';
  if (phase === 'INTERFERENCE') return '干扰比值检测';
  if (phase === 'COMPLETE') return '波形检测完成';
  return '等待工序启动';
}

function reasonLabel(reason: string | undefined) {
  const labels: Record<string, string> = {
    WAITING_FOR_PROCESS_START: '等待工序开始',
    WAITING_FOR_NOISE_SAMPLES: '采集无干扰样本中',
    WAITING_FOR_INTERFERENCE_SAMPLES: '采集干扰样本中',
    WAITING_FOR_PROCESS_COMPLETE: '等待工序完成',
    DETECTOR_OFFLINE: '通信未连接',
    DETECTOR_FAULT: '设备故障',
    NOISE_RMS_BELOW_LIMIT: '噪声波动值低于下限',
    NOISE_EXCEEDS_LIMIT: '噪声超限',
    INTERFERENCE_RATIO_EXCEEDS_LIMIT: '干扰比超限',
    WAVEFORM_WITHIN_LIMIT: '指标在限值内',
  };
  return labels[reason || ''] || reason || '等待检测数据';
}

function WaveformChart({ samples, raw, selectedMode, index, unit }: { samples: FlameSample[]; raw: FlameSample[]; selectedMode: WaveformDisplayMode; index: number; unit: FlameDetectorUnitState | undefined }) {
  const values = selectedMode === 'raw' && raw.length > 0 ? raw : samples;
  const keys = waveformKeys(values, unit);
  const width = 720;
  const height = 250;
  const pad = { top: 18, right: 12, bottom: 22, left: 34 };
  const { minValue, maxValue, min, span } = waveformDomain(values, keys);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const colors = ['#42e4ef', '#f5cf6c', '#62e5a9', '#f395ff'];
  const yFor = (value: number) => pad.top + plotHeight - ((value - min) / span) * plotHeight;
  const xFor = (index: number) => pad.left + (index / Math.max(1, values.length - 1)) * plotWidth;
  const paths = keys.map((key) => values.map((sample, pointIndex) => {
    const value = Number(sample[key]);
    const y = yFor(Number.isFinite(value) ? value : 0);
    return `${pointIndex === 0 ? 'M' : 'L'}${xFor(pointIndex).toFixed(1)},${y.toFixed(1)}`;
  }).join(' '));

  return <div className="waveform-shell">
    <div className="waveform-legend">{keys.map((key, colorIndex) => <span key={key}><i style={{ background: colors[colorIndex] }} />{key.replace('probe', '探头')}</span>)}</div>
    {values.length < 2 ? <div className="waveform-empty">探测器 {index} 等待完整波形数据</div> : <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`探测器${index}完整波形`}>
      {[0, .5, 1].map((ratio) => {
        const y = pad.top + plotHeight * (1 - ratio);
        return <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="wave-grid-line" /><text x={pad.left - 5} y={y + 3} textAnchor="end" className="wave-axis-label">{(min + span * ratio).toFixed(0)}</text></g>;
      })}
      {paths.map((path, colorIndex) => <path key={keys[colorIndex]} d={path} fill="none" stroke={colors[colorIndex]} strokeWidth="1.7" vectorEffect="non-scaling-stroke" />)}
    </svg>}
    <small>{values.length} 点 · 范围 {minValue.toFixed(0)} ~ {maxValue.toFixed(0)}</small>
  </div>;
}

interface DetectorWaveformCardProps {
  index: number;
  unit: FlameDetectorUnitState | undefined;
  analysis: WaveformAnalysisUnitResult | undefined;
  selectedMode: 'raw' | 'normalized';
  maxSamples: number;
}

const DetectorWaveformCard: FC<DetectorWaveformCardProps> = ({ index, unit, analysis, selectedMode, maxSamples }) => {
  const state = analysis?.verdict?.toLowerCase() ?? 'pending';
  const samples = waveformSamples(unit, 'normalized', maxSamples);
  const rawSamples = waveformSamples(unit, 'raw', maxSamples);
  const probes = unitProbeKeys(unit);
  const p1 = fluctuationFor(unit, 'probe1') ?? 0;
  const p2 = fluctuationFor(unit, 'probe2') ?? 0;
  const p3 = fluctuationFor(unit, 'probe3') ?? 0;
  const ratio = (reported: number | undefined, numerator: number, denominator: number) => reported && reported > 0
    ? reported
    : (denominator > 0 ? numerator / denominator : undefined);
  const ratios = [
    { label: 'P2 / P1', value: ratio(unit?.snr21, p2, p1) },
    { label: 'P2 / P3', value: ratio(unit?.snr23, p2, p3) },
    { label: 'P3 / P1', value: ratio(unit?.snr31, p3, p1) },
    ...(probes.includes('probe4') ? [{ label: 'P4 / P3', value: unit?.features?.[0]?.snr43 }] : []),
  ];
  return <article className={`detector-card ${state}`}>
    <header className="detector-card-header"><div><b>探测器 {index}</b><span>地址 {unit?.address ?? index} · {unit?.protocol === 'four-wavelength' ? '四波长' : '三波长'} · {probes.length} 路探头</span></div><div className="detector-card-status"><span className={`detector-card-live ${unit?.online ? 'is-live' : ''}`}>实时</span><strong>{analysis?.verdict === 'PASS' ? 'PASS' : analysis?.verdict === 'FAIL' ? 'FAIL' : unit?.online ? '采集中' : '离线'}</strong></div></header>
    <div className="detector-card-layout">
      <section className="detector-card-waveform"><div className="detector-card-section-heading"><b>实时波形预览</b><span>{selectedMode === 'raw' ? '原始值' : '归一化值'} · {(selectedMode === 'raw' ? rawSamples : samples).length} 点</span></div><WaveformChart samples={samples} raw={rawSamples} selectedMode={selectedMode} index={index} unit={unit} /></section>
      <div className="detector-card-data">
        <section className="probe-data-section"><header><b>探头数据</b><span>波动 / 绝对 · mV</span></header><div className={`probe-metric-grid ${probes.length === 4 ? 'has-four' : ''}`}>{probes.map((key) => <div className="probe-metric" key={key}><span>探头{key.replace('probe', '')}</span><b>{formatProbe(fluctuationFor(unit, key))}</b><small>绝对 {formatProbe(absoluteFor(unit, key))}</small></div>)}</div></section>
        <section className="probe-data-section"><header><b>探头比值</b><span>实时 SNR</span></header><div className={`probe-ratio-grid ${ratios.length === 4 ? 'has-four' : ''}`}>{ratios.map((ratio) => <div className="probe-ratio" key={ratio.label}><span>{ratio.label}</span><b>{formatRatio(ratio.value)}</b><small>×</small></div>)}</div></section>
        <div className="detector-card-quality"><span>噪声 RMS <b>{analysis?.noiseRms == null ? '--' : analysis.noiseRms.toFixed(2)}</b></span><span>干扰比 <b>{analysis?.interferenceRatio == null ? '--' : `${analysis.interferenceRatio.toFixed(2)}×`}</b></span><span>样本 <b>{analysis ? `${analysis.noiseSampleCount}/${analysis.interferenceSampleCount}` : '--'}</b></span></div>
      </div>
    </div>
    <footer><span><i className={unit?.online ? 'signal-on' : ''} />{unit?.online ? '实时波形流正常' : '等待探测器通讯'}</span><span>{analysis ? reasonLabel(analysis.reason) : unit?.online ? '持续记录完整波形' : '等待检测数据'}</span></footer>
  </article>;
};

const QUALITY_FIELDS: Array<{ key: keyof DetectionQualityThresholds; label: string; step: string }> = [
  { key: 'maxNoiseRms', label: '噪声波动值上限', step: '1' },
  { key: 'maxNoiseAbsolute', label: '探头绝对值上限', step: '1' },
  { key: 'maxInterferenceRatio', label: '干扰比上限', step: '0.1' },
  { key: 'minConsistencyTrend', label: '一致性趋势下限', step: '0.05' },
  { key: 'minSensitivity', label: '灵敏度下限', step: '0.1' },
];

function QualityThresholdGroup({ title, values, onChange }: { title: string; values: DetectionQualityThresholds; onChange: (key: keyof DetectionQualityThresholds, value: number) => void }) {
  return <section className="quality-threshold-group">
    <h3>{title}</h3>
    <div className="quality-threshold-grid">
      {QUALITY_FIELDS.map((field) => <label key={field.key}>{field.label}<input type="number" min="0" step={field.step} value={values[field.key]} onChange={(event) => onChange(field.key, Number(event.target.value))} /></label>)}
    </div>
  </section>;
}

const SNR_FIELDS: Array<{ key: keyof DetectionRatioThresholds; label: string }> = [
  { key: 'snr21', label: 'P2/P1' },
  { key: 'snr23', label: 'P2/P3' },
  { key: 'snr31', label: 'P3/P1' },
];

function SNRRangeGroup({ title, values, onChange }: {
  title: string;
  values: DetectionRatioThresholds;
  onChange: (key: keyof DetectionRatioThresholds, bound: 'min' | 'max', value: number) => void;
}) {
  return <section className="quality-snr-grade">
    <h4>{title}</h4>
    {SNR_FIELDS.map((field) => <div className="quality-snr-row" key={field.key}>
      <span>SNR {field.label}</span>
      <input aria-label={`${title} ${field.label}下限`} type="number" min="0" step="0.01" value={values[field.key].min} onChange={(event) => onChange(field.key, 'min', Number(event.target.value))} />
      <i>至</i>
      <input aria-label={`${title} ${field.label}上限`} type="number" min="0" step="0.01" value={values[field.key].max} onChange={(event) => onChange(field.key, 'max', Number(event.target.value))} />
    </div>)}
    <small>上限填 0 表示不限</small>
  </section>;
}

function ProbeSelectionGroup({ label, values, onChange }: {
  label: string;
  values: ProbeKey[];
  onChange: (values: ProbeKey[]) => void;
}) {
  const toggleProbe = (probe: ProbeKey, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...values, probe]))
      : values.filter((value) => value !== probe);
    onChange(next);
  };

  return <fieldset className="probe-selection-fieldset">
    <legend>{label}</legend>
    <div className="probe-selection-options">
      {PROBE_OPTIONS.map((probe) => <label className={`probe-selection-option ${values.includes(probe.value) ? 'is-selected' : ''}`} key={probe.value}>
        <input type="checkbox" aria-label={`${label} ${probe.label}`} checked={values.includes(probe.value)} onChange={(event) => toggleProbe(probe.value, event.target.checked)} />
        <span>{probe.label}</span>
      </label>)}
    </div>
    <small>已选 {values.length} 个，可同时选择多个探头</small>
  </fieldset>;
}

function qualityWithDefaults(quality: DetectionQualityConfig | undefined): DetectionQualityConfig {
  const base = DEFAULT_QUALITY;
  const configured = quality as (DetectionQualityConfig & { detectors?: Record<string, DetectorQualityConfig> }) | undefined;
  const detectors = Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const key = String(index + 1);
    const defaults = base.detectors[key];
    const saved = configured?.detectors?.[key];
    const ratioDefaults = (grade: 'a' | 'b') => ({
      snr21: { ...defaults[grade].snr21, ...(saved?.[grade]?.snr21 || {}) },
      snr23: { ...defaults[grade].snr23, ...(saved?.[grade]?.snr23 || {}) },
      snr31: { ...defaults[grade].snr31, ...(saved?.[grade]?.snr31 || {}) },
    });
    return [key, { a: ratioDefaults('a'), b: ratioDefaults('b') } satisfies DetectorQualityConfig];
  }));
  return {
    ...base,
    ...configured,
    a: { ...base.a, ...(configured?.a || {}) },
    b: { ...base.b, ...(configured?.b || {}) },
    detectors,
  };
}

function DeviceConfigEditor({ draft, setDraft }: { draft: FlameDetectorConfig; setDraft: (config: FlameDetectorConfig) => void }) {
  const updateUnit = (index: number, patch: Partial<FlameDetectorConfig['units'][number]>) => {
    setDraft({ ...draft, units: draft.units.map((unit) => unit.index === index ? { ...unit, ...patch } : unit) });
  };
  const quality = qualityWithDefaults(draft.waveformAnalysis?.quality);
  const updateQuality = (grade: 'a' | 'b', key: keyof DetectionQualityThresholds, value: number) => {
    setDraft({
      ...draft,
      waveformAnalysis: {
        ...draft.waveformAnalysis,
        quality: {
          ...quality,
          [grade]: { ...quality[grade], [key]: value },
        },
      },
    });
  };
  const updateDetectorSNR = (index: number, grade: 'a' | 'b', key: keyof DetectionRatioThresholds, bound: 'min' | 'max', value: number) => {
    const detectorKey = String(index);
    const detector = quality.detectors[detectorKey];
    setDraft({
      ...draft,
      waveformAnalysis: {
        ...draft.waveformAnalysis,
        quality: {
          ...quality,
          detectors: {
            ...quality.detectors,
            [detectorKey]: {
              ...detector,
              [grade]: {
                ...detector[grade],
                [key]: { ...detector[grade][key], [bound]: value },
              },
            },
          },
        },
      },
    });
  };
  const updateProbeSelection = (key: 'noiseProbes' | 'consistencyProbes', values: ProbeKey[]) => {
    setDraft({
      ...draft,
      waveformAnalysis: {
        ...draft.waveformAnalysis,
        [key]: values,
      },
    });
  };
  return <div className="detector-config-form">
    <div className="config-grid">
      <label>通信模式<select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as 'RTU' | 'TCP' })}><option value="RTU">RS485 / Modbus RTU</option><option value="TCP">Modbus TCP</option></select></label>
      {draft.mode === 'RTU' ? <label>串口<select value={draft.serialPath || ''} onChange={(event) => setDraft({ ...draft, serialPath: event.target.value })}><option value="">选择或输入串口</option><option value="COM1">COM1</option><option value="COM2">COM2</option><option value="COM3">COM3</option><option value="COM4">COM4</option></select><input value={draft.serialPath || ''} onChange={(event) => setDraft({ ...draft, serialPath: event.target.value })} placeholder="如 COM4" /></label> : <label>设备 IP<input value={draft.ip} onChange={(event) => { const ip = event.target.value; setDraft({ ...draft, ip, units: draft.units.map((unit) => unit.connMode === 'TCP' ? { ...unit, tcpHost: ip } : unit) }); }} /></label>}
      <label>波特率<input type="number" value={draft.baudRate || 115200} onChange={(event) => setDraft({ ...draft, baudRate: Number(event.target.value) })} /></label>
      <label>默认协议<select value={draft.protocol || ''} onChange={(event) => setDraft({ ...draft, protocol: (event.target.value || undefined) as FlameDetectorConfig['protocol'] })}><option value="">自动识别</option><option value="standard">三波长</option><option value="four-wavelength">四波长</option></select></label>
      <label>默认波形发送模式<select value={draft.waveformSendMode || 'active'} onChange={(event) => setDraft({ ...draft, waveformSendMode: event.target.value as 'active' | 'filtered' })}><option value="active">主动发送</option><option value="filtered">滤波发送</option></select></label>
      {draft.mode === 'TCP' && <label>默认端口<input type="number" min="1" max="65535" value={draft.port || 31001} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></label>}
      <label>采样周期(ms)<input type="number" min="100" max="900" value={draft.pollIntervalMs || 250} onChange={(event) => setDraft({ ...draft, pollIntervalMs: Number(event.target.value) })} /></label>
      <label>波形显示<select value={draft.waveformDisplayMode || 'normalized'} onChange={(event) => setDraft({ ...draft, waveformDisplayMode: event.target.value as 'raw' | 'normalized' })}><option value="normalized">归一化</option><option value="raw">原始值</option></select></label>
      <label>保留点数<input type="number" min="10" max="1000" value={draft.waveformMaxSamples || 1000} onChange={(event) => setDraft({ ...draft, waveformMaxSamples: Number(event.target.value) })} /></label>
      <label>噪声样本数<input type="number" min="1" max="2000" value={draft.waveformAnalysis?.minNoiseSamples || 400} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, minNoiseSamples: Number(event.target.value) } })} /></label>
      <label>干扰样本数<input type="number" min="1" max="2000" value={draft.waveformAnalysis?.minInterferenceSamples || 80} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, minInterferenceSamples: Number(event.target.value) } })} /></label>
      <label>噪声波动值下限<input type="number" min="0" step="1" value={draft.waveformAnalysis?.minNoiseRms ?? 50} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, minNoiseRms: Number(event.target.value) } })} /></label>
      <label>噪声波动值上限<input type="number" min="0" step="1" value={draft.waveformAnalysis?.maxNoiseRms ?? 200} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, maxNoiseRms: Number(event.target.value) } })} /></label>
      <label>探头绝对值上限<input type="number" min="0" step="1" value={draft.waveformAnalysis?.maxNoiseAbsolute ?? 1000} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, maxNoiseAbsolute: Number(event.target.value) } })} /></label>
      <label>干扰比上限<input type="number" min="0" step="0.1" value={draft.waveformAnalysis?.maxInterferenceRatio ?? 1.5} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, maxInterferenceRatio: Number(event.target.value) } })} /></label>
      <label>一致性趋势下限<input type="number" min="0" max="1" step="0.05" value={draft.waveformAnalysis?.minConsistencyTrend ?? 0.75} onChange={(event) => setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, minConsistencyTrend: Number(event.target.value) } })} /></label>
      <label>干扰比探头<select value={`${draft.waveformAnalysis?.interferenceRatio?.numerator || 'probe2'}/${draft.waveformAnalysis?.interferenceRatio?.denominator || 'probe3'}`} onChange={(event) => { const [numerator, denominator] = event.target.value.split('/'); setDraft({ ...draft, waveformAnalysis: { ...draft.waveformAnalysis, interferenceRatio: { numerator: numerator as 'probe1' | 'probe2' | 'probe3' | 'probe4', denominator: denominator as 'probe1' | 'probe2' | 'probe3' | 'probe4' } } }); }}><option value="probe2/probe3">P2 / P3</option><option value="probe2/probe1">P2 / P1</option><option value="probe3/probe1">P3 / P1</option></select></label>
      <ProbeSelectionGroup label="噪声分析探头" values={draft.waveformAnalysis?.noiseProbes ?? DEFAULT_PROBE_SELECTION} onChange={(values) => updateProbeSelection('noiseProbes', values)} />
      <ProbeSelectionGroup label="趋势一致性探头" values={draft.waveformAnalysis?.consistencyProbes ?? DEFAULT_PROBE_SELECTION} onChange={(values) => updateProbeSelection('consistencyProbes', values)} />
    </div>
    <div className="quality-config-block">
      <div className="quality-config-heading"><b>定量指标分级</b><span>A类为严格限值；未达到 A 但满足 B 时判为 B类合格；超过 B 或设备故障判为不合格。</span></div>
      <div className="quality-threshold-groups">
        <QualityThresholdGroup title="A类合格阈值" values={quality.a} onChange={(key, value) => updateQuality('a', key, value)} />
        <QualityThresholdGroup title="B类合格阈值" values={quality.b} onChange={(key, value) => updateQuality('b', key, value)} />
      </div>
      <div className="quality-snr-config">
        <div className="quality-snr-heading"><b>各探测器 SNR 合格范围</b><span>每台探测器单独设置 P2/P1、P2/P3、P3/P1；范围含边界，上限填 0 表示不限。</span></div>
        <div className="quality-detector-groups">
          {Array.from({ length: 6 }, (_, index) => {
            const detector = quality.detectors[String(index + 1)];
            return <section className="quality-detector-group" key={index + 1}>
              <h3>探测器 {index + 1}</h3>
              <div className="quality-detector-grades">
                <SNRRangeGroup title="A类" values={detector.a} onChange={(key, bound, value) => updateDetectorSNR(index + 1, 'a', key, bound, value)} />
                <SNRRangeGroup title="B类" values={detector.b} onChange={(key, bound, value) => updateDetectorSNR(index + 1, 'b', key, bound, value)} />
              </div>
            </section>;
          })}
        </div>
      </div>
    </div>
    <div className="config-unit-grid">{draft.units.map((unit) => <label key={unit.index} className={`config-unit ${unit.enabled ? 'is-enabled' : ''}`}><span>探测器 {unit.index}</span><input type="checkbox" checked={unit.enabled} onChange={(event) => updateUnit(unit.index, { enabled: event.target.checked })} /><em>地址</em><input type="number" min="1" max="247" value={unit.address} onChange={(event) => updateUnit(unit.index, { address: Number(event.target.value) })} />{draft.mode === 'TCP' && <><em>端口</em><input type="number" min="1" max="65535" value={unit.tcpPort || 31001 + (unit.index - 1) * 1000} onChange={(event) => updateUnit(unit.index, { connMode: 'TCP', tcpHost: draft.ip, tcpPort: Number(event.target.value) })} /></>}<select value={unit.protocol || ''} onChange={(event) => updateUnit(unit.index, { protocol: (event.target.value || undefined) as FlameDetectorConfig['protocol'] })}><option value="">跟随默认</option><option value="standard">三波长</option><option value="four-wavelength">四波长</option></select></label>)}</div>
  </div>;
}

export function FlameDetectorWorkbench({ state, config, analysis, onRefresh }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<FlameDetectorConfig>(cloneConfig(config || emptyConfig));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { if (config) setDraft(cloneConfig(config)); }, [config]);

  const saveConfig = async () => {
    setSaving(true); setMessage('');
    try {
      const response = await fetch(`${HTTP}/api/flame/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      const result = await response.json() as { success?: boolean; config?: FlameDetectorConfig; error?: string; code?: string };
      if (!response.ok || !result.success) throw new Error(result.error || result.code || '配置保存失败');
      setSettingsOpen(false); setMessage('探测器配置已保存，连接正在按新参数重启。'); onRefresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };

  const runAutoTest = async () => {
    setTesting(true); setMessage('设备自检进行中：按设备顺序执行六项只读检查（不含软件版本检验）。');
    try {
      const response = await fetch(`${HTTP}/api/flame/auto-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledStepKeys: AUTO_TEST_STEP_KEYS }),
      });
      const result = await response.json() as { success?: boolean; report?: FlameTestReport; error?: string; code?: string };
      if (!response.ok || !result.success || !result.report) throw new Error(result.error || result.code || '自动检测失败');
      setMessage(result.report.passed ? '设备自检完成：全部启用设备通过。' : '设备自检完成：存在失败项目。'); onRefresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setTesting(false); }
  };

  const waveformUnits = Array.from({ length: 6 }, (_, index) => state?.units.find((unit) => unit.index === index + 1));
  const selectedMode = config?.waveformDisplayMode || 'normalized';
  const maxSamples = config?.waveformMaxSamples ?? DEFAULT_WAVEFORM_MAX_SAMPLES;
  const analysisUnits = analysis?.units ?? [];

  return <section className="detector-workbench" aria-label="六个探测器完整波形与工序检测">
    <header className="workbench-header"><div><span className="section-kicker">FULL WAVEFORM MONITOR</span><h2>六路完整波形与工序检测</h2><p>工序开始后自动记录无干扰噪声，并在 FLASH / EMC 阶段计算干扰比值</p></div><div className="workbench-actions"><button onClick={() => setSettingsOpen(true)}><Settings2 size={15} />通信与显示配置</button><button className="test-action" onClick={() => void runAutoTest()} disabled={testing || !state?.units.some((unit) => unit.online)}>{testing ? <LoaderCircle className="spin" size={15} /> : <ClipboardCheck size={15} />}{testing ? '检测中…' : '设备只读自检'}</button></div></header>
    <div className="waveform-panel waveform-panel-wide"><div className="panel-heading"><div><b>6 个探测器完整波形</b><span>当前显示：{selectedMode === 'raw' ? '原始值' : '归一化值'} · 每台窗口 {maxSamples} 点</span></div><span className={`analysis-phase-badge ${analysis?.phase?.toLowerCase() || 'idle'}`}>{phaseLabel(analysis?.phase)}</span></div><div className="waveform-grid">{waveformUnits.map((unit, index) => <DetectorWaveformCard key={index + 1} index={index + 1} unit={unit} analysis={analysisUnits.find((item) => item.index === index + 1)} selectedMode={selectedMode} maxSamples={maxSamples} />)}</div></div>
    {message && <p className="workbench-message">{message}</p>}
    {settingsOpen && <div className="detector-modal-backdrop" role="presentation"><section className="detector-modal" role="dialog" aria-modal="true" aria-labelledby="detector-config-title"><header><div><span className="section-kicker">DETECTOR CONFIG</span><h2 id="detector-config-title">探测器通信与显示配置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭"><X size={17} /></button></header><DeviceConfigEditor draft={draft} setDraft={setDraft} /><footer><button onClick={() => setSettingsOpen(false)}>取消</button><button className="test-action" onClick={() => void saveConfig()} disabled={saving}>{saving ? '保存中…' : '保存并重连'}</button></footer></section></div>}
  </section>;
}
