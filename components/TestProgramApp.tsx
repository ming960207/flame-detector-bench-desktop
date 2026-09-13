import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Archive, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Download, RefreshCw, Settings2, ShieldCheck, TimerReset, Wifi, X } from 'lucide-react';
import './test-program.css';

type StageId = 'INIT' | 'HEAT_POSITIONING' | 'HEAT_SIGNAL_STABILIZATION' | 'HEAT_NOISE_CAPTURE' | 'HEAT_INTERFERENCE' | 'FLASH' | 'EMC' | 'RETURN_HOME' | 'COMPLETE' | 'FAULT' | 'UNKNOWN';
type Verdict = 'PASS' | 'FAIL' | 'PENDING' | string;

interface ProcessStatus {
  stageCode: number;
  stepCode: number;
  autoRunning: boolean;
  complete: boolean;
  alarm: boolean;
  stage: string;
  label: string;
  processStage: string;
  processLabel: string;
  heatSubstage?: string;
  heatSubstageLabel?: string;
  valid: boolean;
  reason?: string;
  timestamp: number;
  io?: { outputs?: Record<string, boolean>; internal?: Record<string, boolean>; steps?: Record<string, boolean> };
}

interface ChannelStats { count: number; min: number; max: number; mean: number; rms: number; peakToPeak: number; }
interface Sample { probe1: number; probe2: number; probe3: number; probe4?: number; }
interface UnitWaveform {
  index: number;
  address: number;
  sampleCount: number;
  rawSampleCount: number;
  firstAt: number | null;
  lastAt: number | null;
  channels: Record<string, ChannelStats>;
  samples: Sample[];
  rawSamples: Sample[];
}
interface RelayState { key: string; address: string; label: string; value: boolean; changedAt: number | null; }
interface RelayEvent { timestamp: number; stageId: StageId; key: string; address: string; label: string; before: boolean | null; value: boolean; }
type DetectorScalarKey = 'probe1' | 'probe2' | 'probe3' | 'probe4' | 'probe1Absolute' | 'probe2Absolute' | 'probe3Absolute' | 'probe4Absolute' | 'probe1Fluctuation' | 'probe2Fluctuation' | 'probe3Fluctuation' | 'probe4Fluctuation' | 'snr21' | 'snr23' | 'snr31' | 'sensitivity';
interface DetectorObservation {
  timestamp: number;
  stageId: StageId;
  index: number;
  address: number;
  online: boolean;
  fire: boolean;
  fault: boolean;
  sourceReady: boolean;
  syncOk: boolean;
  probe1: number | null;
  probe2: number | null;
  probe3: number | null;
  probe4: number | null;
  probe1Absolute: number | null;
  probe2Absolute: number | null;
  probe3Absolute: number | null;
  probe4Absolute: number | null;
  probe1Fluctuation: number | null;
  probe2Fluctuation: number | null;
  probe3Fluctuation: number | null;
  probe4Fluctuation: number | null;
  snr21: number | null;
  snr23: number | null;
  snr31: number | null;
  sensitivity: number | null;
  sendMode: number | null;
}
interface DetectorValueStats { count: number; min: number; max: number; mean: number; last: number; }
interface DetectorStageSummary {
  index: number;
  address: number;
  observationCount: number;
  retainedObservationCount: number;
  firstAt: number | null;
  lastAt: number | null;
  onlineCount: number;
  offlineCount: number;
  fireCount: number;
  faultCount: number;
  sourceNotReadyCount: number;
  syncNotOkCount: number;
  latest: DetectorObservation | null;
  stats: Partial<Record<DetectorScalarKey, DetectorValueStats>>;
}
interface StageRecord {
  sequence: number;
  stageId: StageId;
  label: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  plannedDurationMs: number | null;
  durationDeltaMs: number | null;
  withinPlan: boolean | null;
  status: string;
  relaySnapshot: RelayState[];
  relayEventCount: number;
  waveforms: UnitWaveform[];
  detectorObservations: DetectorObservation[];
  detectors: DetectorStageSummary[];
  decisionBasis: string[];
}
interface Decision { verdict: string | null; grade: string | null; reasons: string[]; basis: string[]; evaluatedAt: number | null; }
interface Run {
  runId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  currentStage: StageId;
  stages: StageRecord[];
  relayEvents: RelayEvent[];
  latestRelayOutputs: RelayState[];
  decision: Decision;
  evidence: {
    process: ProcessStatus | null;
    detectorState?: { units?: Array<{ index: number; address: number; online: boolean; fault: boolean; probe1: number; probe2: number; probe3: number; probe4?: number; }> } | null;
    waveformAnalysis?: any;
    detectorVerdict?: any;
    finalVerdict?: any;
  };
}
interface ArchiveDetail extends Run {
  archivedAt: number;
  reportFile: string;
}
interface Snapshot {
  updatedAt: number;
  source: { formalBackendUrl: string; connected: boolean; lastSeenAt: number | null; lastError: string | null; lastPollAt: number | null };
  plan: Array<{ id: StageId; label: string; plannedDurationMs: number | null; planBasis?: string }>;
  currentRun: Run | null;
  lastProcess: ProcessStatus | null;
  lastSummary: any;
}
interface PlanStage { id: StageId; label: string; plannedDurationMs: number | null; planBasis?: string; }
interface PLCStep { id: string; name: string; durationMs: number | null; waitTimeMs: number | null; totalDurationMs: number | null; }
interface TestProgramConfig { mode: string; source: string; plan: PlanStage[]; planSource: string; planUpdatedAt: number | null; plcSteps: PLCStep[]; plcConfigUpdatedAt: number | null; note: string; }
interface ArchiveItem {
  runId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  verdict: string | null;
  grade: string | null;
  stageCount: number;
  completedStageCount: number;
  waveformSampleCount: number;
  detectorObservationCount: number;
  relayEventCount: number;
  archivedAt: number;
  reportFile: string;
  detailFile: string;
}

const STAGE_ORDER: StageId[] = ['INIT', 'HEAT_POSITIONING', 'HEAT_SIGNAL_STABILIZATION', 'HEAT_NOISE_CAPTURE', 'HEAT_INTERFERENCE', 'FLASH', 'EMC', 'RETURN_HOME', 'COMPLETE'];
const CHANNELS = [
  ['probe1', 'P1', '#4cd5ef'],
  ['probe2', 'P2', '#62e7b1'],
  ['probe3', 'P3', '#f1ca68'],
  ['probe4', 'P4', '#ff8a77'],
] as const;
const DETECTOR_VALUE_COLUMNS: Array<{ key: DetectorScalarKey; label: string }> = [
  { key: 'probe1', label: 'P1' },
  { key: 'probe2', label: 'P2' },
  { key: 'probe3', label: 'P3' },
  { key: 'probe4', label: 'P4' },
  { key: 'probe1Absolute', label: '绝对 P1' },
  { key: 'probe2Absolute', label: '绝对 P2' },
  { key: 'probe3Absolute', label: '绝对 P3' },
  { key: 'probe4Absolute', label: '绝对 P4' },
  { key: 'probe1Fluctuation', label: '波动 P1' },
  { key: 'probe2Fluctuation', label: '波动 P2' },
  { key: 'probe3Fluctuation', label: '波动 P3' },
  { key: 'probe4Fluctuation', label: '波动 P4' },
  { key: 'snr21', label: 'SNR21' },
  { key: 'snr23', label: 'SNR23' },
  { key: 'snr31', label: 'SNR31' },
  { key: 'sensitivity', label: '灵敏度' },
];

