import { useEffect, useMemo, useState } from 'react';
import type { FC, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  CircleDotDashed,
  ChevronDown,
  ChevronUp,
  Clock3,
  Hourglass,
  LogIn,
  MoveDown,
  MoveUp,
  RefreshCw,
  RotateCcw,
  Settings2,
  SunMedium,
  TriangleAlert,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { hasActivePLCProcessAlarm, isPLCProcessComplete, PLC_HEAT_SUBSTAGE_LABELS, type PLCHeatSubstage, type PLCProcessStatus } from '../server/src/process-status';
import { PLC_EMC_MAPPING, PLC_PROGRAM } from '../server/src/plc-program-contract';
import type { FieldDetectorBatchVerdict, FieldDetectorResult, FieldQualityGrade } from '../server/src/closure/field-detector-verdict';
import type { FieldFinalVerdict } from '../server/src/closure/field-final-verdict';
import type { FieldWaveformAnalysisSnapshot } from '../server/src/closure/field-waveform-analysis';
import type { FlameDetectorState, FlameDetectorUnitState } from '../server/src/types';
import type { FlameSample } from '../server/src/types';
import { DEFAULT_WAVEFORM_MAX_SAMPLES, waveformDomain, waveformKeys, waveformSamples, type WaveformDisplayMode } from '../utils/waveform';
import './wutos-dashboard.css';

const asset = (name: string) => import.meta.env.BASE_URL + 'wutos-assets/' + name;

type AlarmRow = {
  time: string;
  event: string;
  detail: string;
  state: string;
  tone: 'normal' | 'info' | 'danger';
};

type PLCSignalArea = 'inputs' | 'outputs' | 'internal';

type WorkflowNode = {
  icon: LucideIcon;
  label: string;
  address: string;
  stepKeys: string[];
};

const PLC_INPUT_DEFINITIONS = PLC_PROGRAM.inputs;
const PLC_STATUS_DEFINITIONS = PLC_PROGRAM.internal.filter((item) => ['autoRunning', 'complete', 'processAlarm', 'safetyOk'].includes(item.key));
const PLC_RELAY_DEFINITIONS = PLC_PROGRAM.relays;

const WORKFLOW: WorkflowNode[] = [
  { icon: Hourglass, label: '等待启动', address: 'M0.0=0', stepKeys: [] },
  { icon: MoveDown, label: '初始位垂直复位', address: 'M10.0', stepKeys: ['stepM10_0'] },
  { icon: RotateCcw, label: '初始位确认', address: 'M10.1', stepKeys: ['stepM10_1'] },
  { icon: LogIn, label: '检测区1定位', address: 'M10.2', stepKeys: ['stepM10_2'] },
  { icon: MoveDown, label: '热源位夹具下压', address: 'M10.3', stepKeys: ['stepM10_3'] },
  { icon: SunMedium, label: '热源干扰测试', address: 'M10.4', stepKeys: ['stepM10_4'] },
  { icon: MoveUp, label: '热源后夹具上升', address: 'M10.5', stepKeys: ['stepM10_5'] },
  { icon: LogIn, label: '检测区2定位', address: 'M10.6', stepKeys: ['stepM10_6'] },
  { icon: MoveDown, label: '爆闪位夹具下压', address: 'M10.7', stepKeys: ['stepM10_7'] },
  { icon: Zap, label: '五次爆闪测试', address: 'M11.0', stepKeys: ['stepM11_0'] },
  { icon: Activity, label: '电磁干扰', address: `${PLC_EMC_MAPPING.controlBit.address} & ${PLC_EMC_MAPPING.safetyGate.address} → ${PLC_EMC_MAPPING.physicalOutput.address}`, stepKeys: ['stepM11_2'] },
  { icon: RotateCcw, label: '回初始位确认', address: 'M11.4', stepKeys: ['stepM11_4'] },
  { icon: CheckCircle2, label: '流程完成', address: 'M0.1', stepKeys: [] },
];

function processStage(status: PLCProcessStatus | null): string {
  return status?.processStage ?? status?.stage ?? 'IDLE';
}

function signalValue(status: PLCProcessStatus | null, area: PLCSignalArea, key: string): boolean {
  return Boolean(status?.io?.[area]?.[key]);
}

function activeWorkflowNode(status: PLCProcessStatus | null): WorkflowNode | undefined {
  const step = WORKFLOW.find((node) => node.stepKeys.some((key) => Boolean(status?.io?.steps[key])));
  return step;
}

function processLabel(status: PLCProcessStatus | null): string {
  if (!status) return '工序待同步';
  if (isPLCProcessComplete(status)) return status.processLabel || '已完成';
  const label = activeWorkflowNode(status)?.label || status.processLabel || status.label || '工序待同步';
  return hasActivePLCProcessAlarm(status) ? label + ' · 告警/中止' : label;
}

type SignalCaptureAnalysis = {
  phase: FieldWaveformAnalysisSnapshot['phase'];
  verdict: FieldWaveformAnalysisSnapshot['verdict'];
  noiseCaptureActive?: boolean;
  heatSubstage?: PLCHeatSubstage;
};

function heatSubstage(status: PLCProcessStatus | null, analysis: SignalCaptureAnalysis | null | undefined): PLCHeatSubstage {
  if (signalValue(status, 'steps', 'stepM10_4')) return 'HEAT_INTERFERENCE';
  if (analysis?.heatSubstage) return analysis.heatSubstage;
  if (signalValue(status, 'internal', 'noiseCaptureWindow')) return 'NOISE_CAPTURE';
  if (signalValue(status, 'internal', 'signalStabilizing')) return 'SIGNAL_STABILIZATION';
  return status?.heatSubstage ?? analysis?.heatSubstage ?? 'IDLE';
}

function signalCaptureLabel(status: PLCProcessStatus | null, analysis: SignalCaptureAnalysis | null | undefined, online: boolean): string {
  if (!online) return '离线';
  const noiseCaptureActive = analysis?.noiseCaptureActive ?? signalValue(status, 'internal', 'noiseCaptureWindow');
  const stage = processStage(status);
  const substage = heatSubstage(status, analysis);
  if (substage !== 'IDLE' && substage !== 'POSITIONING') return PLC_HEAT_SUBSTAGE_LABELS[substage];
  if (stage === 'HEAT') return '热源定位/阶段过渡';
  if (stage === 'FLASH') return '爆闪灯干扰信号采集';
  if (stage === 'EMC') return '电磁干扰信号采集';
  if (stage === 'INIT') return noiseCaptureActive ? '噪声采集阶段' : '信号稳定阶段';
  if (analysis?.phase === 'NOISE') return noiseCaptureActive ? '噪声采集阶段' : '信号稳定阶段';
  if (analysis?.phase === 'INTERFERENCE') return '干扰信号采集';
  if (analysis?.phase === 'COMPLETE' || stage === 'COMPLETE') {
    if (analysis?.verdict === 'PASS') return 'PASS';
    if (analysis?.verdict === 'FAIL') return 'FAIL';
  }
  if (stage === 'COMPLETE') return '检测完成';
  return '等待数据';
}

function detectorStartupLabel(unit: FlameDetectorUnitState | undefined): string | null {
  const state = unit?.startup?.state;
  if (!state || state === 'TEST_READY') return null;
  const labels: Record<string, string> = {
    DISCONNECTED: '未连接',
    WAITING_FOR_VERTICAL_LOWER_LIMIT: '等待垂直电机下限位',
    POWER_ON: '已上电',
    COMMUNICATION_READY: '通信就绪',
    MODE_SWITCHING: '模式切换中',
    MODE_SWITCH_OK: '模式切换成功，等待首帧',
    FIRST_FRAME_RECEIVED: '等待通道同步',
    FAILED: '启动失败',
  };
  return labels[state] ?? state;
}

function verdictLabel(verdict: FieldFinalVerdict | null): string {
  if (verdict?.grade === 'A_PASS') return 'A类合格';
  if (verdict?.grade === 'B_PASS') return 'B类合格';
  if (verdict?.grade === 'FAIL' || verdict?.verdict === 'FAIL') return '不合格';
  if (verdict?.verdict === 'PASS') return '检测合格';
  return '等待工序完成';
}

function finalResultSummary(verdict: FieldFinalVerdict | null, aPassCount: number, bPassCount: number, failCount: number): string {
  if (!verdict || verdict.verdict === 'PENDING') return verdictLabel(verdict);
  return `${aPassCount}A类合格/${bPassCount}B类合格/${failCount}NG`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(value: Date): string {
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
}

function formatTime(value: Date): string {
  return pad(value.getHours()) + ':' + pad(value.getMinutes()) + ':' + pad(value.getSeconds());
}

function workflowIndex(status: PLCProcessStatus | null): number {
  if (!status) return -1;
  if (status.complete || processStage(status) === 'COMPLETE' || signalValue(status, 'internal', 'complete')) return WORKFLOW.length - 1;
  const liveIndex = WORKFLOW.findIndex((item) => item.stepKeys.some((key) => Boolean(status.io?.steps[key])));
  if (liveIndex >= 0) return liveIndex;
  const stage = processStage(status);
  if (stage === 'IDLE') return 0;
  if (stage === 'INIT') return status.stepCode >= 1 ? 1 : 0;
  if (stage === 'HEAT') return status.stepCode >= 3 ? 5 : status.stepCode >= 2 ? 4 : 3;
  if (stage === 'FLASH') return status.stepCode >= 3 ? 9 : 8;
  if (stage === 'EMC') return 10;
  if (stage === 'RETURN_HOME') return 11;
  if (stage === 'COMPLETE') return WORKFLOW.length - 1;
  return -1;
}

function alarmRows(
  now: Date,
  status: PLCProcessStatus | null,
  detectors: FlameDetectorState | null,
  detectorVerdict: FieldDetectorBatchVerdict | null,
  finalVerdict: FieldFinalVerdict | null,
  channelOnline: boolean,
): AlarmRow[] {
  const online = detectors?.onlineCount ?? 0;
  const fire = detectors?.fireCount ?? 0;
  const fault = detectors?.faultCount ?? 0;
  const current = formatTime(now);
  const previous = formatTime(new Date(now.getTime() - 13_000));
  const earlier = formatTime(new Date(now.getTime() - 31_000));
  const inputs = status?.io?.inputs;
  const internal = status?.io?.internal;
  const safetyAlarm = status?.io && (!inputs?.safetyInput || !internal?.safetyOk);
  const stopAlarm = !isPLCProcessComplete(status) && Boolean(internal?.stopLatch || internal?.stopRequest);
  const limitAlarm = Boolean(internal?.safetyLimit);
  const gradeDetail = detectorVerdict?.grade === 'A_PASS'
    ? '全部 A类合格'
    : detectorVerdict?.grade === 'B_PASS'
      ? '含 B类合格，无不合格'
      : detectorVerdict?.grade === 'FAIL'
        ? `${detectorVerdict.units.filter((unit) => unit.grade === 'FAIL').length} 台不合格`
        : '等待定量指标完成';
  return [
    {
      time: current,
      event: 'PLC通信',
      detail: channelOnline ? 'WebSocket 在线' : '等待连接',
      state: channelOnline ? '正常' : '离线',
      tone: channelOnline ? 'normal' : 'danger',
    },
    {
      time: previous,
      event: '流程状态',
      detail: `${processLabel(status)} · VW600=${status?.stageCode ?? '--'} / VW602=${status?.stepCode ?? '--'}`,
      state: status?.alarm ? '报警' : status?.valid ? '正常' : '提醒',
      tone: status?.alarm ? 'danger' : status?.valid ? 'normal' : 'info',
    },
    {
      time: previous,
      event: '安全链',
      detail: 'I1.0 / M0.3',
      state: safetyAlarm ? '报警' : status?.io ? '正常' : '提醒',
      tone: safetyAlarm ? 'danger' : status?.io ? 'normal' : 'info',
    },
    {
      time: earlier,
      event: '停止/中止',
      detail: 'M1.0 / M2.0',
      state: stopAlarm ? '报警' : status?.io ? '正常' : '提醒',
      tone: stopAlarm ? 'danger' : status?.io ? 'normal' : 'info',
    },
    {
      time: earlier,
      event: '安全限位',
      detail: 'M2.2',
      state: limitAlarm ? '报警' : status?.io ? '正常' : '提醒',
      tone: limitAlarm ? 'danger' : status?.io ? 'normal' : 'info',
    },
    {
      time: current,
      event: '结果分级',
      detail: `${verdictLabel(finalVerdict)} · ${gradeDetail} · ${online}/6在线/${fire}火警/${fault}故障`,
      state: finalVerdict?.verdict === 'FAIL' || detectorVerdict?.grade === 'FAIL' ? '报警' : finalVerdict?.grade ? '正常' : '提醒',
      tone: finalVerdict?.verdict === 'FAIL' || detectorVerdict?.grade === 'FAIL' ? 'danger' : finalVerdict?.grade ? 'normal' : 'info',
    },
  ];
}

function detectorTone(unit: FlameDetectorUnitState | undefined, grade: FieldQualityGrade | undefined): 'pass' | 'fail' | 'pending' {
  if (unit?.fault || grade === 'FAIL') return 'fail';
  if (grade === 'A_PASS' || grade === 'B_PASS') return 'pass';
  return 'pending';
}

function Panel({ title, titleMeta, className, children }: { title: string; titleMeta?: ReactNode; className: string; children: ReactNode }) {
  return (
    <section className={'wutos-panel ' + className}>
      <h2 className="wutos-panel__title">{title}{titleMeta}</h2>
      <div className="wutos-panel__body">{children}</div>
    </section>
  );
}

const FinalResultCards: FC<{
  finalVerdict: FieldFinalVerdict | null;
  aPassCount: number;
  bPassCount: number;
  failCount: number;
}> = ({ finalVerdict, aPassCount, bPassCount, failCount }) => {
  const cards = [
    { key: 'a-pass', label: 'A类合格', value: aPassCount },
    { key: 'b-pass', label: 'B类合格', value: bPassCount },
    { key: 'fail', label: '不合格', value: failCount },
  ];
  return (
    <div
      className="wutos-final-result-cards"
      aria-label={`最终结果：${finalResultSummary(finalVerdict, aPassCount, bPassCount, failCount)}`}
    >
      {cards.map((card) => (
        <div className={`wutos-final-result-card is-${card.key}`} key={card.key} title={`${card.label}：${card.value} 台`}>
          <small>{card.label}</small>
          <b>{card.value}</b>
        </div>
      ))}
    </div>
  );
};

function gradeLabel(grade: FieldQualityGrade | undefined): string {
  if (grade === 'A_PASS') return 'A类合格';
  if (grade === 'B_PASS') return 'B类合格';
  if (grade === 'FAIL') return '不合格';
  return '待判定';
}

type ProcessLampState = 'pass' | 'fail' | 'pending';
type ProcessLampKey = 'noise' | 'heat' | 'flash' | 'emc';
type RatioMetric = 'snr21' | 'snr23' | 'snr31';
type NoiseMetric = 'fluctuation' | 'absolute';

type NoiseMetricValue = {
  key: keyof FlameSample;
  value: number;
};

type NoiseLimits = {
  fluctuationMin?: number;
  fluctuation?: number;
  absolute?: number;
};

const RATIO_LABELS: Record<RatioMetric, string> = { snr21: 'P2/P1', snr23: 'P2/P3', snr31: 'P3/P1' };

function configuredRatioMetrics(snapshot: FieldWaveformAnalysisSnapshot | null): RatioMetric[] {
  const quality = snapshot?.thresholds.quality;
  const grade = quality?.acceptanceGrade === 'A' ? 'a' : 'b';
  const limits = quality?.ratios?.[grade];
  const configured = (Object.keys(RATIO_LABELS) as RatioMetric[])
    .filter((metric) => (limits?.[metric].min ?? 0) > 0 || (limits?.[metric].max ?? 0) > 0);
  return configured.length ? configured : ['snr23'];
}

function maximumConfiguredRatio(
  values: { snr21?: number | null; snr23?: number | null; snr31?: number | null } | undefined,
  metrics: RatioMetric[],
) {
  const ratios = metrics.map((metric) => [RATIO_LABELS[metric], values?.[metric]] as const);
  const available = ratios.filter((item): item is readonly [string, number] => Number.isFinite(item[1]));
  return available.sort((left, right) => right[1] - left[1])[0];
}

function configuredNoiseLimits(snapshot: FieldWaveformAnalysisSnapshot | null): NoiseLimits {
  const quality = snapshot?.thresholds.quality;
  const selected = quality?.[quality.acceptanceGrade === 'A' ? 'a' : 'b'];
  return {
    fluctuationMin: snapshot?.thresholds.minNoiseRms,
    fluctuation: selected?.maxNoiseRms ?? snapshot?.thresholds.maxNoiseRms,
    absolute: selected?.maxNoiseAbsolute ?? snapshot?.thresholds.maxNoiseAbsolute,
  };
}

function noiseMetricValueIsOutOfRange(value: number, minimum: number | undefined, maximum: number | undefined): boolean {
  if (!Number.isFinite(value)) return false;
  const belowMinimum = Number.isFinite(minimum) && Number(minimum) > 0 && value < Number(minimum);
  const aboveMaximum = Number.isFinite(maximum) && Number(maximum) > 0 && value > Number(maximum);
  return belowMinimum || aboveMaximum;
}

function formatNoiseLimitRange(minimum: number | undefined, maximum: number | undefined): string {
  const lower = Number.isFinite(minimum) && Number(minimum) > 0 ? formatNoiseMetric(Number(minimum)) : '不限';
  const upper = Number.isFinite(maximum) && Number(maximum) > 0 ? formatNoiseMetric(Number(maximum)) : '不限';
  return minimum === undefined ? upper : `${lower} ~ ${upper}`;
}

function failureProcess(reason: string | undefined): ProcessLampKey | undefined {
  if (!reason) return undefined;
  if (reason.includes('NOISE_')) return 'noise';
  if (reason.startsWith('HEAT_')) return 'heat';
  if (reason.startsWith('FLASH_')) return 'flash';
  if (reason.startsWith('EMC_')) return 'emc';
  return undefined;
}

function failureReasonLabel(reason: string | undefined): string {
  if (!reason) return '检测指标未通过';
  const stage = reason.includes('NOISE_') ? ''
    : reason.startsWith('HEAT_') ? '移动热源干扰测试 '
      : reason.startsWith('FLASH_') ? '爆闪灯干扰测试 '
        : reason.startsWith('EMC_') ? '电磁干扰测试 ' : '';
  const metric = reason.includes('SNR21_BELOW_LIMIT') ? 'P2/P1 信噪比低于下限'
    : reason.includes('SNR21_ABOVE_LIMIT') ? 'P2/P1 信噪比高于上限'
      : reason.includes('SNR23_BELOW_LIMIT') ? 'P2/P3 信噪比低于下限'
        : reason.includes('SNR23_ABOVE_LIMIT') ? 'P2/P3 信噪比高于上限'
          : reason.includes('SNR31_BELOW_LIMIT') ? 'P3/P1 信噪比低于下限'
            : reason.includes('SNR31_ABOVE_LIMIT') ? 'P3/P1 信噪比高于上限'
              : reason.includes('NOISE_RMS_EXCEEDS_LIMIT') ? '波动噪声值超过上限'
                : reason.includes('NOISE_RMS_BELOW_LIMIT') ? '波动噪声值低于下限'
                  : reason.includes('NOISE_ABSOLUTE_EXCEEDS_LIMIT') ? '绝对噪声值超过上限'
                  : reason.includes('INTERFERENCE_RATIO_EXCEEDS_LIMIT') ? '干扰比超过上限'
                    : reason.includes('CONSISTENCY_TREND_BELOW_LIMIT') ? '一致性低于下限'
                      : reason.includes('SAMPLES_MISSING') ? '采样数据不足'
                        : reason === 'DETECTOR_FAULT' ? '探测器故障'
                          : reason === 'DETECTOR_OFFLINE' ? '探测器离线'
                            : reason;
  return stage + metric;
}

function processLampState(
  key: ProcessLampKey,
  grade: FieldQualityGrade | undefined,
  reason: string | undefined,
  analysis: FieldWaveformAnalysisSnapshot['units'][number] | undefined,
  minimumNoiseSamples: number,
): ProcessLampState {
  if (key === 'noise') {
    if (analysis?.noiseTest?.verdict === 'PASS') return 'pass';
    if (analysis?.noiseTest?.verdict === 'FAIL') return 'fail';
    if (analysis?.phase === 'COMPLETE') return analysis.noiseSampleCount >= minimumNoiseSamples ? 'pass' : 'fail';
    return 'pending';
  }
  if (analysis?.stages?.[key]?.verdict === 'PASS') return 'pass';
  if (analysis?.stages?.[key]?.verdict === 'FAIL') return 'fail';
  if (reason === 'DETECTOR_FAULT') return 'fail';
  const failedProcess = failureProcess(reason);
  if (failedProcess === key || (grade === 'FAIL' && !failedProcess)) return 'fail';
  if (analysis?.phase === 'COMPLETE' && (grade === 'A_PASS' || grade === 'B_PASS')) return 'pass';
  return 'pending';
}

const DetectorCard: FC<{
  index: number;
  unit: FlameDetectorUnitState | undefined;
  result: FieldDetectorResult | undefined;
  analysis: FieldWaveformAnalysisSnapshot['units'][number] | undefined;
  minimumNoiseSamples: number;
  configuredRatios: RatioMetric[];
  noiseLimits: NoiseLimits;
}> = ({ index, unit, result: detectorResult, analysis, minimumNoiseSamples, configuredRatios, noiseLimits }) => {
  const [openLamp, setOpenLamp] = useState<ProcessLampKey | null>(null);
  const grade = detectorResult?.grade;
  const tone = detectorTone(unit, grade);
  const fail = Boolean(unit?.fault || grade === 'FAIL');
  const noiseRatios = maximumConfiguredRatio(detectorResult?.metrics, configuredRatios);
  const probeFluctuationValues = probeMetricValues(unit, analysis, 'fluctuation');
  const probeAbsoluteValues = probeMetricValues(unit, analysis, 'absolute');
  const probeFluctuationSummary = probeMetricSummary(probeFluctuationValues);
  const probeAbsoluteSummary = probeMetricSummary(probeAbsoluteValues);
  const isNoisePhase = analysis?.phase === 'NOISE';
  const lamps: Array<{ key: ProcessLampKey; label: string; testLabel: string; ratios: ReturnType<typeof maximumConfiguredRatio> }> = [
    { key: 'noise', label: '噪声测试', testLabel: '噪声测试', ratios: noiseRatios },
    { key: 'heat', label: '移动热源', testLabel: '移动热源干扰测试', ratios: maximumConfiguredRatio(analysis?.stages?.heat, configuredRatios) },
    { key: 'flash', label: '爆闪灯', testLabel: '爆闪灯干扰测试', ratios: maximumConfiguredRatio(analysis?.stages?.flash, configuredRatios) },
    { key: 'emc', label: '电磁干扰', testLabel: '电磁干扰测试', ratios: maximumConfiguredRatio(analysis?.stages?.emc, configuredRatios) },
  ];
  return (
    <article className={'wutos-detector-card ' + tone + (isNoisePhase ? ' is-noise' : '')} aria-label={`探测器${index}检测结果`}>
      <header>
        <strong>探测器{index}</strong>
        <span>{gradeLabel(grade)}</span>
      </header>
      <div className="wutos-detector-card__metrics">
        {([
          ['fluctuation', '波动噪声', probeFluctuationValues, noiseLimits.fluctuationMin, noiseLimits.fluctuation],
          ['absolute', '绝对噪声', probeAbsoluteValues, undefined, noiseLimits.absolute],
        ] as const).map(([metric, label, values, minimum, maximum]) => (
          <div className="wutos-detector-card__metric-row" data-noise-metric={metric} key={metric}>
            <span className="wutos-detector-card__metric-label">{label}</span>
            <div className="wutos-detector-card__metric-values">
              {values.map(({ key, value }) => {
                const outOfRange = noiseMetricValueIsOutOfRange(value, minimum, maximum);
                return <span data-probe={key} key={key} title={`${label} ${formatNoiseMetric(value)}，阈值 ${formatNoiseLimitRange(minimum, maximum)}`}>
                  {key.replace('probe', 'P')}<b className={outOfRange ? 'is-over-limit' : undefined}>{formatNoiseMetric(value)}</b>
                </span>;
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="wutos-detector-card__processes" aria-label="各环节检测状态">
        {lamps.map((lamp) => {
          const state = processLampState(lamp.key, grade, detectorResult?.reason, analysis, minimumNoiseSamples);
          const status = state === 'pass' ? '合格' : state === 'fail' ? '不合格' : '待检测';
          return <button
            type="button"
            key={lamp.key}
            className={`wutos-process-lamp ${state} ${openLamp === lamp.key ? 'is-open' : ''}`}
            aria-label={`${lamp.testLabel}：${status}`}
            aria-expanded={openLamp === lamp.key}
            onClick={() => setOpenLamp((current) => current === lamp.key ? null : lamp.key)}
          >
            <i /><span>{lamp.label}</span>
            {openLamp === lamp.key && <small className="wutos-process-lamp__popover" role="status">
              <em>{lamp.key === 'noise' ? '各探头噪声值' : configuredRatios.length === 1 ? `${RATIO_LABELS[configuredRatios[0]]} 最大值` : '最大探头比值'}</em>
              <b>{lamp.key === 'noise'
                ? `波动 ${probeFluctuationSummary}`
                : lamp.ratios ? `${configuredRatios.length === 1 ? '' : `${lamp.ratios[0]} `}${lamp.ratios[1].toFixed(2)}` : '暂无数据'}</b>
              {lamp.key === 'noise' && <b>绝对 {probeAbsoluteSummary}</b>}
            </small>}
          </button>;
        })}
      </div>
      {fail && <small className="wutos-detector-card__failure" title={failureReasonLabel(detectorResult?.reason)}>不合格原因：{failureReasonLabel(detectorResult?.reason)}</small>}
    </article>
  );
};

const PLCSignalRow: FC<{ definition: { key: string; address: string; label: string }; active: boolean; danger?: boolean }> = ({ definition, active, danger = false }) => {
  return <div className="wutos-io-row" title={`${definition.label} · ${definition.address} · ${active ? 'ON' : 'OFF'}`}>
    <img src={asset(danger ? 'lamp-red.png' : active ? 'lamp-green.png' : 'lamp-gray.png')} alt="" />
    <span>{definition.label}</span>
    <code>{definition.address}</code>
  </div>;
};

function PLCSignalGroup({ title, area, definitions, status }: { title: string; area: PLCSignalArea; definitions: readonly { key: string; address: string; label: string }[]; status: PLCProcessStatus | null }) {
  return <section className="wutos-signal-group">
    <h3>{title}</h3>
    <div className="wutos-io-list">
      {definitions.map((definition) => <PLCSignalRow key={definition.address} definition={definition} active={signalValue(status, area, definition.key)} danger={area === 'internal' && definition.key === 'processAlarm' && signalValue(status, area, definition.key)} />)}
    </div>
  </section>;
}

function WorkflowArrow() {
  return (
    <div className="wutos-flow-arrow" aria-hidden="true">
      <span />
      <ArrowRight />
    </div>
  );
}

function miniWavePath(samples: FlameSample[], key: keyof FlameSample, domain: ReturnType<typeof waveformDomain>, width = 120, height = 34): string {
  const values = samples.map((sample) => Number(sample[key])).filter(Number.isFinite);
  if (values.length < 2) return '';
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 2 - ((value - domain.min) / domain.span) * (height - 4);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function probeFluctuation(unit: FlameDetectorUnitState | undefined, key: keyof FlameSample): number {
  const explicit = unit?.[`${String(key)}Fluctuation` as keyof FlameDetectorUnitState];
  const hasHistory = (unit?.historySamples?.length ?? unit?.samples?.length ?? 0) > 0;
  return Number.isFinite(Number(explicit)) && (Number(explicit) > 0 || !hasHistory)
    ? Number(explicit)
    : Number(unit?.[key] ?? NaN);
}

function probeAbsolute(unit: FlameDetectorUnitState | undefined, key: keyof FlameSample): number {
  const explicit = unit?.[`${String(key)}Absolute` as keyof FlameDetectorUnitState];
  const hasHistory = (unit?.rawHistorySamples?.length ?? unit?.rawSamples?.length ?? 0) > 0;
  if (Number.isFinite(Number(explicit)) && (Number(explicit) > 0 || !hasHistory)) return Number(explicit);
  const raw = unit?.rawHistorySamples ?? unit?.rawSamples ?? [];
  return raw.reduce((max, sample) => Math.max(max, Math.abs(Number(sample[key]) || 0)), 0);
}

function probeMetricValues(unit: FlameDetectorUnitState | undefined, analysis: FieldWaveformAnalysisSnapshot['units'][number] | undefined, metric: NoiseMetric): NoiseMetricValue[] {
  const probes = unit ? waveformKeys(waveformSamples(unit), unit) : ['probe1', 'probe2', 'probe3'] as Array<keyof FlameSample>;
  return probes.map((key) => ({
    key,
    value: analysis?.noiseTest && analysis.noiseTest.sampleCount > 0
      ? Number(analysis.noiseTest.metrics[key]?.[metric])
      : NaN,
  }));
}

function formatNoiseMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(0) : '--';
}

function probeMetricSummary(values: NoiseMetricValue[]): string {
  return values.map(({ key, value }) => `${key.replace('probe', 'P')}:${formatNoiseMetric(value)}`).join(' / ');
}

const SensorLiveCard: FC<{ index: number; unit: FlameDetectorUnitState | undefined; status: PLCProcessStatus | null; analysis: FieldWaveformAnalysisSnapshot['units'][number] | undefined; captureAnalysis: SignalCaptureAnalysis | null | undefined; waveformDisplayMode: WaveformDisplayMode; waveformMaxSamples: number }> = ({ index, unit, status, analysis, captureAnalysis, waveformDisplayMode, waveformMaxSamples }) => {
  const samples = waveformSamples(unit, waveformDisplayMode, waveformMaxSamples);
  const probes = waveformKeys(samples, unit);
  const domain = waveformDomain(samples, probes);
  const state = unit?.fault ? 'fault' : unit?.fire ? 'fire' : unit?.online ? 'online' : 'offline';
  const stateLabel = detectorStartupLabel(unit) ?? signalCaptureLabel(status, captureAnalysis ?? analysis, Boolean(unit?.online));
  const p1 = probeFluctuation(unit, 'probe1');
  const p2 = probeFluctuation(unit, 'probe2');
  const p3 = probeFluctuation(unit, 'probe3');
  const ratio = (reported: number | undefined, numerator: number, denominator: number) => Number.isFinite(reported) && Number(reported) > 0 ? Number(reported) : denominator > 0 ? numerator / denominator : NaN;
  const ratios = [
    ['P2/P1', ratio(unit?.snr21, p2, p1)],
    ['P2/P3', ratio(unit?.snr23, p2, p3)],
    ['P3/P1', ratio(unit?.snr31, p3, p1)],
  ] as const;

  return <article className={`wutos-sensor-card is-${state}`} aria-label={`探测器${index}实时状态`}>
    <header>
      <div><span><i />探测器 {index}</span><small>地址 {unit?.address ?? index} · {probes.length === 4 ? '四波长' : '三波长'} · {probes.length} 路探头</small></div>
      <b>{stateLabel}</b>
    </header>
    <div className="wutos-sensor-caption"><strong>实时波形预览</strong><span>{waveformDisplayMode === 'raw' ? '原始值' : '归一化值'} · {samples.length} 点</span></div>
    <div className="wutos-sensor-wave">
      <div className="wutos-sensor-legend">{probes.map((key, channel) => <span key={key}><i className={`channel-${channel + 1}`} />探头{channel + 1}</span>)}</div>
      {samples.length >= 2 ? <svg viewBox="0 0 120 34" preserveAspectRatio="none" role="img" aria-label={`探测器${index}实时波形`}>
        <path className="wutos-wave-grid" d="M0 17H120 M30 0V34 M60 0V34 M90 0V34" />
        {probes.map((key, channel) => {
          const path = miniWavePath(samples, key, domain);
          return path ? <path key={key} className={`wutos-wave-line channel-${channel + 1}`} d={path} /> : null;
        })}
      </svg> : <span>等待波形</span>}
    </div>
    <div className="wutos-sensor-section-title"><b>探头数据</b><span>波动 / 绝对 · mV</span></div>
    <div className="wutos-sensor-values wutos-sensor-values--probes">
      {probes.map((key, channel) => {
        const fluctuation = probeFluctuation(unit, key);
        const absolute = probeAbsolute(unit, key);
        return <span key={key}>探头{channel + 1}<b>{Number.isFinite(fluctuation) ? fluctuation.toFixed(0) : '--'}</b><small>绝对 {Number.isFinite(absolute) ? absolute.toFixed(0) : '--'}</small></span>;
      })}
    </div>
    <div className="wutos-sensor-section-title"><b>探头比值</b><span>实时 SNR</span></div>
    <div className="wutos-sensor-values wutos-sensor-values--ratios">
      {ratios.map(([label, value]) => <span key={label}>{label}<b>{Number.isFinite(value) ? value.toFixed(2) : '--'}</b><small>×</small></span>)}
    </div>
    <div className="wutos-sensor-quality">
      <span>噪声 RMS<b>{analysis?.noiseRms == null ? '--' : analysis.noiseRms.toFixed(2)}</b></span>
      <span>干扰比<b>{analysis?.interferenceRatio == null ? '--' : `${analysis.interferenceRatio.toFixed(2)}×`}</b></span>
      <span>样本<b>{analysis ? `${analysis.noiseSampleCount}/${analysis.interferenceSampleCount}` : '--'}</b></span>
    </div>
    <footer><span><i />{unit?.online ? '实时波形流正常' : '等待探测器通讯'}</span></footer>
  </article>;
};

const LiveWaveformPanel: FC<{
  units: Array<FlameDetectorUnitState | undefined>;
  status: PLCProcessStatus | null;
  waveformAnalysis: FieldWaveformAnalysisSnapshot | null;
  waveformDisplayMode: WaveformDisplayMode;
  waveformMaxSamples: number;
}> = ({ units, status, waveformAnalysis, waveformDisplayMode, waveformMaxSamples }) => {
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selectedUnit = selectedIndex === null
    ? undefined
    : units.find((unit) => unit?.index === selectedIndex);
  const activeUnit = selectedUnit ?? units.find((unit) => unit?.online) ?? units.find(Boolean);
  const samples = activeUnit?.online
    ? waveformSamples(activeUnit, waveformDisplayMode, waveformMaxSamples)
    : [];
  const probes = waveformKeys(samples, activeUnit);
  const domain = waveformDomain(samples, probes);
  const activeIndex = activeUnit?.index ?? selectedIndex ?? 1;
  const isLive = Boolean(activeUnit?.online && samples.length >= 2);
  const activeAnalysis = waveformAnalysis?.units.find((unit) => unit.index === activeIndex);
  const stateLabel = activeUnit?.online ? signalCaptureLabel(status, waveformAnalysis ?? activeAnalysis, true) : '等待探测器通讯';

  return (
    <section className={`wutos-live-waveform ${expanded ? 'is-expanded' : 'is-collapsed'}`} aria-label="实时波形监视">
      <button
        type="button"
        className="wutos-live-waveform__header wutos-live-waveform__toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}实时波形监视`}
      >
        <div>
          <span className="wutos-live-waveform__eyebrow"><Activity />实时波形监视</span>
          <strong>探测器 {activeIndex}</strong>
        </div>
        <div className="wutos-live-waveform__status">
          <span>{waveformDisplayMode === 'raw' ? '原始值' : '归一化值'} · {samples.length} 点</span>
          <b className={isLive ? 'is-live' : ''}>{stateLabel}</b>
        </div>
        {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>
      {expanded && <>
        <div className="wutos-live-waveform__chart">
          {samples.length >= 2 ? (
            <svg viewBox="0 0 240 90" preserveAspectRatio="none" role="img" aria-label={`探测器${activeIndex}实时波形监视`}>
              <path className="wutos-live-waveform__grid" d="M0 22.5H240 M0 45H240 M0 67.5H240 M48 0V90 M96 0V90 M144 0V90 M192 0V90" />
              {probes.map((key, channel) => {
                const path = miniWavePath(samples, key, domain, 240, 90);
                return path ? <path key={key} className={`wutos-live-waveform__line channel-${channel + 1}`} d={path} /> : null;
              })}
            </svg>
          ) : (
            <span className="wutos-live-waveform__empty">{stateLabel}</span>
          )}
        </div>
        <div className="wutos-live-waveform__data">
          <div className="wutos-live-waveform__values-title"><b>探头数据</b><span>波动 / 绝对 · mV</span></div>
          <div className="wutos-live-waveform__values" aria-label="实时探头数值">
            {probes.map((key, channel) => {
              const fluctuation = probeFluctuation(activeUnit, key);
              const absolute = probeAbsolute(activeUnit, key);
              return <span key={key}>
                <i className={`channel-${channel + 1}`} />
                <label>探头{channel + 1}</label>
                <b>{Number.isFinite(fluctuation) ? fluctuation.toFixed(0) : '--'}</b>
                <small>绝对 {Number.isFinite(absolute) ? absolute.toFixed(0) : '--'}</small>
              </span>;
            })}
            {probes.length === 0 && <span className="is-empty">等待探头数据</span>}
          </div>
        </div>
        <footer className="wutos-live-waveform__footer">
          <div className="wutos-live-waveform__legend">
            {probes.map((key, channel) => <span key={key}><i className={`channel-${channel + 1}`} />探头{channel + 1}</span>)}
            {probes.length === 0 && <span><i />等待通道</span>}
          </div>
          <div className="wutos-live-waveform__devices" aria-label="选择探测器">
            {units.map((unit, index) => {
              const deviceIndex = index + 1;
              return <button
                key={deviceIndex}
                type="button"
                className={deviceIndex === activeIndex ? 'is-selected' : ''}
                onClick={() => setSelectedIndex(deviceIndex)}
                aria-label={`查看探测器${deviceIndex}波形`}
                aria-pressed={deviceIndex === activeIndex}
              >
                <i className={unit?.online ? 'is-online' : ''} />{deviceIndex}
              </button>;
            })}
          </div>
        </footer>
      </>}
    </section>
  );
};

export interface WutosDashboardProps {
  status: PLCProcessStatus | null;
  detectors: FlameDetectorState | null;
  waveformAnalysis: FieldWaveformAnalysisSnapshot | null;
  detectorVerdict: FieldDetectorBatchVerdict | null;
  finalVerdict: FieldFinalVerdict | null;
  channelOnline: boolean;
  notice: string;
  resultTitleMeta?: ReactNode;
  onRefresh: () => void;
  onOpenDetails?: () => void;
  waveformDisplayMode?: WaveformDisplayMode;
  waveformMaxSamples?: number;
}

export function WutosDashboard({
  status,
  detectors,
  waveformAnalysis,
  detectorVerdict,
  finalVerdict,
  channelOnline,
  notice,
  resultTitleMeta,
  onRefresh,
  onOpenDetails,
  waveformDisplayMode = 'normalized',
  waveformMaxSamples = DEFAULT_WAVEFORM_MAX_SAMPLES,
}: WutosDashboardProps) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const units = useMemo(
    () => Array.from({ length: 6 }, (_, index) => detectors?.units.find((unit) => unit.index === index + 1)),
    [detectors],
  );
  const activeWorkflowIndex = workflowIndex(status);
  const alarms = alarmRows(clock, status, detectors, detectorVerdict, finalVerdict, channelOnline);
  const onlineCount = detectors?.onlineCount ?? units.filter((unit) => unit?.online).length;
  const faultCount = detectors?.faultCount ?? units.filter((unit) => unit?.fault).length;
  const fireCount = detectors?.fireCount ?? units.filter((unit) => unit?.fire).length;
  const aPassCount = detectorVerdict?.units.filter((unit) => unit.grade === 'A_PASS').length ?? 0;
  const bPassCount = detectorVerdict?.units.filter((unit) => unit.grade === 'B_PASS').length ?? 0;
  const failCount = detectorVerdict?.units.filter((unit) => unit.grade === 'FAIL').length ?? faultCount;
  const configuredRatios = configuredRatioMetrics(waveformAnalysis);
  const noiseLimits = configuredNoiseLimits(waveformAnalysis);
  const stageText = processLabel(status);
  const isAlarm = Boolean(hasActivePLCProcessAlarm(status) || finalVerdict?.verdict === 'FAIL' || detectorVerdict?.grade === 'FAIL');

  return (
    <main className="wutos-dashboard">
      <div className="wutos-frame">
        <div className="wutos-backdrop" aria-hidden="true" />

        <header className="wutos-header">
          <div className="wutos-brand">
            <img className="wutos-brand__logo" src={asset('wutos-logo-real.png')} alt="WUTOS 理工光科" />
          </div>
          <div className="wutos-title-plaque">
            <h1>理工光科智慧生产-火焰探测器检测</h1>
            <span>FLAME DETECTOR TEST BENCH</span>
          </div>
          <div className="wutos-header__meta">
            <span className={'wutos-connection ' + (channelOnline ? 'is-online' : 'is-offline')}>
              {channelOnline ? <Wifi /> : <WifiOff />}
              {channelOnline ? '通信正常' : '等待连接'}
            </span>
            <span><CalendarDays />{formatDate(clock)}</span>
            <span><Clock3 />{formatTime(clock)}</span>
            <button type="button" className="wutos-icon-button" onClick={onRefresh} title="刷新状态" aria-label="刷新状态"><RefreshCw /></button>
            {onOpenDetails && <button type="button" className="wutos-detail-button" onClick={onOpenDetails}><Settings2 />详情</button>}
          </div>
        </header>

        <Panel title="PLC I/O与继电器" className="wutos-panel--io">
          <div className="wutos-plc-signal-groups">
            <PLCSignalGroup title="输入 / 内部状态" area="inputs" definitions={PLC_INPUT_DEFINITIONS} status={status} />
            <PLCSignalGroup title="自动 / 报警状态" area="internal" definitions={PLC_STATUS_DEFINITIONS} status={status} />
            <PLCSignalGroup title="输出继电器 Q" area="outputs" definitions={PLC_RELAY_DEFINITIONS} status={status} />
          </div>
        </Panel>

        <section className="wutos-stage" aria-label="检测台设备视觉">
          <div className="wutos-stage__sensors wutos-stage__sensors--left">
            {units.slice(0, 3).map((unit, index) => <SensorLiveCard key={index + 1} index={index + 1} unit={unit} status={status} analysis={waveformAnalysis?.units.find((item) => item.index === index + 1)} captureAnalysis={waveformAnalysis} waveformDisplayMode={waveformDisplayMode} waveformMaxSamples={waveformMaxSamples} />)}
          </div>
          <img src={asset('machine-real.png')} className="wutos-machine wutos-machine--real" alt="火焰探测器检测台" />
          <LiveWaveformPanel units={units} status={status} waveformAnalysis={waveformAnalysis} waveformDisplayMode={waveformDisplayMode} waveformMaxSamples={waveformMaxSamples} />
          <div className="wutos-stage__sensors wutos-stage__sensors--right">
            {units.slice(3, 6).map((unit, index) => <SensorLiveCard key={index + 4} index={index + 4} unit={unit} status={status} analysis={waveformAnalysis?.units.find((item) => item.index === index + 4)} captureAnalysis={waveformAnalysis} waveformDisplayMode={waveformDisplayMode} waveformMaxSamples={waveformMaxSamples} />)}
          </div>
          <div className={'wutos-stage__status ' + (isAlarm ? 'is-alarm' : '')}>
            <span />
            <b>{stageText}</b>
            <small title={notice}>{isAlarm ? '请检查设备与安全链路' : status?.valid ? '现场只读状态实时同步' : '等待 PLC / 探测器数据接入'}</small>
          </div>
        </section>

        <Panel title="报警信息" className="wutos-panel--alarm">
          <div className="wutos-alarm-table">
            <div className="wutos-alarm-row wutos-alarm-row--head"><span>时间</span><span>事件</span><span>状态</span></div>
            {alarms.map((row, index) => (
              <div className="wutos-alarm-row" key={row.event + index}>
                <time>{row.time}</time>
                <span title={row.detail}>{row.event}<small>{row.detail}</small></span>
                <b className={row.tone}>{row.state}</b>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="检测结果"
          titleMeta={resultTitleMeta}
          className="wutos-panel--result"
        >
          <div className="wutos-detector-grid">
            {units.map((unit, index) => (
              <DetectorCard
                key={index + 1}
                index={index + 1}
                unit={unit}
                result={detectorVerdict?.units.find((result) => result.index === index + 1)}
                analysis={waveformAnalysis?.units.find((result) => result.index === index + 1)}
                minimumNoiseSamples={waveformAnalysis?.thresholds.minNoiseSamples ?? 1}
                configuredRatios={configuredRatios}
                noiseLimits={noiseLimits}
              />
            ))}
          </div>
          <FinalResultCards finalVerdict={finalVerdict} aPassCount={aPassCount} bPassCount={bPassCount} failCount={failCount} />
        </Panel>

        <Panel title="工序流程" className="wutos-panel--flow">
          <div className="wutos-flow-track">
            {WORKFLOW.map((item, index) => {
              const Icon = item.icon;
              const state = activeWorkflowIndex >= 0 && index < activeWorkflowIndex
                ? 'is-done'
                : index === activeWorkflowIndex
                  ? 'is-current'
                  : '';
              return (
                <span className="wutos-flow-segment" key={item.label + index}>
                <span className={'wutos-flow-node ' + state + (state === 'is-current' && hasActivePLCProcessAlarm(status) ? ' is-alarm' : '')}>
                  <span className="wutos-flow-node__circle">{state === 'is-done' ? <CheckCircle2 /> : <Icon />}</span>
                    <small>{item.label}<b>{item.address}</b></small>
                  </span>
                  {index < WORKFLOW.length - 1 && <WorkflowArrow />}
                </span>
              );
            })}
          </div>
          <div className="wutos-flow-baseline" aria-hidden="true">
            {WORKFLOW.map((item, index) => <i className={index <= activeWorkflowIndex ? 'is-lit' : ''} key={item.label + index} style={{ left: (index / (WORKFLOW.length - 1)) * 100 + '%' }} />)}
          </div>
          <div className="wutos-flow-note"><span>{status?.valid ? 'PLC 工序已同步' : 'PLC 未接入：工序待同步'}</span><code>{status ? 'VW600=' + status.stageCode + ' · VW602=' + status.stepCode : 'READ ONLY'}</code><span>{onlineCount}/6 在线 · 火警 {fireCount} · 故障 {faultCount}</span></div>
        </Panel>
      </div>
    </main>
  );
}
