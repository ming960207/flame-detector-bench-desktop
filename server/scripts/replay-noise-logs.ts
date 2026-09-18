import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOW_MS = 10_000;
const CHANNELS = ['P2', 'P3'] as const;
type Channel = (typeof CHANNELS)[number];
type Grade = 'A' | 'B' | 'NG';

interface RawBand {
  count: number | null;
  min: number | null;
  max: number | null;
  fluctuation: number | null;
  absoluteMax: number | null;
}

interface TrendPoint {
  at: number;
  last: Record<Channel, RawBand | null>;
  cumulative: Record<Channel, RawBand | null>;
}

interface BatchLog {
  batchId: string;
  captureStartAt: number;
  captureEndAt: number | null;
  durationMs: number | null;
  trends: Map<number, TrendPoint[]>;
  source: string;
}

interface ResultUnit {
  index: number;
  grade: Grade;
  fluctuation: Record<Channel, number | null>;
  absoluteMax: Record<Channel, number | null>;
  reason: string;
}

interface ResultBatch {
  batchId: string;
  counts: Record<Grade, number>;
  units: Map<number, ResultUnit>;
  source: string;
}

interface ReplayChannel {
  lowerBound: number | null;
  estimate: number | null;
  upperBound: number | null;
  fullStage: number | null;
  absoluteMax: number | null;
}

interface ReplayUnit {
  batchId: string;
  index: number;
  oldGrade: Grade;
  projectedGrade: Grade;
  noiseEstimateGrade: Grade | null;
  noiseRelated: boolean;
  channels: Record<Channel, ReplayChannel>;
  lowerBound: number | null;
  estimate: number | null;
  upperBound: number | null;
  absoluteMax: number | null;
  possibleGrades: Grade[];
  finalPossibleGrades: Grade[];
  preservedByOtherFailure: boolean;
}

const NUMBER_PATTERN = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';

