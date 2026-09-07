import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import {
  summarizeTestProgramRun,
} from './test-program-tracker.js';
import type {
  TestProgramArchive,
  TestProgramArchiveSummary,
  TestProgramDetectorScalarKey,
  TestProgramDetectorStageSummary,
  TestProgramRun,
} from './test-program-types.js';

export interface TestProgramArchiveListItem extends TestProgramArchiveSummary {
  archivedAt: number;
  detailFile: string;
  reportFile: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function datePart(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function localDateTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '-';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function durationText(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return '-';
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function numberText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '-';
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
  DETECTOR_STARTUP_WAITING_FOR_VERTICAL_LOWER_LIMIT: '等待垂直电机下限位',
  MODE_SWITCH_TIMEOUT: '模式切换等待 ACK 超时',
  SIGNAL_NOT_READY: '光源未就绪',
  SYNC_NOT_OK: '同步异常',
  FLASH_SAMPLES_MISSING: '爆闪干扰样本不足',
  EMC_SAMPLES_MISSING: '电磁干扰样本不足',
  HEAT_SAMPLES_MISSING: '热源干扰样本不足',
  ALL_STAGES_A_GRADE_WITHIN_LIMIT: '全部工序达到 A 级指标',
  FLASH_SNR23_ABOVE_LIMIT: '爆闪阶段 P2/P3 信噪比超过上限',
  PASS: '合格',
  FAIL: '不合格',
  PENDING: '待判定',
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
  NOISE: '噪声采集',
  INTERFERENCE: '干扰采集',
};

function decisionText(value: unknown): string {
  let text = String(value ?? '-');
  Object.entries(DECISION_TEXT)
    .sort(([left], [right]) => right.length - left.length)
    .forEach(([code, label]) => { text = text.replaceAll(code, label); });
  return text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, '未映射的判定条件');
}

function cell(value: unknown): string {
  return String(value ?? '-').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function safeRunId(runId: string): string {
  const safe = basename(runId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || `run-${Date.now()}`;
}

function writeAtomic(file: string, content: string): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, file);
}

function stageWaveformRows(run: TestProgramRun): string[][] {
  return run.stages.flatMap((stage) => stage.waveforms.map((waveform) => {
    const channel = waveform.channels.probe2 ?? waveform.channels.probe1;
    return [
      stage.label,
      String(waveform.index),
      String(waveform.sampleCount),
      String(waveform.rawSampleCount),
      numberText(channel?.mean),
      numberText(channel?.rms),
      numberText(channel?.peakToPeak),
      `${localDateTime(waveform.firstAt)} ~ ${localDateTime(waveform.lastAt)}`,
    ];
  }));
}

const DETECTOR_REPORT_KEYS = [
  'probe1',
  'probe2',
  'probe3',
  'probe4',
  'probe1Absolute',
  'probe2Absolute',
  'probe3Absolute',
  'probe4Absolute',
  'probe1Fluctuation',
  'probe2Fluctuation',
  'probe3Fluctuation',
  'probe4Fluctuation',
  'snr21',
  'snr23',
  'snr31',
  'sensitivity',
] as const satisfies readonly TestProgramDetectorScalarKey[];

function detectorValue(detector: TestProgramDetectorStageSummary, key: TestProgramDetectorScalarKey): string {
  return numberText(detector.latest?.[key]);
}

function detectorRange(detector: TestProgramDetectorStageSummary, key: TestProgramDetectorScalarKey): string {
  const stats = detector.stats[key];
  return stats ? `${numberText(stats.min)} ~ ${numberText(stats.max)}` : '-';
}

function stageDetectorLatestRows(run: TestProgramRun): string[][] {
  return run.stages.flatMap((stage) => (stage.detectors ?? []).map((detector) => [
    stage.label,
    `${detector.index} / ${detector.address}`,
    `${detector.observationCount} / ${detector.retainedObservationCount}`,
    localDateTime(detector.lastAt),
    ...DETECTOR_REPORT_KEYS.map((key) => detectorValue(detector, key)),
    `${detector.onlineCount}/${detector.observationCount}`,
    `${detector.faultCount}/${detector.observationCount}`,
    detector.latest?.sourceReady ? '光源就绪' : '光源未就绪',
    detector.latest?.syncOk ? '同步正常' : '同步异常',
  ]));
}

function stageDetectorRangeRows(run: TestProgramRun): string[][] {
  return run.stages.flatMap((stage) => (stage.detectors ?? []).map((detector) => [
    stage.label,
    String(detector.index),
    `${localDateTime(detector.firstAt)} ~ ${localDateTime(detector.lastAt)}`,
    ...DETECTOR_REPORT_KEYS.map((key) => detectorRange(detector, key)),
  ]));
}

export function renderTestProgramReport(run: TestProgramRun): string {
  const summary = summarizeTestProgramRun(run);
  const stageRows = run.stages.map((stage) => [
    String(stage.sequence),
    stage.label,
    localDateTime(stage.startedAt),
    localDateTime(stage.endedAt),
    durationText(stage.durationMs),
    stage.plannedDurationMs === null ? '未配置' : durationText(stage.plannedDurationMs),
    stage.durationDeltaMs === null ? '-' : `${stage.durationDeltaMs >= 0 ? '+' : '-'}${durationText(Math.abs(stage.durationDeltaMs))}`,
    stage.withinPlan === null ? '仅统计' : stage.withinPlan ? '在计划内' : '超计划',
    String(stage.relayEventCount),
    String(stage.waveforms.reduce((total, waveform) => total + waveform.sampleCount, 0)),
    stage.decisionBasis.map(decisionText).join('；') || '-',
  ]);
  const relayRows = run.relayEvents.map((event) => [
    localDateTime(event.timestamp),
    decisionText(event.stageId),
    event.address,
    event.label,
    event.before === null ? '-' : event.before ? 'ON' : 'OFF',
    event.value ? 'ON' : 'OFF',
  ]);
  const waveformRows = stageWaveformRows(run);
  const decisionRows = [
    ['最终判定', decisionText(run.decision.verdict)],
    ['等级', decisionText(run.decision.grade)],
    ['判定时间', localDateTime(run.decision.evaluatedAt)],
    ['判定原因', run.decision.reasons.map(decisionText).join('；') || '-'],
    ['依据摘要', run.decision.basis.map(decisionText).join('；') || '-'],
  ];
  const lines = [
    '# 测试程序归档报告',
    '',
    `- 测试批次：${cell(run.runId)}`,
    `- 状态：${run.status}`,
    `- 开始：${localDateTime(run.startedAt)}`,
    `- 结束：${localDateTime(run.endedAt)}`,
    `- 总耗时：${durationText(run.durationMs)}`,
    `- 阶段数：${summary.stageCount}（完成 ${summary.completedStageCount}）`,
    `- 继电器事件：${summary.relayEventCount}，波形样本：${summary.waveformSampleCount}，探测器观测：${summary.detectorObservationCount}`,
    '',
    '## 阶段时序与判断',
    '',
    '| 序号 | 阶段 | 开始 | 结束 | 实际时长 | 规划时长 | 偏差 | 计划判断 | 继电器事件 | 波形样本 | 判断依据 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |',
    ...stageRows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
    '## 继电器输出变化',
    '',
    '| 时间 | 所属阶段 | 地址 | 信号 | 变化前 | 变化后 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(relayRows.length ? relayRows.map((row) => `| ${row.map(cell).join(' | ')} |`) : ['| - | - | - | - | - | - |']),
    '',
    '## 波形采样摘要',
    '',
    '| 阶段 | 设备 | 处理样本 | 原始样本 | P2/P1均值通道 | RMS | 峰峰值 | 采样时间范围 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...(waveformRows.length ? waveformRows.map((row) => `| ${row.map(cell).join(' | ')} |`) : ['| - | - | 0 | 0 | - | - | - | - |']),
    '',
    '## 分阶段探测器数值',
    '',
    '每行对应一个工序阶段和一台探测器；“观测/保留”同时保留完整计数与 JSON 中的有界明细，最新值用于现场回看，统计范围用于判断稳定性和阈值依据。',
    '',
    '### 最新值与状态',
    '',
    '| 阶段 | 设备/地址 | 观测/保留 | 最后采样 | P1 | P2 | P3 | P4 | 绝对P1 | 绝对P2 | 绝对P3 | 绝对P4 | 波动P1 | 波动P2 | 波动P3 | 波动P4 | SNR21 | SNR23 | SNR31 | 灵敏度 | 在线 | 故障 | 光源 | 同步 |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...(stageDetectorLatestRows(run).length
      ? stageDetectorLatestRows(run).map((row) => `| ${row.map(cell).join(' | ')} |`)
      : ['| - | - | 0 / 0 | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |']),
    '',
    '### 数值统计范围（最小值 ~ 最大值）',
    '',
    '| 阶段 | 设备 | 采样时间范围 | P1 | P2 | P3 | P4 | 绝对P1 | 绝对P2 | 绝对P3 | 绝对P4 | 波动P1 | 波动P2 | 波动P3 | 波动P4 | SNR21 | SNR23 | SNR31 | 灵敏度 |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(stageDetectorRangeRows(run).length
      ? stageDetectorRangeRows(run).map((row) => `| ${row.map(cell).join(' | ')} |`)
      : ['| - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |']),
    '',
    '## 判定依据',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    ...decisionRows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
    '原始波形、正式程序分析快照、阈值配置和探测器判定保存在同目录 JSON 文件中，可供后续算法离线回放。',
    '',
  ];
  return lines.join('\n');
}