const emptySnapshot: Snapshot = {
  updatedAt: 0,
  source: { formalBackendUrl: 'http://127.0.0.1:3003', connected: false, lastSeenAt: null, lastError: null, lastPollAt: null },
  plan: [],
  currentRun: null,
  lastProcess: null,
  lastSummary: null,
};

function apiUrl(): string {
  const runtime = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
  return import.meta.env.VITE_TEST_PROGRAM_API_URL || runtime?.backendHttpUrl || `http://${window.location.hostname}:3004`;
}

function wsUrl(): string {
  const value = import.meta.env.VITE_TEST_PROGRAM_WS_URL;
  const runtime = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
  return value || runtime?.backendWsUrl || `${apiUrl().replace(/^http/i, 'ws')}`;
}

function timeText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '-';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function dateText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function durationText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${(value / 1000).toFixed(2)} s`;
}

function numberText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '-';
}

function statusText(status: string): string {
  return status === 'COMPLETED' ? '已完成' : status === 'ABORTED' ? '已中止' : status === 'RUNNING' ? '进行中' : status;
}

function verdictText(verdict: string | null | undefined): string {
  return verdict === 'PASS' ? '合格' : verdict === 'FAIL' ? '不合格' : verdict === 'PENDING' ? '待判定' : verdict || '未判定';
}

function reportFormatText(reportFile: string): string {
  return reportFile.toLowerCase().endsWith('.html') ? 'HTML' : '历史 Markdown';
}

const DECISION_TEXT: Record<string, string> = {
  WAITING_FOR_PROCESS_START: '等待工序开始',
  WAITING_FOR_PLC_COMPLETE: '等待 PLC 流程完成',
  PLC_PROCESS_STATUS_INVALID: 'PLC 工序状态无效',
  WAITING_FOR_WAVEFORM_ANALYSIS: '等待波形分析完成',
  WAITING_FOR_QUANTITATIVE_DATA: '等待定量数据',
  WAITING_FOR_STAGE_SAMPLES: '等待当前工序采样',
  WAITING_FOR_INTERFERENCE_SAMPLES: '等待热源干扰采样',
  WAITING_FOR_NOISE_SAMPLES: '等待噪声采样',
  WAITING_FOR_NOISE_WINDOW_COMPLETE: '等待噪声采集窗口结束',
  WAITING_FOR_PROCESS_COMPLETE: '等待工序完成',
  STAGE_WITHIN_LIMIT: '工序指标正常',
  NOISE_WITHIN_LIMIT: '噪声指标正常',
  NOISE_SAMPLES_MISSING: '缺少噪声样本',
  NOISE_RMS_MISSING: '缺少噪声波动值',
  NOISE_RMS_BELOW_LIMIT: '噪声波动值低于下限',
  NOISE_RMS_EXCEEDS_LIMIT: '噪声 RMS 超过上限',
  NOISE_ABSOLUTE_MISSING: '缺少噪声绝对值',
  NOISE_ABSOLUTE_EXCEEDS_LIMIT: '噪声绝对值超过上限',
  INTERFERENCE_RATIO_MISSING: '缺少干扰比',
  INTERFERENCE_RATIO_EXCEEDS_LIMIT: '干扰比超过上限',
  CONSISTENCY_TREND_BELOW_LIMIT: '一致性趋势低于下限',
  SENSITIVITY_BELOW_LIMIT: '灵敏度低于下限',
  SNR21_BELOW_LIMIT: 'P2/P1 信噪比低于下限',
  SNR21_ABOVE_LIMIT: 'P2/P1 信噪比高于上限',
  SNR23_BELOW_LIMIT: 'P2/P3 信噪比低于下限',
  SNR23_ABOVE_LIMIT: 'P2/P3 信噪比高于上限',
  SNR31_BELOW_LIMIT: 'P3/P1 信噪比低于下限',
  SNR31_ABOVE_LIMIT: 'P3/P1 信噪比高于上限',
  DETECTOR_OFFLINE: '探测器离线',
  DETECTOR_FAULT: '探测器故障',
  DETECTOR_STARTUP_FAILED: '探测器启动失败',
  DETECTOR_STARTUP_TIMEOUT: '探测器启动超时',
  MODE_SWITCH_TIMEOUT: '模式切换等待 ACK 超时',
  SIGNAL_NOT_READY: '光源未就绪',
  SYNC_NOT_OK: '同步异常',
  FLASH_SAMPLES_MISSING: '爆闪干扰样本不足',
  EMC_SAMPLES_MISSING: '电磁干扰样本不足',
  HEAT_SAMPLES_MISSING: '热源干扰样本不足',
  ALL_STAGES_A_GRADE_WITHIN_LIMIT: '全部工序达到 A 级指标',
  FLASH_SNR23_ABOVE_LIMIT: '爆闪阶段 P2/P3 信噪比超过上限',
  NOISE: '噪声采集',
  INTERFERENCE: '干扰采集',
  A_PASS: 'A级合格',
  B_PASS: 'B级合格',
  INIT: '初始化',
  HEAT_POSITIONING: '热源定位/阶段过渡',
  HEAT_SIGNAL_STABILIZATION: '热源信号稳定',
  HEAT_NOISE_CAPTURE: '热源噪声采集',
  HEAT_INTERFERENCE: '热源干扰采集',
  FLASH: '爆闪干扰',
  EMC: '电磁干扰',
  RETURN_HOME: '回初始位确认',
  COMPLETE: '已完成',
  FAULT: '故障/中止',
  UNKNOWN: '未知工序',
  PASS: '合格',
  FAIL: '不合格',
  PENDING: '待判定',
};

function decisionText(value: string | null | undefined): string {
  const source = String(value ?? '').trim();
  if (!source) return '-';
  let translated = source;
  Object.entries(DECISION_TEXT)
    .sort(([left], [right]) => right.length - left.length)
    .forEach(([code, label]) => { translated = translated.replaceAll(code, label); });
  return translated.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, '未映射的判定条件');
}

function gradeText(grade: string | null | undefined): string {
  if (!grade) return '-';
  return DECISION_TEXT[grade] ?? grade.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, '未映射等级');
}

function stageClass(stage: StageRecord, current: StageId): string {
  return `stage-row ${stage.status === 'COMPLETED' ? 'is-done' : ''} ${stage.stageId === current ? 'is-current' : ''} ${stage.status === 'ABORTED' ? 'is-aborted' : ''}`;
}

function planText(value: number | null): string {
  return value === null ? '未配置' : durationText(value);
}

function deviationText(value: number | null): string {
  if (value === null) return '-';
  return `${value >= 0 ? '+' : '-'}${durationText(Math.abs(value))}`;
}

function detectorRangeText(summary: DetectorStageSummary, key: DetectorScalarKey): string {
  const stats = summary.stats?.[key];
  return stats ? `${numberText(stats.min)} ~ ${numberText(stats.max)}` : '-';
}

function detectorStateText(summary: DetectorStageSummary): string {
  const latest = summary.latest;
  if (!latest) return '尚无最新状态';
  return [
    latest.online ? '在线' : '离线',
    latest.fault ? '故障' : '无故障',
    latest.sourceReady ? '光源就绪' : '光源未就绪',
    latest.syncOk ? '同步正常' : '同步异常',
    `模式 ${numberText(latest.sendMode)}`,
  ].join(' · ');
}

function WaveformPlot({ waveform }: { waveform: UnitWaveform | undefined }) {
  const chart = useMemo(() => {
    const samples = waveform?.samples?.slice(-260) ?? [];
    const values = CHANNELS.flatMap(([key]) => samples.map((sample) => Number(sample[key])).filter(Number.isFinite));
    if (samples.length < 2 || values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const paths = CHANNELS.map(([key, label, color]) => {
      const points = samples.map((sample, index) => {
        const value = Number(sample[key]);
        if (!Number.isFinite(value)) return null;
        const x = 5 + (index / Math.max(1, samples.length - 1)) * 290;
        const y = 8 + (1 - (value - min) / span) * 104;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).filter((point): point is string => Boolean(point));
      return { label, color, path: points.join(' ') };
    }).filter((path) => path.path);
    return { min, max, paths };
  }, [waveform]);

  if (!chart) return <div className="test-wave-empty">该阶段尚未收到足够波形样本</div>;
  return (
    <div className="test-wave-shell">
      <svg viewBox="0 0 300 120" role="img" aria-label="阶段波形">
        {[28, 54, 80, 106].map((y) => <line key={y} x1="5" x2="295" y1={y} y2={y} className="test-wave-grid" />)}
        {chart.paths.map((path) => <polyline key={path.label} points={path.path} fill="none" stroke={path.color} strokeWidth="1.2" />)}
      </svg>
      <div className="test-wave-scale"><span>max {numberText(chart.max)}</span><span>min {numberText(chart.min)}</span></div>
      <div className="test-wave-legend">{chart.paths.map((path) => <span key={path.label}><i style={{ background: path.color }} />{path.label}</span>)}</div>
    </div>
  );
}

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className={`test-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