function parseNumber(value: string | undefined): number | null {
  if (!value || value === '-') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldNumber(body: string, field: string): number | null {
  const match = body.match(new RegExp(`(?:^|,)${field}=(${NUMBER_PATTERN}|-)`));
  return parseNumber(match?.[1]);
}

function parseRawBand(body: string): RawBand {
  return {
    count: fieldNumber(body, 'n'),
    min: fieldNumber(body, 'min'),
    max: fieldNumber(body, 'max'),
    fluctuation: fieldNumber(body, 'fluct'),
    absoluteMax: fieldNumber(body, 'abs'),
  };
}

function parseBandMap(section: string, label: 'Rlast' | 'Rcum'): Record<Channel, RawBand | null> {
  const result = {} as Record<Channel, RawBand | null>;
  for (const channel of CHANNELS) result[channel] = null;
  const match = section.match(new RegExp(`${label}\\[([^\\]]*)\\]`));
  if (!match) return result;
  for (const channel of CHANNELS) {
    const channelMatch = match[1].match(new RegExp(`${channel}\\{([^}]*)\\}`));
    if (channelMatch) result[channel] = parseRawBand(channelMatch[1]);
  }
  return result;
}

function parseLatestLog(file: string): BatchLog[] {
  const batches: BatchLog[] = [];
  let current: BatchLog | null = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const start = line.match(/\[噪声窗口\] 开始 batch=([^ ]+).*?captureStartAt=(\d+)\//);
    if (start) {
      if (current) batches.push(current);
      current = {
        batchId: start[1],
        captureStartAt: Number(start[2]),
        captureEndAt: null,
        durationMs: null,
        trends: new Map(),
        source: file,
      };
      continue;
    }
    if (!current) continue;

    const trend = line.match(/\[噪声窗口\]\[每秒\] at=(\d+)\//);
    if (trend) {
      const at = Number(trend[1]);
      const deviceMatches = line.matchAll(/D(\d+)\{([\s\S]*?)(?= D\d+\{frames=|$)/g);
      for (const deviceMatch of deviceMatches) {
        const index = Number(deviceMatch[1]);
        const point: TrendPoint = {
          at,
          last: parseBandMap(deviceMatch[2], 'Rlast'),
          cumulative: parseBandMap(deviceMatch[2], 'Rcum'),
        };
        const points = current.trends.get(index) ?? [];
        points.push(point);
        current.trends.set(index, points);
      }
      continue;
    }

    const end = line.match(/\[噪声窗口\] 结束 batch=([^ ]+).*?captureEndAt=(\d+).*?durationMs=(\d+)/);
    if (end) {
      if (end[1] === current.batchId) {
        current.captureEndAt = Number(end[2]);
        current.durationMs = Number(end[3]);
        batches.push(current);
        current = null;
      }
    }
  }
  if (current) batches.push(current);
  for (const batch of batches) {
    for (const points of batch.trends.values()) points.sort((a, b) => a.at - b.at);
  }
  return batches;
}

function parsePair(value: string, channel: Channel): number | null {
  const match = value.match(new RegExp(`${channel}:\\s*(${NUMBER_PATTERN}|-)`));
  return parseNumber(match?.[1]);
}

function parseGrade(value: string): Grade | null {
  if (value === 'A类合格') return 'A';
  if (value === 'B类合格') return 'B';
  if (value === '不合格') return 'NG';
  return null;
}

function parseResultFiles(files: string[]): ResultBatch[] {
  const batches: ResultBatch[] = [];
  let current: ResultBatch | null = null;
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const header = line.match(/^批次：([^ |]+).*?设备：6（A (\d+) \/ B (\d+) \/ NG (\d+) /);
      if (header) {
        current = {
          batchId: header[1],
          counts: { A: Number(header[2]), B: Number(header[3]), NG: Number(header[4]) },
          units: new Map(),
          source: file,
        };
        batches.push(current);
        continue;
      }
      if (!current) continue;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 15 || !/^\d+$/.test(cells[0] ?? '')) continue;
      const grade = parseGrade(cells[2] ?? '');
      if (!grade) continue;
      const index = Number(cells[0]);
      current.units.set(index, {
        index,
        grade,
        fluctuation: {
          P2: parsePair(cells[3] ?? '', 'P2'),
          P3: parsePair(cells[3] ?? '', 'P3'),
        },
        absoluteMax: {
          P2: parsePair(cells[4] ?? '', 'P2'),
          P3: parsePair(cells[4] ?? '', 'P3'),
        },
        reason: cells[14] ?? '',
      });
    }
  }
  return batches;
}

function latestBand(points: TrendPoint[], channel: Channel): RawBand | null {
  return points.at(-1)?.cumulative[channel] ?? null;
}

function maxFrameFluctuation(points: TrendPoint[], channel: Channel, startAt: number): number | null {
  const values = points
    .filter((point) => point.at - startAt >= WINDOW_MS)
    .map((point) => point.last[channel]?.fluctuation)
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

/**
 * Estimate the rolling window by combining the per-second Rlast frames that
 * fall into each 10-second interval. This is deliberately not called exact:
 * latest.log does not contain every sample or an individual sample timestamp.
 */
function estimateFrameSampledRolling(points: TrendPoint[], channel: Channel, startAt: number): number | null {
  const eligible = points.filter((point) => point.at - startAt >= WINDOW_MS);
  let maximum: number | null = null;
  for (const endpoint of eligible) {
    const window = points.filter((point) => point.at >= endpoint.at - WINDOW_MS && point.at <= endpoint.at);
    const bands = window
      .map((point) => point.last[channel])
      .filter((band): band is RawBand => band !== null && band.min !== null && band.max !== null);
    if (!bands.length) continue;
    const min = Math.min(...bands.map((band) => band.min!));
    const max = Math.max(...bands.map((band) => band.max!));
    const fluctuation = (max - min) / 2;
    maximum = maximum === null ? fluctuation : Math.max(maximum, fluctuation);
  }
  return maximum;
}

function rangeGrades(lower: number | null, upper: number | null, absoluteMax: number | null): Grade[] {
  if (absoluteMax !== null && absoluteMax > 1_100) return ['NG'];
  if (lower === null || upper === null) return ['A', 'B', 'NG'];
  const result: Grade[] = [];
  if (lower <= 200) result.push('A');
  if (lower <= 220 && upper > 200) result.push('B');
  if (upper > 220) result.push('NG');
  return result.length ? result : ['NG'];
}

function estimatedGrade(value: number | null, absoluteMax: number | null): Grade | null {
  if (value === null) return null;
  if (absoluteMax !== null && absoluteMax > 1_100) return 'NG';
  if (value <= 200) return 'A';
  if (value <= 220) return 'B';
  return 'NG';
}

function rate(count: number, total: number): string {
  return total > 0 ? `${count}/${total}=${(count * 100 / total).toFixed(1)}%` : `${count}/${total}=n/a`;
}

function replayUnit(log: BatchLog, result: ResultUnit): ReplayUnit {
  const points = log.trends.get(result.index) ?? [];
  const channels = {} as Record<Channel, ReplayChannel>;
  for (const channel of CHANNELS) {
    const cumulative = latestBand(points, channel);
    const fullStage = result.fluctuation[channel] ?? cumulative?.fluctuation ?? null;
    const absoluteMax = result.absoluteMax[channel] ?? cumulative?.absoluteMax ?? null;
    const lowerBound = maxFrameFluctuation(points, channel, log.captureStartAt);
    const estimate = estimateFrameSampledRolling(points, channel, log.captureStartAt);
    channels[channel] = {
      lowerBound,
      estimate,
      upperBound: fullStage === null ? lowerBound : Math.max(fullStage, lowerBound ?? 0),
      fullStage,
      absoluteMax,
    };
  }
  const lowerBoundValues = CHANNELS.map((channel) => channels[channel].lowerBound).filter((value): value is number => value !== null);
  const estimateValues = CHANNELS.map((channel) => channels[channel].estimate).filter((value): value is number => value !== null);
  const upperBoundValues = CHANNELS.map((channel) => channels[channel].upperBound).filter((value): value is number => value !== null);
  const absoluteValues = CHANNELS.map((channel) => channels[channel].absoluteMax).filter((value): value is number => value !== null);
  const lowerBound = lowerBoundValues.length ? Math.max(...lowerBoundValues) : null;
  const estimate = estimateValues.length ? Math.max(...estimateValues) : null;
  const upperBound = upperBoundValues.length ? Math.max(...upperBoundValues) : null;
  const absoluteMax = absoluteValues.length ? Math.max(...absoluteValues) : null;
  const noiseEstimateGrade = estimatedGrade(estimate, absoluteMax);
  const possibleGrades = rangeGrades(lowerBound, upperBound, absoluteMax);
  const noiseRelated = /噪声波动值|波动\s*[0-9]+|NOISE/i.test(result.reason);
  const nonNoiseFailure = /模式已切换，等待首帧同步|绝对值|信噪比|干扰|一致性|灵敏度|故障|无数据/.test(result.reason);
  const finalPossibleGrades = noiseRelated && !nonNoiseFailure ? possibleGrades : [result.grade];
  const projectedGrade = noiseRelated && !nonNoiseFailure && noiseEstimateGrade ? noiseEstimateGrade : result.grade;
  return {
    batchId: log.batchId,
    index: result.index,
    oldGrade: result.grade,
    projectedGrade,
    noiseEstimateGrade,
    noiseRelated,
    channels,
    lowerBound,
    estimate,
    upperBound,
    absoluteMax,
    possibleGrades,
    finalPossibleGrades,
    preservedByOtherFailure: nonNoiseFailure,
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '../..');
  const logRoot = resolve(option('--logs') ?? join(repoRoot, 'diagnostic-logs'));
  const jsonOutput = process.argv.includes('--json');
  const packageDirs = readdirSync(logRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^20260911/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const logBatches: BatchLog[] = [];
  const resultFiles: string[] = [];
  for (const directory of packageDirs) {
    const backend = join(logRoot, directory.name, 'backend');
    const latest = join(backend, 'latest.log');
    if (readFileSafe(latest) !== null) logBatches.push(...parseLatestLog(latest));
    const files = readdirSync(backend, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^test-results.*\.log$/.test(entry.name))
      .map((entry) => join(backend, entry.name));
    resultFiles.push(...files);
  }
  const resultBatches = parseResultFiles(resultFiles);
  const resultsByBatch = new Map(resultBatches.map((batch) => [batch.batchId, batch]));
  const logsByBatch = new Map(logBatches.map((batch) => [batch.batchId, batch]));
  const unmatchedLogBatchIds = logBatches
    .map((batch) => batch.batchId)
    .filter((batchId) => !resultsByBatch.has(batchId));
  const replayed: ReplayUnit[] = [];
  for (const result of resultBatches) {
    const log = logsByBatch.get(result.batchId);
    if (!log) continue;
    for (const unit of result.units.values()) replayed.push(replayUnit(log, unit));
  }

  const baseline = resultBatches.reduce((sum, batch) => ({
    A: sum.A + batch.counts.A,
    B: sum.B + batch.counts.B,
    NG: sum.NG + batch.counts.NG,
  }), { A: 0, B: 0, NG: 0 });
  const projected = replayed.reduce((sum, unit) => {
    sum[unit.projectedGrade] += 1;
    return sum;
  }, { A: 0, B: 0, NG: 0 } as Record<Grade, number>);
  const noiseEstimate = replayed.reduce((sum, unit) => {
    if (unit.noiseEstimateGrade) sum[unit.noiseEstimateGrade] += 1;
    return sum;
  }, { A: 0, B: 0, NG: 0 } as Record<Grade, number>);
  const definite = replayed.reduce((sum, unit) => {
    if (unit.possibleGrades.length === 1) sum[unit.possibleGrades[0]!] += 1;
    return sum;
  }, { A: 0, B: 0, NG: 0 } as Record<Grade, number>);
  const possibleMax = replayed.reduce((sum, unit) => {
    for (const grade of unit.possibleGrades) sum[grade] += 1;
    return sum;
  }, { A: 0, B: 0, NG: 0 } as Record<Grade, number>);
  const noisePassLower = replayed.filter((unit) => unit.possibleGrades.every((grade) => grade !== 'NG')).length;
  const noisePassUpper = replayed.filter((unit) => unit.possibleGrades.some((grade) => grade === 'A' || grade === 'B')).length;
  const finalDefinite = replayed.reduce((sum, unit) => {
    if (unit.finalPossibleGrades.length === 1) sum[unit.finalPossibleGrades[0]!] += 1;
    return sum;
  }, { A: 0, B: 0, NG: 0 } as Record<Grade, number>);
  const finalPossibleMax = replayed.reduce((sum, unit) => {
    for (const grade of unit.finalPossibleGrades) sum[grade] += 1;
    return sum;
  }, { A: 0, B: 0, NG: 0 } as Record<Grade, number>);
  const finalPassLower = replayed.filter((unit) => unit.finalPossibleGrades.every((grade) => grade !== 'NG')).length;
  const finalPassUpper = replayed.filter((unit) => unit.finalPossibleGrades.some((grade) => grade === 'A' || grade === 'B')).length;
  let fullStageMatches = 0;
  let fullStageComparisons = 0;
  const fullStageMismatches: Array<{ batchId: string; index: number; channel: Channel; result: number | null; latestLog: number | null }> = [];
  for (const result of resultBatches) {
    const log = logsByBatch.get(result.batchId);
    if (!log) continue;
    for (const unit of result.units.values()) {
      const points = log.trends.get(unit.index) ?? [];
      for (const channel of CHANNELS) {
        const resultValue = unit.fluctuation[channel];
        const logValue = latestBand(points, channel)?.fluctuation ?? null;
        if (resultValue === null || logValue === null) continue;
        fullStageComparisons += 1;
        if (Math.abs(resultValue - logValue) <= 0.001) fullStageMatches += 1;
        else if (fullStageMismatches.length < 20) fullStageMismatches.push({
          batchId: result.batchId, index: unit.index, channel, result: resultValue, latestLog: logValue,
        });
      }
    }
  }

  const payload = {
    scope: {
      packageCount: packageDirs.length,
      resultBatchCount: resultBatches.length,
      logBatchStartCount: logBatches.length,
      replayedUnitCount: replayed.length,
      completeResultBlocksWithLogs: [...resultsByBatch.keys()].filter((batchId) => logsByBatch.has(batchId)).length,
      unmatchedLogBatchIds,
    },
    exactness: {
      exactSlidingWindowReplay: false,
      exactEvidence: '完成结果文件中的 RAW 全阶段 min/max 可作为滚动值上界；latest.log 最后一条 Rcum 与该全阶段值在可比通道中交叉校验，滑动窗口只能由每秒 Rlast 采样估计。',
      missingEvidence: 'latest.log 没有每个 RAW 样本的独立时间戳，也没有每秒内全部样本，无法精确重建任意 10 秒滑动窗口。',
      fullStageRcumValidation: {
        matches: fullStageMatches,
        comparisons: fullStageComparisons,
        mismatches: fullStageMismatches,
      },
    },
    baseline,
    projectedFinal: projected,
    noiseOnlyFrameSampledEstimate: noiseEstimate,
    noiseOnlyIndependentBounds: {
      definite: { ...definite, pass: noisePassLower },
      possibleMaximum: { ...possibleMax, pass: noisePassUpper },
    },
    projectedFinalIndependentBounds: {
      definite: { ...finalDefinite, pass: finalPassLower },
      possibleMaximum: { ...finalPossibleMax, pass: finalPassUpper },
    },
    replayed,
  };
  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`回放范围：${packageDirs.length} 个诊断包，${resultBatches.length} 个完成批次，${replayed.length} 台设备；日志共 ${logBatches.length} 个开始标记，未匹配完成结果 ${unmatchedLogBatchIds.length} 个`);
  console.log('回放性质：近似回放，不是精确滑动窗口回放。完成结果中的全阶段 RAW min/max 用作滚动值上界；10 秒窗口由每秒 Rlast 组合估计。');
  console.log(`Rcum 交叉校验：${fullStageMatches}/${fullStageComparisons} 个通道与完成结果中的全阶段 RAW 波动一致；其余通道存在日志尾部未覆盖或聚合差异`);
  if (unmatchedLogBatchIds.length) console.log(`未匹配日志批次：${unmatchedLogBatchIds.join(', ')}`);
  console.log(`历史实际基线：A ${baseline.A} / B ${baseline.B} / NG ${baseline.NG}，A+B ${rate(baseline.A + baseline.B, replayed.length)}`);
  console.log(`最可信估计（仅替换噪声相关最终等级，其他失败证据保持历史结果）：A ${projected.A} / B ${projected.B} / NG ${projected.NG}，A+B ${rate(projected.A + projected.B, replayed.length)}`);
  console.log(`噪声门估计（不叠加干扰、启动、绝对值等其他门禁）：A ${noiseEstimate.A} / B ${noiseEstimate.B} / NG ${noiseEstimate.NG}`);
  console.log(`可验证独立上下界（仅噪声门）：A ${definite.A}..${possibleMax.A}，B ${definite.B}..${possibleMax.B}，NG ${definite.NG}..${possibleMax.NG}，A+B ${noisePassLower}..${noisePassUpper}`);
  console.log(`可验证独立上下界（保留其他历史失败证据）：A ${finalDefinite.A}..${finalPossibleMax.A}，B ${finalDefinite.B}..${finalPossibleMax.B}，NG ${finalDefinite.NG}..${finalPossibleMax.NG}，A+B ${finalPassLower}..${finalPassUpper}`);
  console.log(`结论：历史 A+B 合格率 81.1%（${rate(baseline.A + baseline.B, replayed.length)}）；按每秒 Rlast 的最可信估计为 ${rate(projected.A + projected.B, replayed.length)}，但不能把该估计当作精确值。`);
}

function readFileSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

main();