function defaultDirectory(): string {
  return process.env.TEST_PROGRAM_DATA_DIR
    || join(process.env.APP_DATA_DIR || process.cwd(), 'test-program');
}

export class TestProgramArchiveStore {
  readonly directory: string;
  readonly resultLogFile: string;
  private readonly archiveDirectory: string;
  private readonly indexFile: string;
  private readonly resultLogDirectory: string;

  constructor(
    directory = defaultDirectory(),
    resultLogDirectory = process.env.TEST_PROGRAM_RESULT_LOG_DIR || join(directory, 'logs'),
  ) {
    this.directory = resolve(directory);
    this.archiveDirectory = join(this.directory, 'archives');
    this.indexFile = join(this.archiveDirectory, 'index.jsonl');
    this.resultLogDirectory = resolve(resultLogDirectory);
    this.resultLogFile = join(this.resultLogDirectory, 'test-results.log');
    mkdirSync(this.archiveDirectory, { recursive: true });
  }

  store(run: TestProgramRun): TestProgramArchive {
    const archivedAt = Date.now();
    const runDate = datePart(run.endedAt ?? run.startedAt);
    const dateDirectory = join(this.archiveDirectory, runDate);
    mkdirSync(dateDirectory, { recursive: true });
    const safeId = safeRunId(run.runId);
    const detailFile = join(dateDirectory, `${safeId}.json`);
    const reportFile = join(dateDirectory, `${safeId}.md`);
    const relativeDetailFile = relative(this.directory, detailFile).replaceAll('\\', '/');
    const relativeReportFile = relative(this.directory, reportFile).replaceAll('\\', '/');
    const archive: TestProgramArchive = {
      ...clone(run),
      archivedAt,
      reportFile: relativeReportFile,
    };
    writeAtomic(detailFile, `${JSON.stringify(archive, null, 2)}\n`);
    writeAtomic(reportFile, renderTestProgramReport(run));

    const item: TestProgramArchiveListItem = {
      ...summarizeTestProgramRun(run),
      archivedAt,
      detailFile: relativeDetailFile,
      reportFile: relativeReportFile,
    };
    const entries = this.readIndex().filter((entry) => entry.runId !== item.runId);
    entries.unshift(item);
    writeAtomic(this.indexFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
    this.appendResultLog(item);
    return archive;
  }

  list(limit = 50): TestProgramArchiveListItem[] {
    const bounded = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 50;
    return this.readIndex().slice(0, bounded);
  }

  get(runId: string): TestProgramArchive | null {
    const entry = this.readIndex().find((item) => item.runId === runId);
    if (!entry) return null;
    const file = this.safeFile(entry.detailFile);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as TestProgramArchive;
    } catch {
      return null;
    }
  }

