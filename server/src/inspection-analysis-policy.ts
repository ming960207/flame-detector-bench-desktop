import { FieldWaveformAnalysis } from './closure/field-waveform-analysis.js';
import type { FlameDetectorState } from './types.js';

const PATCHED = Symbol.for('inspection-analysis-policy-patched-v1');
const READY_SETTLE_MS = 5_000;
const MIN_INTERFERENCE_SAMPLES = 40;

type InternalAnalysis = Record<PropertyKey, any>;

const readySince = new WeakMap<object, number>();

function allProductionUnitsReady(state: FlameDetectorState): boolean {
  if (!Array.isArray(state.units) || state.units.length < 6) return false;
  const byIndex = new Map(state.units.map((unit) => [unit.index, unit]));
  for (let index = 1; index <= 6; index += 1) {
    const unit = byIndex.get(index);
    if (!unit || !unit.online || !unit.sourceReady || !unit.syncOk) return false;
  }
  return true;
}

function gateNoiseCaptureUntilStable(
  analysis: object,
  state: FlameDetectorState,
): FlameDetectorState {
  const internal = analysis as InternalAnalysis;
  if (internal.capturePhase !== 'NOISE') {
    if (!allProductionUnitsReady(state)) readySince.delete(analysis);
    return state;
  }

  const now = Number(state.timestamp) || Date.now();
  if (!allProductionUnitsReady(state)) {
    readySince.delete(analysis);
    return {
      ...state,
      units: state.units.map((unit) => ({
        ...unit,
        sourceReady: false,
        syncOk: false,
        lastError: unit.lastError ?? '噪声窗口等待六台波形同时恢复稳定',
      })),
    };
  }

  const startedAt = readySince.get(analysis) ?? now;
  if (!readySince.has(analysis)) {
    readySince.set(analysis, startedAt);
    console.log(`[噪声采样门控] D1~D6 已同时就绪，开始 ${READY_SETTLE_MS}ms 连续稳定计时。`);
  }
  if (now - startedAt >= READY_SETTLE_MS) return state;

  return {
    ...state,
    units: state.units.map((unit) => ({
      ...unit,
      sourceReady: false,
      syncOk: false,
      lastError: `噪声采样前连续稳定等待 ${Math.max(0, READY_SETTLE_MS - (now - startedAt))}ms`,
    })),
  };
}

function patchRuntime(): void {
  const proto = FieldWaveformAnalysis.prototype as unknown as InternalAnalysis;
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

  const originalUpdateConfig = proto.updateConfig;
  proto.updateConfig = function updateConfigWithProductionSampleFloor(
    this: InternalAnalysis,
    config?: Record<string, unknown>,
  ): void {
    originalUpdateConfig.call(this, {
      ...config,
      minInterferenceSamples: Math.min(
        Number.isFinite(Number(config?.minInterferenceSamples)) ? Number(config?.minInterferenceSamples) : MIN_INTERFERENCE_SAMPLES,
        MIN_INTERFERENCE_SAMPLES,
      ),
    });
  };

  const originalObserveDetectors = proto.observeDetectors;
  proto.observeDetectors = function observeDetectorsWithStableNoiseGate(
    this: InternalAnalysis,
    state: FlameDetectorState,
  ): void {
    const gated = gateNoiseCaptureUntilStable(this, state);
    originalObserveDetectors.call(this, gated);
  };

  const originalSnapshot = proto.snapshot;
  proto.snapshot = function snapshotWithProductionMinimums(this: InternalAnalysis) {
    if (this.config && Number(this.config.minInterferenceSamples) > MIN_INTERFERENCE_SAMPLES) {
      this.config.minInterferenceSamples = MIN_INTERFERENCE_SAMPLES;
    }
    return originalSnapshot.call(this);
  };

  console.log(
    `[定量分析策略] 已启用：噪声采样要求 D1~D6 连续稳定 ${READY_SETTLE_MS}ms；`
    + `10s 级干扰工序最少采样数按 ${MIN_INTERFERENCE_SAMPLES} 点执行。`,
  );
}

patchRuntime();

export {};
