import type { RelayFunctionalTestProgress } from '../server/src/product-aware-flame-detector-service';
import type { NormalizedCameraRoi } from './indicator-camera-geometry';

export type IndicatorColor = 'green' | 'red' | 'yellow';
export type IndicatorPhase = RelayFunctionalTestProgress['phase'] | 'MANUAL';
export type IndicatorState = 'ON' | 'OFF' | 'UNKNOWN';
export type IndicatorVerdict = 'PASS' | 'FAIL' | 'WAITING';

export type IndicatorSlotRoi = NormalizedCameraRoi;

export interface IndicatorLightResult {
  color: IndicatorColor;
  state: IndicatorState;
  confidence: number;
  matchRatio: number;
  bounds: IndicatorSlotRoi | null;
}

export interface IndicatorSlotResult {
  slot: number;
  roi: IndicatorSlotRoi;
  verdict: IndicatorVerdict;
  lights: Record<IndicatorColor, IndicatorLightResult>;
  frames: number;
}

export interface FrameSample {
  capturedAt: number;
  phase: IndicatorPhase;
  slots: IndicatorSlotResult[];
}

export const REQUIRED_STABLE_FRAMES = 2;
const COLORS = [{ key: 'green' }, { key: 'red' }, { key: 'yellow' }] as const;
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function colorMatches(red: number, green: number, blue: number, color: IndicatorColor): boolean {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  const chroma = max - min;
  if (max < 0.32 || chroma < 0.12) return false;

  let hue = 0;
  if (chroma > 0) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  if (color === 'green') return hue >= 72 && hue <= 175 && green >= red * 1.12 && green >= blue * 0.92;
  if (color === 'red') return (hue <= 28 || hue >= 335) && red >= green * 1.18 && red >= blue * 1.08;
  return hue >= 30 && hue <= 78 && red >= blue * 1.16 && green >= blue * 1.1;
}

