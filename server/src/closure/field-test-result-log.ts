import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldDetectorBatchVerdict, FieldDetectorMetrics, FieldDetectorResult } from './field-detector-verdict.js';
import type { FieldFinalVerdict } from './field-final-verdict.js';
import type { FlameDetectorState } from '../types.js';
import {
  formatSoftwareVersion,
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from '../product-profile.js';
import {
  DEFAULT_DETECTION_QUALITY_CONFIG,
  normalizeDetectionQualityConfig,
  type DetectionQualityConfig,
  type FieldWaveformAnalysisSnapshot,
  type WaveformAnalysisConfig,
} from './field-waveform-analysis.js';

export interface CompletedFieldTest {
  batchId: string;
  startedAt: number | null;
  completedAt: number;
  finalVerdict: FieldFinalVerdict;
  detectorVerdict: FieldDetectorBatchVerdict;
  thresholds: WaveformAnalysisConfig;
  waveformAnalysis?: FieldWaveformAnalysisSnapshot;
  inspectionPositions: InspectionPositionResult[];
  productConfig?: ProductDetectionConfig;
  productPrecheck?: ProductPrecheckReport | null;
}

export type InspectionPositionId = 'DETECTION_POSITION_1_HEAT' | 'DETECTION_POSITION_2_FLASH';

export interface InspectionPositionResult {
  id: InspectionPositionId;
  label: string;
  status: 'CAPTURED' | 'NOT_OBSERVED';
  startedAt: number | null;
  completedAt: number | null;
  devices: Array<{
    index: number;
    address: number;
    sampledAt: number;
    online: boolean;
    fire: boolean;
    fault: boolean;
    sourceReady: boolean;
    syncOk: boolean;
    probes: { probe1: number; probe2: number; probe3: number; probe4?: number };
    ratios: { snr21: number; snr23: number; snr31: number };
    lastError?: string;
  }>;
}

export function captureInspectionPosition(
  id: InspectionPositionId,
  label: string,
  startedAt: number | null,
  completedAt: number,
  state: FlameDetectorState,
): InspectionPositionResult {
  return {
    id,
    label,
    status: 'CAPTURED',
    startedAt,
    completedAt,
    devices: state.units.map((unit) => ({
      index: unit.index,
      address: unit.address,
      sampledAt: unit.lastUpdate,
      online: unit.online,
      fire: unit.fire,
      fault: unit.fault,
      sourceReady: unit.sourceReady,
      syncOk: unit.syncOk,
      probes: {
        probe1: unit.probe1,
        probe2: unit.probe2,
        probe3: unit.probe3,
        ...(unit.probe4 !== undefined ? { probe4: unit.probe4 } : {}),
      },
      ratios: { snr21: unit.snr21, snr23: unit.snr23, snr31: unit.snr31 },
      ...(unit.lastError ? { lastError: unit.lastError } : {}),
    })),
  };
}

export interface FieldTestResultLogger {
  record(test: CompletedFieldTest): string | void;
}

interface NumericFailureDetail {
  code: string;
  metric: keyof FieldDetectorMetrics;
  value: number;
  operator: '<=' | '>=';
  limit: number;
  thresholdGrade: 'A' | 'B';
}

function datePart(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function rotateCorruptLog(file: string): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  const firstContent = content.trimStart()[0];
  if (!content.includes('\0') && (!firstContent || firstContent === '{' || firstContent === '=')) return;
  let backup = `${file}.corrupt-${Date.now()}`;
  let sequence = 1;
  while (existsSync(backup)) backup = `${file}.corrupt-${Date.now()}-${sequence++}`;
  renameSync(file, backup);
}

function gradeText(grade: FieldDetectorResult['grade'] | undefined): string {
  if (grade === 'A_PASS') return 'A类合格';
  if (grade === 'B_PASS') return 'B类合格';
  if (grade === 'FAIL') return '不合格';
  return '待检测';
}

const REASON_TEXT: Record<string, string> = {
  A_GRADE_WITHIN_LIMIT: '全部指标满足 A 类限值',
  ALL_STAGES_A_GRADE_WITHIN_LIMIT: '全部工序满足 A 类限值',
  B_GRADE_WITHIN_LIMIT: '全部指标满足 B 类限值',
  DETECTOR_FAULT: '探测器故障',
  DETECTOR_OFFLINE: '探测器离线',
  DETECTOR_SOURCE_NOT_READY: '光源未就绪',
  DETECTOR_SYNC_NOT_OK: '同步异常',
  SOFTWARE_VERSION_NOT_CONFIGURED: '未配置软件版本基准',
  SOFTWARE_VERSION_MISMATCH: '软件版本不一致',
  PROBE_COUNT_MISMATCH: '探头数量不一致',
  DETECTOR_FAULT_AT_PRECHECK: '产品预检时探测器故障',
  PRECHECK_READ_FAILED: '产品预检读取失败',
  PRODUCT_PRECHECK_NOT_COMPLETED: '产品预检未完成',
  NOISE_RMS_BELOW_LIMIT: '噪声波动值低于下限',
  NOISE_RMS_EXCEEDS_LIMIT: '噪声 RMS 超过上限',
  NOISE_ABSOLUTE_EXCEEDS_LIMIT: '噪声绝对值超过上限',
  INTERFERENCE_RATIO_EXCEEDS_LIMIT: '干扰比超过上限',
  CONSISTENCY_TREND_BELOW_LIMIT: '一致性低于下限',
  SENSITIVITY_BELOW_LIMIT: '灵敏度低于下限',
  SNR21_BELOW_LIMIT: 'P2/P1 信噪比低于下限',
  SNR21_ABOVE_LIMIT: 'P2/P1 信噪比高于上限',
  SNR23_BELOW_LIMIT: 'P2/P3 信噪比低于下限',
  SNR23_ABOVE_LIMIT: 'P2/P3 信噪比高于上限',
  SNR31_BELOW_LIMIT: 'P3/P1 信噪比低于下限',
  SNR31_ABOVE_LIMIT: 'P3/P1 信噪比高于上限',
};

function reasonText(unit: FieldDetectorResult): string {
  const reason = unit.reason ?? '';
  if (reason.endsWith('_SIGNAL_NO_DATA')) return '探头疑似无有效数据（高绝对值/低波动）';
  const direct = REASON_TEXT[reason];
  if (direct) return direct;
  const suffix = Object.keys(REASON_TEXT).find((code) => reason.endsWith(code));
  return suffix ? REASON_TEXT[suffix] : reason;
}

function resultText(verdict: 'PASS' | 'FAIL' | 'PENDING'): string {
  return verdict === 'PASS' ? '合格' : verdict === 'FAIL' ? '不合格' : '待检测';
}

function precheckReasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

function valueText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

const STAGES = [
  ['heat', '热源检测'],
  ['flash', '爆闪检测'],
  ['emc', '电磁干扰'],
] as const;

function stageReason(reason: string | undefined): string {
  if (!reason) return '未采集';
  if (reason === 'STAGE_WITHIN_LIMIT') return '指标正常';
  if (reason.endsWith('_SAMPLES_MISSING')) return '采样不足';
  if (reason === 'WAITING_FOR_STAGE_SAMPLES') return '等待采样';
  if (reason === 'WAITING_FOR_PROCESS_COMPLETE') return '等待工序完成';
  return reason;
}

function positionState(device: InspectionPositionResult['devices'][number]): string {
  return [
    device.online ? '在线' : '离线',
    device.fire ? '火警' : '无火警',
    device.fault ? '故障' : '无故障',
    device.sourceReady ? '光源就绪' : '光源未就绪',
    device.syncOk ? '同步正常' : '同步异常',
    ...(device.lastError ? [`异常：${device.lastError}`] : []),
  ].join('、');
}

function numericFailures(unit: FieldDetectorResult, quality: DetectionQualityConfig): NumericFailureDetail[] {
  if (unit.grade !== 'FAIL') return [];
  const thresholdGrade = 'B' as const;
  const limits = quality.b;
  const ratios = quality.ratios.b;
  const failures: NumericFailureDetail[] = [];
  const upper = (metric: keyof FieldDetectorMetrics, limit: number | undefined, code: string) => {
    const value = unit.metrics[metric];
    if (value !== null && limit != null && limit > 0 && value > limit) {
      failures.push({ code, metric, value, operator: '<=', limit, thresholdGrade });
    }
  };
  const lower = (metric: keyof FieldDetectorMetrics, limit: number | undefined, code: string) => {
    const value = unit.metrics[metric];
    if (value !== null && limit != null && limit > 0 && value < limit) {
      failures.push({ code, metric, value, operator: '>=', limit, thresholdGrade });
    }
  };
  upper('noiseRms', limits.maxNoiseRms, 'NOISE_RMS_EXCEEDS_LIMIT');
  upper('noiseAbsolute', limits.maxNoiseAbsolute, 'NOISE_ABSOLUTE_EXCEEDS_LIMIT');
  upper('interferenceRatio', limits.maxInterferenceRatio, 'INTERFERENCE_RATIO_EXCEEDS_LIMIT');
  lower('consistencyTrend', limits.minConsistencyTrend, 'CONSISTENCY_TREND_BELOW_LIMIT');
  if (ratios) {
    lower('snr21', ratios.snr21.min, 'SNR21_BELOW_LIMIT'); upper('snr21', ratios.snr21.max, 'SNR21_ABOVE_LIMIT');
    lower('snr23', ratios.snr23.min, 'SNR23_BELOW_LIMIT'); upper('snr23', ratios.snr23.max, 'SNR23_ABOVE_LIMIT');
    lower('snr31', ratios.snr31.min, 'SNR31_BELOW_LIMIT'); upper('snr31', ratios.snr31.max, 'SNR31_ABOVE_LIMIT');
  }
  lower('sensitivity', limits.minSensitivity, 'SENSITIVITY_BELOW_LIMIT');
  return failures;
}

export class FileFieldTestResultLogger implements FieldTestResultLogger {
  constructor(private readonly directory = process.env.TEST_RESULT_LOG_DIR || join(process.env.APP_DATA_DIR || process.cwd(), 'logs')) {}

  record(test: CompletedFieldTest): string {
    mkdirSync(this.directory, { recursive: true });
    const quality = normalizeDetectionQualityConfig(
      test.thresholds.quality,
      DEFAULT_DETECTION_QUALITY_CONFIG,
    );
    const file = join(this.directory, `test-results-${datePart(test.completedAt)}.log`);
    rotateCorruptLog(file);
    const units = test.detectorVerdict.units;
    const analysisByIndex = new Map((test.waveformAnalysis?.units ?? []).map((unit) => [unit.index, unit]));
    const durationMs = test.startedAt === null ? null : Math.max(0, test.completedAt - test.startedAt);
    const finalResult = resultText(test.finalVerdict.verdict);
    const finalGrade = gradeText(test.finalVerdict.grade);
    const profile = test.productConfig ? selectedProductProfile(test.productConfig) : null;
    const summary = [
      `批次：${test.batchId}`,
      ...(test.productConfig ? [`产品：${profile?.label ?? test.productConfig.selectedType}`] : []),
      ...(profile ? [`版本基准：${profile.expectedSoftwareVersion ? formatSoftwareVersion(profile.expectedSoftwareVersion) : '未配置'}`] : []),
      ...(profile ? [`探头基准：${profile.expectedProbeCount}`] : []),
      `结果：${finalResult}`,
      `等级：${finalGrade}`,
      `耗时：${durationMs === null ? '未知' : `${(durationMs / 1000).toFixed(1)}秒`}`,
      `设备：${units.length}（A ${units.filter((unit) => unit.grade === 'A_PASS').length} / B ${units.filter((unit) => unit.grade === 'B_PASS').length} / NG ${units.filter((unit) => unit.grade === 'FAIL').length} / 待检 ${units.filter((unit) => unit.grade === 'PENDING').length}）`,
    ].join(' | ');

    const precheckRows = (test.productPrecheck?.units ?? []).map((unit) => [
      String(unit.index),
      String(unit.address),
      unit.actualSoftwareVersion ?? '读取失败',
      unit.expectedSoftwareVersion ? formatSoftwareVersion(unit.expectedSoftwareVersion) : '未配置',
      valueText(unit.actualProbeCount),
      String(unit.expectedProbeCount),
      unit.fireAlarm === null ? '-' : unit.fireAlarm ? '有火警' : '无火警',
      unit.fault === null ? '-' : unit.fault ? '故障' : '无故障',
      unit.verdict === 'PASS' ? '通过' : unit.verdict === 'FAIL' ? '异常' : '待检',
      unit.reasons.length ? unit.reasons.map(precheckReasonText).join('；') : '-',
    ]);

    const deviceRows = units.map((unit) => {
      const metrics = unit.metrics;
      const failures = numericFailures(unit, quality);
      const detail = failures.length
        ? failures.map((failure) => `${valueText(failure.value)} ${failure.operator === '<=' ? '≤' : '≥'} ${valueText(failure.limit)}`).join('；')
        : '';
      const noData = unit.noDataProbes?.length ? `无数据探头：${unit.noDataProbes.map((probe) => probe.replace('probe', 'P')).join('/')}` : '';
      const explanation = [reasonText(unit), noData, detail && `（${detail}）`].filter(Boolean).join('；');
      return [
        String(unit.index), String(unit.address), gradeText(unit.grade),
        valueText(metrics.noiseRms), valueText(metrics.noisePeakToPeak), valueText(metrics.noiseAbsolute),
        valueText(metrics.interferenceRatio), valueText(metrics.consistencyTrend),
        valueText(metrics.snr21), valueText(metrics.snr23), valueText(metrics.snr31), valueText(metrics.sensitivity),
        explanation || '-',
      ];
    });

    const processRows = units.flatMap((unit) => {
      const analysis = analysisByIndex.get(unit.index);
      return STAGES.map(([stageId, label]) => {
        const stage = analysis?.stages?.[stageId];
        return [
          label, String(unit.index), valueText(stage?.sampleCount), valueText(stage?.interferenceRatio),
          valueText(stage?.consistencyTrend), valueText(stage?.snr21), valueText(stage?.snr23), valueText(stage?.snr31),
          stage ? resultText(stage.verdict) : '未采集', stageReason(stage?.reason),
        ];
      });
    });

    const positionRows = test.inspectionPositions.flatMap((position) => position.devices.length
      ? position.devices.map((device) => [
        position.label, String(device.index), valueText(device.probes.probe1), valueText(device.probes.probe2),
        valueText(device.probes.probe3), valueText(device.probes.probe4), valueText(device.ratios.snr21),
        valueText(device.ratios.snr23), valueText(device.ratios.snr31), positionState(device),
      ])
      : [[position.label, '-', '-', '-', '-', '-', '-', '-', '-', position.status === 'CAPTURED' ? '已采集（无设备数据）' : '未检测']]);

    const lines = [
      '='.repeat(96),
      `完成时间：${localDateTime(test.completedAt)}`,
      summary,
      '',
      '产品预检',
      ...(precheckRows.length
        ? table(['设备', '地址', '实际版本', '期望版本', '实际探头数', '期望探头数', '报警', '故障', '结果', '说明'], precheckRows)
        : ['未记录产品预检结果']),
      '',
      '设备结果明细',
      ...table(
        ['设备', '地址', '结果', '噪声RMS', '噪声峰峰值', '绝对值', '干扰比', '一致性', 'P2/P1', 'P2/P3', 'P3/P1', '灵敏度', '说明'],
        deviceRows,
      ),
      '',
      '工序检测明细',
      ...table(
        ['工序', '设备', '采样数', '干扰比', '一致性', 'P2/P1', 'P2/P3', 'P3/P1', '结果', '说明'],
        processRows,
      ),
      '',
      '检测位原始数值',
      ...table(
        ['检测位', '设备', 'P1', 'P2', 'P3', 'P4', 'P2/P1', 'P2/P3', 'P3/P1', '状态说明'],
        positionRows,
      ),
      '',
    ];
    appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return file;
  }
}