  report(runId: string): string | null {
    const entry = this.readIndex().find((item) => item.runId === runId);
    if (!entry) return null;
    const file = this.safeFile(entry.reportFile);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8');
  }

  private readIndex(): TestProgramArchiveListItem[] {
    if (!existsSync(this.indexFile)) return [];
    return readFileSync(this.indexFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as TestProgramArchiveListItem;
          return entry && typeof entry.runId === 'string' ? [entry] : [];
        } catch {
          return [];
        }
      });
  }

  private appendResultLog(item: TestProgramArchiveListItem): void {
    mkdirSync(this.resultLogDirectory, { recursive: true });
    const clean = (value: unknown): string => String(value ?? '-').replace(/[|\r\n]/g, ' ');
    const runId = clean(item.runId);
    const existing = existsSync(this.resultLogFile) ? readFileSync(this.resultLogFile, 'utf8') : '';
    if (existing.split(/\r?\n/).some((line) => line.includes(`| run=${runId} |`))) return;
    const line = [
      localDateTime(item.archivedAt),
      `run=${runId}`,
      `status=${clean(item.status)}`,
      `result=${clean(item.verdict)}`,
      `grade=${clean(item.grade)}`,
      `duration=${durationText(item.durationMs)}`,
      `stages=${item.completedStageCount}/${item.stageCount}`,
      `relays=${item.relayEventCount}`,
      `detectors=${item.detectorObservationCount}`,
      `waveforms=${item.waveformSampleCount}`,
    ].join(' | ');
    appendFileSync(this.resultLogFile, `${line}\n`, 'utf8');
  }

  private safeFile(relativeFile: string): string {
    const root = resolve(this.directory);
    const file = resolve(root, relativeFile);
    if (file !== root && !file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) {
      throw new Error('TEST_PROGRAM_ARCHIVE_PATH_INVALID');
    }
    return file;
  }
}