export function TestProgramApp() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [archives, setArchives] = useState<ArchiveItem[]>([]);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);
  const [selectedArchive, setSelectedArchive] = useState<ArchiveDetail | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState('正在连接正式程序状态源…');
  const [selectedStageSequence, setSelectedStageSequence] = useState<number | null>(null);
  const [selectedUnit, setSelectedUnit] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState<PlanStage[]>([]);
  const [plcSteps, setPlcSteps] = useState<PLCStep[]>([]);
  const [planSource, setPlanSource] = useState('DEFAULT');
  const [planUpdatedAt, setPlanUpdatedAt] = useState<number | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [relayExpanded, setRelayExpanded] = useState(false);
  const [decisionExpanded, setDecisionExpanded] = useState(false);

  const loadSnapshot = useCallback(async () => {
    const response = await fetch(`${apiUrl()}/api/test-program/snapshot`);
    if (!response.ok) throw new Error(`测试观察器读取失败 (${response.status})`);
    setSnapshot(await response.json() as Snapshot);
  }, []);

  const loadArchives = useCallback(async () => {
    const response = await fetch(`${apiUrl()}/api/test-program/archives?limit=200`);
    if (!response.ok) return;
    const payload = await response.json() as { items?: ArchiveItem[] };
    setArchives(payload.items ?? []);
  }, []);

  const loadConfig = useCallback(async () => {
    const response = await fetch(`${apiUrl()}/api/test-program/config`);
    if (!response.ok) throw new Error(`规划配置读取失败 (${response.status})`);
    const payload = await response.json() as TestProgramConfig;
    setPlanDraft(payload.plan ?? []);
    setPlcSteps(payload.plcSteps ?? []);
    setPlanSource(payload.planSource ?? 'DEFAULT');
    setPlanUpdatedAt(payload.planUpdatedAt ?? null);
    return payload;
  }, []);

  const saveConfig = async () => {
    setSettingsSaving(true);
    setSettingsNotice('正在保存测试观察器规划…');
    try {
      const response = await fetch(`${apiUrl()}/api/test-program/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: planDraft }),
      });
      const payload = await response.json() as Partial<TestProgramConfig> & { error?: string };
      if (!response.ok) throw new Error(payload.error || `规划配置保存失败 (${response.status})`);
      setPlanDraft(payload.plan ?? planDraft);
      setPlanSource(payload.planSource ?? 'LOCAL_OVERRIDE');
      setPlanUpdatedAt(payload.planUpdatedAt ?? Date.now());
      setSnapshot((current) => ({ ...current, plan: payload.plan ?? current.plan }));
      setSettingsNotice('已保存；新的规划时长将在下一轮测试中生效。');
      setNotice('测试观察器规划已更新；正式 PLC 配置未被写入');
    } catch (error) {
      setSettingsNotice(error instanceof Error ? error.message : '规划配置保存失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    const connect = () => {
      if (disposed) return;
      try {
        socket = new WebSocket(wsUrl());
        socket.onopen = () => { setConnected(true); setNotice('测试观察器已连接；只读旁路监听中'); };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as { type: string; payload?: unknown };
            if (message.type === 'test_snapshot') setSnapshot(message.payload as Snapshot);
            if (message.type === 'test_source_error') setNotice(`正式状态源：${(message.payload as { error?: string })?.error || '连接异常'}`);
          } catch { setNotice('测试观察器消息解析失败'); }
        };
        socket.onerror = () => setNotice('测试观察器 WebSocket 异常，正在重连…');
        socket.onclose = () => {
          setConnected(false);
          if (!disposed) reconnect = setTimeout(connect, 2_000);
        };
      } catch {
        reconnect = setTimeout(connect, 2_000);
      }
    };
    void loadSnapshot().catch((error) => setNotice(error instanceof Error ? error.message : '无法读取测试观察器'));
    void loadConfig().catch((error) => setSettingsNotice(error instanceof Error ? error.message : '无法读取规划配置'));
    void loadArchives();
    const archivePoll = setInterval(() => { void loadArchives(); }, 5_000);
    connect();
    return () => {
      disposed = true;
      if (reconnect) clearTimeout(reconnect);
      clearInterval(archivePoll);
      socket?.close();
    };
  }, [loadArchives, loadConfig, loadSnapshot]);

  useEffect(() => {
    if (archives.length === 0) {
      setSelectedArchiveId(null);
      return;
    }
    if (!selectedArchiveId || !archives.some((item) => item.runId === selectedArchiveId)) {
      setSelectedArchiveId(archives[0].runId);
    }
  }, [archives, selectedArchiveId]);

  useEffect(() => {
    if (!selectedArchiveId) {
      setSelectedArchive(null);
      setArchiveLoading(false);
      setArchiveError('');
      return;
    }
    const controller = new AbortController();
    setArchiveLoading(true);
    setArchiveError('');
    fetch(`${apiUrl()}/api/test-program/archives/${encodeURIComponent(selectedArchiveId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`历史测试读取失败 (${response.status})`);
        return await response.json() as ArchiveDetail;
      })
      .then((detail) => setSelectedArchive(detail))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSelectedArchive(null);
        setArchiveError(error instanceof Error ? error.message : '历史测试读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setArchiveLoading(false);
      });
    return () => controller.abort();
  }, [selectedArchiveId]);

  const run = snapshot?.currentRun ?? null;
  const process = snapshot?.lastProcess ?? run?.evidence?.process ?? null;
  const stages = run?.stages ?? [];
  const selectedStage = stages.find((stage) => stage.sequence === selectedStageSequence)
    ?? stages[stages.length - 1]
    ?? null;
  const selectedWaveform = selectedStage?.waveforms?.find((waveform) => waveform?.index === selectedUnit)
    ?? selectedStage?.waveforms?.[0];
  const detectorSummaries = selectedStage?.detectors ?? [];
  const detectorObservationCount = stages.reduce((total, stage) => total + (stage?.detectors ?? []).reduce((sum, detector) => sum + (detector?.observationCount ?? 0), 0), 0);
  const finalVerdict = run?.decision?.verdict ?? run?.evidence?.finalVerdict?.verdict ?? null;
  const verdictTone = finalVerdict === 'PASS' ? 'pass' : finalVerdict === 'FAIL' ? 'fail' : 'pending';
  const currentOutputs = run?.latestRelayOutputs ?? [];
  const currentHeatStage = selectedStage?.stageId === 'HEAT_SIGNAL_STABILIZATION' || selectedStage?.stageId === 'HEAT_NOISE_CAPTURE' || selectedStage?.stageId === 'HEAT_INTERFERENCE';
  const outputOnCount = currentOutputs.filter((output) => output?.value).length;
  const waveformAnalysis = run?.evidence?.waveformAnalysis ?? snapshot?.lastSummary?.waveformAnalysis;
  const detectorVerdict = run?.evidence?.detectorVerdict ?? snapshot?.lastSummary?.detectorVerdict;
  const units = detectorVerdict?.units ?? [];
  const threshold = waveformAnalysis?.thresholds;
  const selectedArchiveDetectorRows = useMemo(
    () => selectedArchive?.stages?.flatMap((stage) => (stage?.detectors ?? []).map((detector) => ({ stage, detector }))) ?? [],
    [selectedArchive],
  );
  const selectedArchiveFinalVerdict = selectedArchive?.decision?.verdict ?? selectedArchive?.evidence?.finalVerdict?.verdict ?? null;
  const selectedArchiveVerdictTone = selectedArchiveFinalVerdict === 'PASS' ? 'pass' : selectedArchiveFinalVerdict === 'FAIL' ? 'fail' : 'pending';

  useEffect(() => {
    if (selectedStage && selectedStageSequence !== selectedStage.sequence) setSelectedStageSequence(selectedStage.sequence);
    if (selectedStage && selectedStage.waveforms?.length && !selectedStage.waveforms.some((item) => item?.index === selectedUnit)) setSelectedUnit(selectedStage.waveforms[0].index);
  }, [selectedStage, selectedStageSequence, selectedUnit]);

  const openSettings = () => {
    setSettingsOpen(true);
    setSettingsNotice('正在读取当前 PLC 步骤参考…');
    void loadConfig()
      .then(() => setSettingsNotice('规划只保存到测试观察器；保存后下一轮测试生效。'))
      .catch((error) => setSettingsNotice(error instanceof Error ? error.message : '规划配置读取失败'));
  };

  const updatePlanDuration = (id: StageId, value: string) => {
    const plannedDurationMs = value.trim() === '' ? null : Math.max(0, Number(value) * 1_000);
    setPlanDraft((current) => current.map((stage) => stage.id === id
      ? { ...stage, plannedDurationMs: Number.isFinite(plannedDurationMs as number) ? plannedDurationMs : null }
      : stage));
  };

  const refresh = async () => {
    try {
      await Promise.all([loadSnapshot(), loadArchives()]);
      setNotice('已刷新测试快照和归档列表');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '刷新失败');
    }
  };

  return (
    <main className="test-program-screen">
      <header className="test-program-header">
        <div className="test-program-title">
          <div className="test-program-mark"><Activity size={24} /></div>
          <div><span className="test-kicker">TEST PROGRAM / READ-ONLY OBSERVER</span><h1>工序测试监听与数据归档</h1><p>独立旁路观察器 · 不写 PLC · 不控制探测器 · 为工序优化和算法回放保留证据</p></div>
        </div>
        <div className="test-header-actions">
          <span className={`test-connection ${connected && snapshot?.source?.connected ? 'is-online' : ''}`}><i />{connected && snapshot?.source?.connected ? '监听在线' : '等待正式程序'}</span>
          <button type="button" className="test-settings-button" aria-label="配置规划时长" onClick={openSettings}><Settings2 size={14} />规划配置</button>
          <button type="button" onClick={() => void refresh()}><RefreshCw size={14} />刷新</button>
        </div>
      </header>

      <section className="test-source-strip">
        <div><span>正式状态源</span><strong>{snapshot?.source?.formalBackendUrl || 'http://127.0.0.1:3003'}</strong></div>
        <div><span>当前批次</span><strong>{run?.runId ?? '尚未识别到运行批次'}</strong></div>
        <div><span>最近状态</span><strong>{dateText(snapshot?.source?.lastSeenAt)}</strong></div>
        <div className="test-source-safety"><ShieldCheck size={15} />仅接收状态，不发送控制命令</div>
      </section>
      {snapshot?.source?.lastError && <div className="test-notice is-warning"><CircleAlert size={15} />{snapshot.source.lastError}</div>}
      <div className="test-notice"><Wifi size={15} />{notice}</div>

      <section className="test-metric-grid">
        <Metric label="当前工序" value={selectedStage?.label ?? process?.processLabel ?? '待机'} />
        <Metric label="本轮耗时" value={durationText(run?.durationMs ?? (run ? Date.now() - run.startedAt : null))} tone={run?.status === 'RUNNING' ? 'active' : ''} />
        <Metric label="继电器 ON" value={`${outputOnCount} / ${currentOutputs.length || 9}`} />
        <Metric label="探测器观测" value={`${detectorObservationCount}`} />
        <Metric label="当前判定" value={verdictText(finalVerdict)} tone={verdictTone} />
      </section>

      <section className="test-panel test-stage-panel">
        <header className="test-panel-heading"><div><span className="test-kicker">01 / PROCESS TIMELINE</span><h2>工序阶段时序表</h2><p>热源阶段已拆分为信号稳定、噪声采集、热源干扰采集三行，规划时长未配置时只统计不判定。</p></div><span className="test-stage-live">{run ? statusText(run.status) : '等待开始'}</span></header>
        <div className="test-table-wrap">
          <table className="test-table"><thead><tr><th>#</th><th>阶段</th><th>开始</th><th>结束</th><th>实际时长</th><th>规划时长</th><th>偏差</th><th>计划判断</th><th>继电器</th><th>波形样本</th><th>探测器观测</th><th>依据</th></tr></thead><tbody>
            {stages.length === 0 && <tr><td colSpan={12} className="test-empty-cell">正式程序开始自动工序后，这里将按状态转换生成阶段记录</td></tr>}
            {stages.map((stage) => <tr key={`${stage.sequence}-${stage.stageId}`} className={stageClass(stage, run?.currentStage ?? 'UNKNOWN')} onClick={() => setSelectedStageSequence(stage.sequence)}>
              <td>{stage.sequence}</td><td><b>{stage.label}</b><small>{decisionText(stage.stageId)}</small></td><td>{timeText(stage.startedAt)}</td><td>{timeText(stage.endedAt)}</td><td>{durationText(stage.durationMs ?? (stage.stageId === run?.currentStage ? Date.now() - stage.startedAt : null))}</td><td>{planText(stage.plannedDurationMs)}</td><td className={stage.durationDeltaMs && stage.durationDeltaMs > 0 ? 'is-over' : ''}>{deviationText(stage.durationDeltaMs)}</td><td>{stage.withinPlan === null ? '仅统计' : stage.withinPlan ? '在计划内' : '超计划'}</td><td>{stage.relayEventCount}</td><td>{(stage.waveforms ?? []).reduce((total, waveform) => total + (waveform?.sampleCount ?? 0), 0)}</td><td>{(stage.detectors ?? []).reduce((total, detector) => total + (detector?.observationCount ?? 0), 0)}</td><td className="basis-cell"><div className="test-basis-scroll">{(stage.decisionBasis ?? []).map(decisionText).join('；') || '-'}</div></td>
            </tr>)}
          </tbody></table>
        </div>
      </section>

      <div className="test-two-column">
        <section className={`test-panel test-relay-panel ${relayExpanded ? 'is-expanded' : ''}`}>
          <header className="test-panel-heading compact"><div><span className="test-kicker">02 / RELAY OUTPUTS</span><h2>继电器输出状态</h2><p>记录每个 Q 点的当前值、地址、所属阶段和变化次数。</p></div><strong className="test-count-badge">{run?.relayEvents?.length ?? 0} EVENTS</strong></header>
          <div className="test-relay-grid">{currentOutputs.length === 0 && <div className="test-empty-cell">尚未收到 PLC 输出映射</div>}{currentOutputs.map((relay) => <div key={relay.key} className={`test-relay-card ${relay?.value ? 'is-on' : ''}`}><div><b>{relay?.address}</b><span>{relay?.label}</span></div><strong>{relay?.value ? 'ON' : 'OFF'}</strong><small>{relay?.changedAt ? `最近 ${timeText(relay.changedAt)}` : '未变化'}</small></div>)}</div>
          <div className="test-subheading"><div><b>变化事件</b><span>{relayExpanded ? '显示本轮全部事件' : '滚动查看最近 16 条'}</span></div><button type="button" className="test-inline-toggle" onClick={() => setRelayExpanded((value) => !value)}>{relayExpanded ? <><ChevronUp size={13} />收起</> : <><ChevronDown size={13} />展开全部</>}</button></div>
          <div className="test-event-list">{(relayExpanded ? (run?.relayEvents ?? []) : (run?.relayEvents ?? []).slice(-16)).slice().reverse().map((event, index) => <div key={`${event.timestamp}-${event.address}-${index}`}><time>{timeText(event.timestamp)}</time><b>{event.address}</b><span>{event.label}</span><em>{event.before === null ? '-' : event.before ? 'ON' : 'OFF'} → {event.value ? 'ON' : 'OFF'}</em><small>{decisionText(event.stageId)}</small></div>)}{!(run?.relayEvents?.length) && <div className="test-empty-cell">本轮尚未产生继电器变化事件</div>}</div>
        </section>

        <section className={`test-panel test-decision-panel ${decisionExpanded ? 'is-expanded' : ''}`}>
          <header className="test-panel-heading compact"><div><span className="test-kicker">03 / DECISION EVIDENCE</span><h2>数据判断依据</h2><p>保留正式程序的波形分析、阈值和探测器判定，不在测试程序内重写结论。</p></div><div className="test-decision-actions"><div className={`test-verdict-chip ${verdictTone}`}>{verdictText(finalVerdict)}</div><button type="button" className="test-inline-toggle" onClick={() => setDecisionExpanded((value) => !value)}>{decisionExpanded ? <><ChevronUp size={13} />收起详细</> : <><ChevronDown size={13} />展开全部</>}</button></div></header>
          <div className="test-decision-scroll">
            <div className="test-decision-main"><div className={`test-verdict-mark ${verdictTone}`}>{finalVerdict === 'PASS' ? <CheckCircle2 size={26} /> : <CircleAlert size={26} />}</div><div><strong>{gradeText(run?.decision?.grade ?? run?.evidence?.finalVerdict?.grade) || '等待完成'}</strong><span>{run?.decision?.evaluatedAt ? `评估于 ${dateText(run.decision.evaluatedAt)}` : '正式工序完成后生成最终判断'}</span></div></div>
            <div className="test-evidence-list"><h3>原因</h3>{(run?.decision?.reasons ?? []).map((reason, index) => <div key={`${reason}-${index}`}><i />{decisionText(reason)}</div>)}{!(run?.decision?.reasons?.length) && <div className="test-muted">暂未收到失败原因或正式判定说明</div>}<h3>依据摘要</h3>{(run?.decision?.basis ?? []).map((basis, index) => <div key={`${basis}-${index}`}><i />{decisionText(basis)}</div>)}{!(run?.decision?.basis?.length) && <div className="test-muted">待正式分析快照</div>}</div>
            {threshold && <div className="test-threshold-box"><b>随批次保存的阈值</b><span>噪声 RMS ≤ {threshold.maxNoiseRms ?? '-'} · 噪声绝对值 ≤ {threshold.maxNoiseAbsolute ?? '-'} · 干扰比 ≤ {threshold.maxInterferenceRatio ?? '-'}</span><span>最小噪声样本 {threshold.minNoiseSamples ?? '-'} · 最小干扰样本 {threshold.minInterferenceSamples ?? '-'}</span></div>}
            {units.length > 0 && <div className="test-unit-verdicts">{units.map((unit: any) => <div key={unit.index}><b>设备 {unit.index}</b><span>{verdictText(unit.verdict)} / {gradeText(unit.grade)}</span><small>{decisionText(unit.reason ?? '无附加原因')} · RMS {numberText(unit.metrics?.noiseRms)} · 干扰比 {numberText(unit.metrics?.interferenceRatio)}</small></div>)}</div>}
          </div>
        </section>
      </div>

      <section className="test-panel test-detector-panel">
        <header className="test-panel-heading"><div><span className="test-kicker">04 / DETECTOR VALUES BY STAGE</span><h2>分阶段探测器数值</h2><p>点击上方阶段行切换；每个单元显示该阶段最新值，下面的小字为该阶段已记录数据的最小值 ~ 最大值。详细有界时序保存在归档 JSON。</p></div><strong className="test-count-badge">{detectorSummaries.reduce((total, detector) => total + detector.observationCount, 0)} OBSERVATIONS</strong></header>
        <div className="test-table-wrap">
          <table className="test-table detector-values-table"><thead><tr><th>设备/地址</th><th>观测/保留</th><th>最后采样</th>{DETECTOR_VALUE_COLUMNS.map((column) => <th key={column.key}>{column.label}</th>)}<th>状态与计数</th></tr></thead><tbody>
            {detectorSummaries.length === 0 && <tr><td colSpan={3 + DETECTOR_VALUE_COLUMNS.length + 1} className="test-empty-cell">当前阶段尚未收到探测器标量值</td></tr>}
            {detectorSummaries.map((detector) => <tr key={`${selectedStage?.sequence}-${detector.index}`}>
              <td><b>设备 {detector.index}</b><small>地址 {detector.address}</small></td>
              <td><b>{detector.observationCount}</b><small>保留 {detector.retainedObservationCount}</small></td>
              <td>{timeText(detector.lastAt)}</td>
              {DETECTOR_VALUE_COLUMNS.map((column) => <td key={column.key} className="detector-value-cell"><b>{numberText(detector.latest?.[column.key])}</b><small>{detectorRangeText(detector, column.key)}</small></td>)}
              <td className="detector-state-cell"><b>{detector.latest?.online ? '在线' : '离线'}</b><small>{detectorStateText(detector)}</small><em>在线 {detector.onlineCount} · 故障 {detector.faultCount} · 火警 {detector.fireCount}</em></td>
            </tr>)}
          </tbody></table>
        </div>
      </section>

      <section className="test-panel test-wave-panel">
        <header className="test-panel-heading"><div><span className="test-kicker">05 / WAVEFORM BY STAGE</span><h2>分阶段波形数据</h2><p>处理波形与原始波形均按设备、阶段保存；点击上方阶段行切换查看。</p></div><div className="test-selects"><label>阶段<select value={selectedStage?.sequence ?? ''} onChange={(event) => setSelectedStageSequence(Number(event.target.value))}>{stages.map((stage) => <option key={stage.sequence} value={stage.sequence}>{stage.sequence}. {stage.label}</option>)}</select></label><label>设备<select value={selectedUnit} onChange={(event) => setSelectedUnit(Number(event.target.value))}>{(selectedStage?.waveforms ?? []).map((waveform) => <option key={waveform.index} value={waveform.index}>设备 {waveform.index} / 地址 {waveform.address}</option>)}{!(selectedStage?.waveforms.length) && <option value={1}>暂无设备波形</option>}</select></label></div></header>
        <div className="test-wave-layout"><div className="test-wave-chart"><div className="test-wave-title"><b>{selectedStage?.label ?? '待选择阶段'}</b><span>{selectedWaveform ? `设备 ${selectedWaveform.index} · ${selectedWaveform.sampleCount} 个处理样本 / ${selectedWaveform.rawSampleCount} 个原始样本` : '暂无阶段样本'}</span></div><WaveformPlot waveform={selectedWaveform} /></div><div className="test-wave-details"><div className="test-wave-cards">{CHANNELS.map(([key, label]) => { const stats = selectedWaveform?.channels?.[key]; return <div key={key}><span>{label}</span><b>{numberText(stats?.mean)}</b><small>RMS {numberText(stats?.rms)} · P-P {numberText(stats?.peakToPeak)}</small></div>; })}</div><div className="test-wave-meta"><span>采样开始 <b>{timeText(selectedWaveform?.firstAt)}</b></span><span>采样结束 <b>{timeText(selectedWaveform?.lastAt)}</b></span><span>当前热源拆分 <b>{currentHeatStage ? selectedStage?.label : '非热源阶段'}</b></span></div></div></div>
      </section>

      <section className="test-panel test-archive-panel">
        <header className="test-panel-heading"><div><span className="test-kicker">06 / ARCHIVE HISTORY</span><h2>历史测试归档</h2><p>每次 COMPLETE 或中止都会生成本地 JSON 原始数据、HTML 测试报告和一行精简 log；点击行或使用右侧选择器查看任意一轮。</p></div><div className="test-archive-controls">{archives.length > 0 && <label>选择测试<select value={selectedArchiveId ?? ''} onChange={(event) => setSelectedArchiveId(event.target.value)}>{archives.map((item) => <option key={item.runId} value={item.runId}>{dateText(item.startedAt)} · {item.runId} · {verdictText(item.verdict)}</option>)}</select></label>}<span className="test-count-badge">{archiveLoading ? 'LOADING' : `${archives.length} RUNS`}</span><Archive size={19} /></div></header>
        <div className="test-table-wrap"><table className="test-table archive-table"><thead><tr><th>测试批次</th><th>开始</th><th>耗时</th><th>结果</th><th>阶段</th><th>继电器事件</th><th>探测器观测</th><th>波形样本</th><th>查看</th><th>报告</th></tr></thead><tbody>{archives.length === 0 && <tr><td colSpan={10} className="test-empty-cell">尚无已归档测试；完成一轮正式工序后自动出现</td></tr>}{archives.map((item) => <tr key={item.runId} className={selectedArchiveId === item.runId ? 'is-selected' : ''} onClick={() => setSelectedArchiveId(item.runId)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedArchiveId(item.runId); } }} tabIndex={0} aria-selected={selectedArchiveId === item.runId}><td><b>{item.runId}</b><small>{statusText(item.status)}</small></td><td>{dateText(item.startedAt)}</td><td>{durationText(item.durationMs)}</td><td><span className={`archive-result ${item.verdict === 'PASS' ? 'pass' : item.verdict === 'FAIL' ? 'fail' : ''}`}>{verdictText(item.verdict)} {item.grade ? `· ${gradeText(item.grade)}` : ''}</span></td><td>{item.completedStageCount} / {item.stageCount}</td><td>{item.relayEventCount}</td><td>{item.detectorObservationCount}</td><td>{item.waveformSampleCount}</td><td className="archive-select-cell">{selectedArchiveId === item.runId ? '已选' : '查看详情'}</td><td><a onClick={(event) => event.stopPropagation()} href={`${apiUrl()}/api/test-program/archives/${encodeURIComponent(item.runId)}/report`} target="_blank" rel="noreferrer"><Download size={13} />{reportFormatText(item.reportFile)}</a></td></tr>)}</tbody></table></div>
        {archiveError && <div className="test-notice is-warning archive-inline-notice"><CircleAlert size={14} />{archiveError}</div>}
        {!selectedArchive && !archiveError && archives.length > 0 && <div className="archive-loading-note">{archiveLoading ? '正在读取所选测试的详细归档…' : '选择一行测试后显示详细数据'}</div>}
        {selectedArchive && <div className="archive-detail-shell">
          <header className="archive-detail-heading"><div><span className="test-kicker">07 / SELECTED TEST DETAIL</span><h2>所选测试详细数据</h2><p>{selectedArchive.runId} · 归档于 {dateText(selectedArchive.archivedAt)} · 原始 JSON 保留有界探测器时序和波形样本。</p></div><div className="archive-detail-links"><a href={`${apiUrl()}/api/test-program/archives/${encodeURIComponent(selectedArchive.runId)}/report`} target="_blank" rel="noreferrer"><Download size={13} />{reportFormatText(selectedArchive.reportFile)}</a><a href={`${apiUrl()}/api/test-program/archives/${encodeURIComponent(selectedArchive.runId)}`} target="_blank" rel="noreferrer">JSON</a></div></header>
          <div className="archive-detail-summary"><div><span>状态</span><b>{statusText(selectedArchive.status)}</b></div><div><span>开始 / 结束</span><b>{dateText(selectedArchive.startedAt)} / {dateText(selectedArchive.endedAt)}</b></div><div><span>总耗时</span><b>{durationText(selectedArchive.durationMs)}</b></div><div><span>最终判定</span><b className={`archive-result ${selectedArchiveVerdictTone}`}>{verdictText(selectedArchiveFinalVerdict)}{selectedArchive.decision.grade ? ` · ${gradeText(selectedArchive.decision.grade)}` : ''}</b></div><div><span>工序 / 继电器</span><b>{selectedArchive.stages.length} / {selectedArchive.relayEvents.length}</b></div><div><span>探测器 / 波形</span><b>{selectedArchiveDetectorRows.reduce((total, row) => total + row.detector.observationCount, 0)} / {selectedArchive.stages.reduce((total, stage) => total + stage.waveforms.reduce((sum, waveform) => sum + waveform.sampleCount, 0), 0)}</b></div></div>
          <div className="test-table-wrap"><table className="test-table archive-stage-table"><thead><tr><th>#</th><th>工序</th><th>实际 / 计划</th><th>偏差</th><th>计划判断</th><th>继电器</th><th>探测器</th><th>波形</th><th>工序检测判断依据</th></tr></thead><tbody>{selectedArchive.stages.length === 0 && <tr><td colSpan={9} className="test-empty-cell">该测试没有阶段记录</td></tr>}{selectedArchive.stages.map((stage) => <tr key={`${selectedArchive.runId}-${stage.sequence}`}><td>{stage.sequence}</td><td><b>{stage.label}</b><small>{decisionText(stage.stageId)} · {statusText(stage.status)}</small></td><td>{durationText(stage.durationMs)} / {planText(stage.plannedDurationMs)}</td><td className={stage.durationDeltaMs !== null && stage.durationDeltaMs > 0 ? 'is-over' : ''}>{deviationText(stage.durationDeltaMs)}</td><td>{stage.withinPlan === null ? '仅统计' : stage.withinPlan ? '在计划内' : '超计划'}</td><td>{stage.relayEventCount}</td><td>{(stage.detectors ?? []).reduce((total, detector) => total + detector.observationCount, 0)}</td><td>{stage.waveforms.reduce((total, waveform) => total + waveform.sampleCount, 0)}</td><td className="basis-cell"><div className="test-basis-scroll">{stage.decisionBasis.map(decisionText).join('；') || '-'}</div></td></tr>)}</tbody></table></div>
          <section className="archive-detail-card archive-detector-detail"><header className="test-panel-heading compact"><div><span className="test-kicker">DETECTOR VALUES / ALL STAGES</span><h3>各工序探测器数值与统计</h3><p>最新值用于回看现场状态，小字为该工序和设备的最小值 ~ 最大值；完整有界观测序列在 JSON 中。</p></div><strong className="test-count-badge">{selectedArchiveDetectorRows.length} DEVICES</strong></header><div className="test-table-wrap"><table className="test-table detector-values-table archive-detector-table"><thead><tr><th>工序</th><th>设备/地址</th><th>观测/保留</th><th>采样范围</th>{DETECTOR_VALUE_COLUMNS.map((column) => <th key={column.key}>{column.label}</th>)}<th>状态与计数</th></tr></thead><tbody>{selectedArchiveDetectorRows.length === 0 && <tr><td colSpan={4 + DETECTOR_VALUE_COLUMNS.length + 1} className="test-empty-cell">该测试没有探测器标量观测</td></tr>}{selectedArchiveDetectorRows.map(({ stage, detector }) => <tr key={`${selectedArchive.runId}-${stage.sequence}-${detector.index}`}><td><b>{stage.label}</b><small>{stage.sequence}. {stage.stageId}</small></td><td><b>设备 {detector.index}</b><small>地址 {detector.address}</small></td><td><b>{detector.observationCount}</b><small>保留 {detector.retainedObservationCount}</small></td><td>{timeText(detector.firstAt)} ~ {timeText(detector.lastAt)}</td>{DETECTOR_VALUE_COLUMNS.map((column) => <td key={column.key} className="detector-value-cell"><b>{numberText(detector.latest?.[column.key])}</b><small>{detectorRangeText(detector, column.key)}</small></td>)}<td className="detector-state-cell"><b>{detector.latest?.online ? '在线' : '离线'}</b><small>{detectorStateText(detector)}</small><em>在线 {detector.onlineCount} · 离线 {detector.offlineCount} · 故障 {detector.faultCount} · 火警 {detector.fireCount}</em></td></tr>)}</tbody></table></div></section>
          <div className="archive-detail-grid"><section className="archive-detail-card"><header className="test-panel-heading compact"><div><span className="test-kicker">RELAY HISTORY</span><h3>继电器状态与变化</h3><p>最终状态和所有归档变化事件均来自正式状态源。</p></div><strong className="test-count-badge">{selectedArchive.relayEvents.length} EVENTS</strong></header><div className="archive-relay-summary">{selectedArchive.latestRelayOutputs.length === 0 && <div className="test-empty-cell">无继电器最终状态</div>}{selectedArchive.latestRelayOutputs.map((relay) => <div key={relay.key} className={`test-relay-card ${relay.value ? 'is-on' : ''}`}><div><b>{relay.address}</b><span>{relay.label}</span></div><strong>{relay.value ? 'ON' : 'OFF'}</strong><small>{relay.changedAt ? timeText(relay.changedAt) : '未变化'}</small></div>)}</div><div className="test-event-list archive-event-list">{selectedArchive.relayEvents.slice().reverse().map((event, index) => <div key={`${event.timestamp}-${event.address}-${index}`}><time>{timeText(event.timestamp)}</time><b>{event.address}</b><span>{event.label}</span><em>{event.before === null ? '-' : event.before ? 'ON' : 'OFF'} → {event.value ? 'ON' : 'OFF'}</em><small>{decisionText(event.stageId)}</small></div>)}{selectedArchive.relayEvents.length === 0 && <div className="test-empty-cell">该测试没有继电器变化事件</div>}</div></section><section className="archive-detail-card"><header className="test-panel-heading compact"><div><span className="test-kicker">STAGE JUDGMENTS</span><h3>各工序检测判断结果</h3><p>同时保留计划时长判断和正式程序返回的工序依据。</p></div><strong className={`test-verdict-chip ${selectedArchiveVerdictTone}`}>{verdictText(selectedArchiveFinalVerdict)}</strong></header><div className="archive-judgement-list">{selectedArchive.stages.map((stage) => <div key={`${selectedArchive.runId}-judgement-${stage.sequence}`}><div><b>{stage.sequence}. {stage.label}</b><span>{stage.withinPlan === null ? '仅统计' : stage.withinPlan ? '时长合格' : '超计划'}</span></div><p>{stage.decisionBasis.map(decisionText).join('；') || '未收到该工序的正式判断依据'}</p></div>)}</div><div className="archive-final-decision"><b>最终原因</b>{selectedArchive.decision.reasons.length > 0 ? selectedArchive.decision.reasons.map((reason, index) => <span key={`${reason}-${index}`}>{decisionText(reason)}</span>) : <span>无附加失败原因</span>}<b>最终依据</b>{selectedArchive.decision.basis.length > 0 ? selectedArchive.decision.basis.map((basis, index) => <span key={`${basis}-${index}`}>{decisionText(basis)}</span>) : <span>未提供最终依据</span>}</div></section></div>
        </div>}
      </section>

      {settingsOpen && <div className="test-config-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="test-config-modal" role="dialog" aria-modal="true" aria-labelledby="test-config-title">
          <header className="test-config-header"><div><span className="test-kicker">SETTINGS / PLC PLAN REFERENCE</span><h2 id="test-config-title">规划时长配置</h2><p>读取正式 PLC 步骤作为参考，在测试观察器内确认各阶段规划时长。</p></div><button type="button" className="test-modal-close" aria-label="关闭规划配置" onClick={() => setSettingsOpen(false)}><X size={17} /></button></header>
          <div className="test-config-body">
            <div className="test-config-note"><Settings2 size={15} /><span>当前来源：{planSource === 'LOCAL_OVERRIDE' ? '测试观察器本地配置' : planSource === 'PLC_REFERENCE' ? '当前 PLC 步骤参考' : '默认观察计划'}。此处保存不会写入正式 PLC，新的规划从下一轮测试开始生效。</span></div>
            <div className="test-config-table-wrap"><table className="test-table test-config-table"><thead><tr><th>测试阶段</th><th>规划时长（秒）</th><th>当前判断方式</th><th>PLC 参考依据</th></tr></thead><tbody>{planDraft.map((stage) => <tr key={stage.id}><td><b>{stage.label}</b><small>{decisionText(stage.id)}</small></td><td><label className="test-duration-input"><input type="number" min="0" max="86400" step="0.1" value={stage.plannedDurationMs === null ? '' : String(stage.plannedDurationMs / 1_000)} onChange={(event) => updatePlanDuration(stage.id, event.target.value)} placeholder="不参与时长判断" /><span>秒</span></label></td><td>{stage.plannedDurationMs === null ? '仅统计，不判断超时' : '实际时长与规划时长比较'}</td><td className="test-config-basis">{stage.planBasis ?? 'PLC 当前步骤没有明确的一对一阶段设置；请按现场程序确认。'}</td></tr>)}</tbody></table></div>
            <div className="test-config-reference"><header><div><h3>当前 PLC 程序步骤（只读参考）</h3><p>总时长按 PLC 的 duration + waitTime 展示；未自动拆分到热源三段的步骤不会被误分配。</p></div><span>{plcSteps.length} STEPS</span></header><div className="test-config-table-wrap"><table className="test-table"><thead><tr><th>步骤</th><th>名称</th><th>持续时间</th><th>等待时间</th><th>合计规划参考</th></tr></thead><tbody>{plcSteps.length === 0 && <tr><td colSpan={5} className="test-empty-cell">暂未读取到正式 PLC 系统配置</td></tr>}{plcSteps.map((step) => <tr key={step.id}><td>{step.id}</td><td>{step.name}</td><td>{durationText(step.durationMs)}</td><td>{durationText(step.waitTimeMs)}</td><td>{durationText(step.totalDurationMs)}</td></tr>)}</tbody></table></div></div>
          </div>
          <footer className="test-config-footer"><span>{settingsNotice}{planUpdatedAt ? ` · 上次保存 ${dateText(planUpdatedAt)}` : ''}</span><div><button type="button" className="test-modal-secondary" onClick={() => setSettingsOpen(false)}>取消</button><button type="button" className="test-modal-primary" disabled={settingsSaving || planDraft.length === 0} onClick={() => void saveConfig()}>{settingsSaving ? '保存中…' : '保存，下一轮生效'}</button></div></footer>
        </section>
      </div>}

      <footer className="test-program-footer"><TimerReset size={14} />数据原则：阶段分段以正式 PLC 状态为准；探测器标量值按阶段、设备记录并保留统计范围；波形原始样本、阈值和正式判定原样归档；每次测试另写一份本地 HTML 报告和一行精简 test-results.log；测试程序不改变正式程序配置。</footer>
    </main>
  );
}
