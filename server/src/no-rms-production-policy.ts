import { readFileSync, writeFileSync } from 'node:fs';
import { FieldWaveformAnalysis } from './closure/field-waveform-analysis.js';
import { FileFieldTestResultLogger } from './closure/field-test-result-log.js';

const ANALYSIS_PATCHED = Symbol.for('flame-detector-bench.no-rms-analysis.v1');
const REPORT_PATCHED = Symbol.for('flame-detector-bench.no-rms-report.v1');

type InternalAnalysis = Record<PropertyKey, any>;
type InternalLogger = Record<PropertyKey, any>;

/**
 * Production requirement: noise is the maximum channel fluctuation
 * (max - min) / 2. RMS is not a production metric.
 *
 * The legacy object schema still contains the `noiseRms` property because older
 * UI/MQTT consumers may deserialize it. At the runtime boundary we deliberately
 * populate that compatibility slot with the already-computed business fluctuation
 * and clear interferenceRms. This makes every existing threshold consumer use the
 * same (max-min)/2 quantity without introducing a second noise algorithm.
 */
function patchAnalysisBoundary(): void {
  const proto = FieldWaveformAnalysis.prototype as unknown as InternalAnalysis;
  if (proto[ANALYSIS_PATCHED]) return;
  proto[ANALYSIS_PATCHED] = true;

  const originalSnapshot = proto.snapshot;
  proto.snapshot = function snapshotWithoutProductionRms(this: InternalAnalysis) {
    const snapshot = originalSnapshot.call(this);
    snapshot.units = snapshot.units.map((unit: any) => ({
      ...unit,
      // Compatibility field only: this value is NOT RMS. It is the formal
      // production noise fluctuation = max((channel max-min)/2).
      noiseRms: unit.noisePeakToPeak,
      interferenceRms: null,
    }));
    return snapshot;
  };

  console.log('[噪声判定] 正式生产已取消 RMS：仅使用有效探头 (max-min)/2 最大波动值进行 <200 判定。');
}

function rewriteLatestResultBlock(file: string): void {
  try {
    const content = readFileSync(file, 'utf8');
    const separator = '='.repeat(96);
    const start = content.lastIndexOf(separator);
    if (start < 0) return;
    const prefix = content.slice(0, start);
    const latest = content.slice(start);
    let inDeviceTable = false;
    let deviceTableStarted = false;

    const rewritten = latest.split(/\r?\n/).map((line) => {
      if (line === '设备结果明细') {
        inDeviceTable = true;
        deviceTableStarted = false;
        return line;
      }
      if (inDeviceTable && line === '') {
        inDeviceTable = false;
        return line;
      }
      if (!inDeviceTable || !line.startsWith('|') || !line.endsWith('|')) return line;

      const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
      // Historical layout: 设备/地址/结果/噪声RMS/噪声半峰峰值/绝对幅值/.../说明
      if (cells.length !== 13) return line;
      if (!deviceTableStarted && cells[0] === '设备') {
        cells[3] = '噪声最大波动值';
        cells.splice(4, 1);
        deviceTableStarted = true;
        return `| ${cells.join(' | ')} |`;
      }
      // Separator row and device data rows use the same 13-column shape.
      cells.splice(4, 1);
      return `| ${cells.join(' | ')} |`;
    }).join('\n')
      .replaceAll('噪声 RMS 超过上限', '噪声最大波动值超过上限')
      .replaceAll('NOISE_RMS_EXCEEDS_LIMIT', 'NOISE_FLUCTUATION_EXCEEDS_LIMIT')
      .replaceAll('NOISE_RMS_BELOW_LIMIT', 'NOISE_FLUCTUATION_BELOW_LIMIT');

    writeFileSync(file, prefix + rewritten, 'utf8');
  } catch (error) {
    console.warn('[噪声判定] 检测结果日志去 RMS 后处理失败:', error instanceof Error ? error.message : String(error));
  }
}

function patchResultLogger(): void {
  const proto = FileFieldTestResultLogger.prototype as unknown as InternalLogger;
  if (proto[REPORT_PATCHED]) return;
  proto[REPORT_PATCHED] = true;

  const originalRecord = proto.record;
  proto.record = function recordWithoutRms(this: InternalLogger, ...args: any[]) {
    const file = originalRecord.apply(this, args);
    if (typeof file === 'string' && file) rewriteLatestResultBlock(file);
    return file;
  };
}

patchAnalysisBoundary();
patchResultLogger();

export {};