function analyzeColor(
  image: ImageData,
  roi: IndicatorSlotRoi,
  color: IndicatorColor,
): IndicatorLightResult {
  const xStart = clamp(Math.floor(roi.x * image.width), 0, image.width);
  const yStart = clamp(Math.floor(roi.y * image.height), 0, image.height);
  const xEnd = clamp(Math.floor((roi.x + roi.width) * image.width), xStart, image.width);
  const yEnd = clamp(Math.floor((roi.y + roi.height) * image.height), yStart, image.height);
  const width = xEnd - xStart;
  const height = yEnd - yStart;
  const pixels = width * height;
  const mask = new Uint8Array(pixels);
  let matches = 0;
  // Read every source pixel: striding can skip a small LED or its coloured rim.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = ((yStart + y) * image.width + xStart + x) * 4;
      if (!colorMatches(image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0, color)) continue;
      mask[y * width + x] = 1;
      matches += 1;
    }
  }

  let strongest: { count: number; minX: number; minY: number; maxX: number; maxY: number } | null = null;
  const queue = new Int32Array(pixels);
  // A compact connected spot is evidence; total ROI area and scattered hot
  // pixels are not. Eight neighbours keep diagonal/overexposed LED rims intact.
  for (let seed = 0; seed < pixels; seed++) {
    if (!mask[seed]) continue;
    mask[seed] = 0;
    queue[0] = seed;
    let head = 0;
    let tail = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const position = queue[head++]!;
      const x = position % width;
      const y = Math.floor(position / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const next = ny * width + nx;
          if (!mask[next]) continue;
          mask[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    if (tail >= 6 && maxX > minX && maxY > minY && (!strongest || tail > strongest.count)) {
      strongest = { count: tail, minX, minY, maxX, maxY };
    }
  }

  const matchRatio = pixels > 0 ? matches / pixels : 0;
  const state: IndicatorState = strongest ? 'ON' : 'OFF';
  const confidence = strongest ? clamp(strongest.count / 12, 0, 1) : 0;
  const bounds = strongest
    ? {
      slot: roi.slot,
      x: (xStart + strongest.minX) / image.width,
      y: (yStart + strongest.minY) / image.height,
      width: (strongest.maxX - strongest.minX + 1) / image.width,
      height: (strongest.maxY - strongest.minY + 1) / image.height,
    }
    : null;

  return { color, state, confidence, matchRatio, bounds };
}

export function analyzeIndicatorFrame(image: ImageData, rois: IndicatorSlotRoi[], phase: IndicatorPhase): IndicatorSlotResult[] {
  return rois.map((roi) => {
    const lights = Object.fromEntries(COLORS.map(({ key }) => [key, analyzeColor(image, roi, key)])) as Record<IndicatorColor, IndicatorLightResult>;
    const expected = phase === 'ALARM_VERIFY' ? 'red' : phase === 'FAULT_VERIFY' ? 'yellow' : null;
    return {
      slot: roi.slot,
      roi,
      verdict: expected && lights[expected].state === 'ON' ? 'PASS' : 'WAITING',
      lights,
      frames: 1,
    } satisfies IndicatorSlotResult;
  });
}

export function aggregateLight(samples: FrameSample[], slot: number, color: IndicatorColor): IndicatorLightResult {
  const matches = samples
    .map((sample) => ({
      timestamp: sample.capturedAt,
      light: sample.slots.find((item) => item.slot === slot)?.lights[color],
    }))
    .filter((item): item is { timestamp: number; light: IndicatorLightResult } => Boolean(item.light));
  const onSamples = matches.filter((item) => item.light.state === 'ON');
  const offSamples = matches.filter((item) => item.light.state === 'OFF');
  const strongest = matches.map((item) => item.light)
    .sort((left, right) => right.confidence - left.confidence)[0];
  // Two non-adjacent noise flashes must not fake a stable lamp. Distinct video
  // timestamps also prevent a frozen frame being counted twice as new proof.
  let stableOn = false;
  let previousOnAt: number | null = null;
  for (const item of matches) {
    const gap = previousOnAt === null ? -1 : item.timestamp - previousOnAt;
    if (item.light.state === 'ON') {
      if (gap >= 60 && gap <= 650) stableOn = true;
      previousOnAt = item.timestamp;
    } else {
      previousOnAt = null;
    }
  }
  const state: IndicatorState = stableOn ? 'ON'
    : offSamples.length >= REQUIRED_STABLE_FRAMES ? 'OFF' : 'UNKNOWN';
  return {
    color,
    state,
    confidence: strongest?.confidence ?? 0,
    matchRatio: strongest?.matchRatio ?? 0,
    bounds: onSamples.find((item) => item.light.bounds)?.light.bounds ?? null,
  };
}

export function aggregateSamples(samples: FrameSample[], phase: IndicatorPhase, rois: IndicatorSlotRoi[]): IndicatorSlotResult[] {
  const scoped = samples.filter((sample) => sample.phase === phase);
  return rois.map((roi) => {
    const lights = Object.fromEntries(COLORS.map(({ key }) => [key, aggregateLight(scoped, roi.slot, key)])) as Record<IndicatorColor, IndicatorLightResult>;
    const expected = phase === 'ALARM_VERIFY' ? 'red' : phase === 'FAULT_VERIFY' ? 'yellow' : null;
    const expectedState = expected ? lights[expected].state : 'UNKNOWN';
    return {
      slot: roi.slot,
      roi,
      verdict: expected
        ? expectedState === 'ON' ? 'PASS' : scoped.length >= REQUIRED_STABLE_FRAMES ? 'FAIL' : 'WAITING'
        : 'WAITING',
      lights,
      frames: scoped.length,
    } satisfies IndicatorSlotResult;
  });
}


/**
 * Final LED evidence must come from its own physical test phase. In particular,
 * an illuminated green LED in ALARM_VERIFY is not proof that the BASELINE
 * running-light inspection was observed. Missing/short phases stay UNKNOWN.
 */
export function completedIndicatorResults(
  phaseResults: ReadonlyMap<IndicatorPhase, IndicatorSlotResult[]>,
  rois: IndicatorSlotRoi[],
): IndicatorSlotResult[] {
  const unknown = (color: IndicatorColor): IndicatorLightResult => ({
    color, state: 'UNKNOWN', confidence: 0, matchRatio: 0, bounds: null,
  });
  return rois.map((roi) => {
    const baseline = phaseResults.get('BASELINE')?.find((item) => item.slot === roi.slot);
    const alarm = phaseResults.get('ALARM_VERIFY')?.find((item) => item.slot === roi.slot);
    const alarmCommand = phaseResults.get('ALARM_COMMAND')?.find((item) => item.slot === roi.slot);
    const fault = phaseResults.get('FAULT_VERIFY')?.find((item) => item.slot === roi.slot);
    const green = (baseline?.frames ?? 0) >= REQUIRED_STABLE_FRAMES
      ? baseline!.lights.green : unknown('green');
    // A fast detector may illuminate red while the three simulation frames
    // are still being issued. Recover that early ON transition, but ONLY if
    // two BASELINE frames proved red was previously OFF, and two command-phase
    // frames independently observed red ON. Never use pre-command red as proof.
    const earlyRed = (baseline?.frames ?? 0) >= REQUIRED_STABLE_FRAMES
      && baseline?.lights.red.state === 'OFF'
      && (alarmCommand?.frames ?? 0) >= REQUIRED_STABLE_FRAMES
      && alarmCommand?.lights.red.state === 'ON';
    const red = earlyRed ? alarmCommand!.lights.red
      : (alarm?.frames ?? 0) >= REQUIRED_STABLE_FRAMES
        ? alarm!.lights.red : unknown('red');
    const yellow = (fault?.frames ?? 0) >= REQUIRED_STABLE_FRAMES
      ? fault!.lights.yellow : unknown('yellow');
    const states = [green.state, red.state];
    return {
      slot: roi.slot,
      roi,
      verdict: states.every((state) => state === 'ON')
        ? 'PASS'
        : states.some((state) => state === 'OFF') ? 'FAIL' : 'WAITING',
      lights: { green, red, yellow },
      frames: Math.max(baseline?.frames ?? 0, alarm?.frames ?? 0, alarmCommand?.frames ?? 0, fault?.frames ?? 0),
    };
  });
}

/** Start UVC before precheck so fast lamp transitions are not lost in setup. */
export function shouldSampleIndicatorEvidence(input: {
  batchId: string | null;
  positionOneReady: boolean;
  precheckBusy: boolean;
  relayBatchId: string | null;
  relayActive: boolean;
  relayPhase: IndicatorPhase;
}): boolean {
  const matchingRelay = Boolean(input.batchId && input.relayBatchId === input.batchId);
  if (!input.batchId || (matchingRelay && !input.relayActive && input.relayPhase === 'COMPLETE')) return false;
  return input.positionOneReady || input.precheckBusy || (matchingRelay && input.relayActive && input.relayPhase !== 'COMPLETE');
}
