import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC, MouseEvent as ReactMouseEvent } from 'react';
import {
  Camera,
  CircleAlert,
  Download,
  LocateFixed,
  PauseCircle,
  Play,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Video,
} from 'lucide-react';
import type { ProductPrecheckReport } from '../server/src/product-profile';
import type { RelayFunctionalTestProgress } from '../server/src/product-aware-flame-detector-service';
import type { IndicatorVisionReport } from '../server/src/indicator-vision';
import './indicator-camera.css';

export type IndicatorColor = 'green' | 'red' | 'yellow';
export type IndicatorPhase = RelayFunctionalTestProgress['phase'] | 'MANUAL';
export type IndicatorState = 'ON' | 'OFF' | 'UNKNOWN';
export type IndicatorVerdict = 'PASS' | 'FAIL' | 'WAITING';

export interface IndicatorSlotRoi {
  slot: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

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

export interface IndicatorCapture {
  id: string;
  batchId: string | null;
  phase: IndicatorPhase;
  label: string;
  capturedAt: number;
  image: string;
  slots: IndicatorSlotResult[];
  sampleCount: number;
}

interface FrameSample {
  capturedAt: number;
  phase: IndicatorPhase;
  slots: IndicatorSlotResult[];
}

interface CameraDeviceOption {
  deviceId: string;
  label: string;
}

const CAMERA_CONFIG_KEY = 'wutos-indicator-camera-rois-v1';
const CAMERA_WIDTH = 960;
const SAMPLE_INTERVAL_MS = 240;
const PHOTO_INTERVAL_MS = 720;
const REQUIRED_STABLE_FRAMES = 2;
const MAX_PHASE_SAMPLES = 12;
const MAX_RUN_SAMPLES = 32;
const MAX_CAPTURE_HISTORY = 8;

const COLORS: ReadonlyArray<{ key: IndicatorColor; label: string; className: string }> = [
  { key: 'green', label: '运行绿', className: 'is-green' },
  { key: 'red', label: '火警红', className: 'is-red' },
  { key: 'yellow', label: '故障黄', className: 'is-yellow' },
];

const PHASE_LABELS: Record<IndicatorPhase, string> = {
  BASELINE: '基线采样',
  ALARM_COMMAND: '火警指令',
  ALARM_VERIFY: '火警验证 · 应见红灯',
  ALARM_RESET: '火警复位',
  ALARM_RESET_VERIFY: '火警复位验证',
  FAULT_COMMAND: '故障指令',
  FAULT_VERIFY: '故障验证 · 应见黄灯',
  FAULT_RESET: '故障复位',
  FAULT_RESET_VERIFY: '故障复位验证',
  COMPLETE: '继电器测试完成',
  MANUAL: '手动取证',
};

const DEFAULT_SLOT_ROIS: IndicatorSlotRoi[] = Array.from({ length: 6 }, (_, index) => ({
  slot: index + 1,
  x: 0.02 + index * 0.163,
  y: 0.28,
  width: 0.13,
  height: 0.44,
}));

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRoi(value: unknown, fallback: IndicatorSlotRoi): IndicatorSlotRoi {
  if (!value || typeof value !== 'object') return fallback;
  const source = value as Partial<IndicatorSlotRoi>;
  const rawWidth = Number(source.width);
  const rawHeight = Number(source.height);
  const rawX = Number(source.x);
  const rawY = Number(source.y);
  const width = clamp(Number.isFinite(rawWidth) ? rawWidth : fallback.width, 0.05, 0.4);
  const height = clamp(Number.isFinite(rawHeight) ? rawHeight : fallback.height, 0.1, 0.8);
  return {
    slot: fallback.slot,
    x: clamp(Number.isFinite(rawX) ? rawX : fallback.x, 0, 1 - width),
    y: clamp(Number.isFinite(rawY) ? rawY : fallback.y, 0, 1 - height),
    width,
    height,
  };
}

function loadSlotRois(): IndicatorSlotRoi[] {
  if (typeof window === 'undefined') return DEFAULT_SLOT_ROIS;
  try {
    const raw = JSON.parse(window.localStorage.getItem(CAMERA_CONFIG_KEY) || 'null') as unknown;
    if (!Array.isArray(raw) || raw.length !== DEFAULT_SLOT_ROIS.length) return DEFAULT_SLOT_ROIS;
    return DEFAULT_SLOT_ROIS.map((fallback, index) => normalizeRoi(raw[index], fallback));
  } catch {
    return DEFAULT_SLOT_ROIS;
  }
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
  const xStart = Math.floor(roi.x * image.width);
  const yStart = Math.floor(roi.y * image.height);
  const width = Math.max(1, Math.floor(roi.width * image.width));
  const height = Math.max(1, Math.floor(roi.height * image.height));
  const xEnd = Math.min(image.width, xStart + width);
  const yEnd = Math.min(image.height, yStart + height);
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 34));
  let pixels = 0;
  let matches = 0;
  let minX = xEnd;
  let minY = yEnd;
  let maxX = xStart;
  let maxY = yStart;

  for (let y = yStart; y < yEnd; y += stride) {
    for (let x = xStart; x < xEnd; x += stride) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      pixels += 1;
      if (!colorMatches(red, green, blue, color)) continue;
      matches += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const matchRatio = pixels > 0 ? matches / pixels : 0;
  const threshold = Math.max(2, pixels * 0.009);
  const state: IndicatorState = matches >= threshold ? 'ON' : 'OFF';
  const confidence = clamp(matchRatio / 0.08, 0, 1);
  const bounds = state === 'ON' && maxX >= minX && maxY >= minY
    ? {
      slot: roi.slot,
      x: minX / image.width,
      y: minY / image.height,
      width: Math.max(0.008, (maxX - minX) / image.width),
      height: Math.max(0.012, (maxY - minY) / image.height),
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

function aggregateLight(samples: FrameSample[], slot: number, color: IndicatorColor): IndicatorLightResult {
  const matches = samples
    .map((sample) => sample.slots.find((item) => item.slot === slot)?.lights[color])
    .filter((item): item is IndicatorLightResult => Boolean(item));
  const onSamples = matches.filter((item) => item.state === 'ON');
  const strongest = matches.slice().sort((left, right) => right.confidence - left.confidence)[0];
  const state: IndicatorState = onSamples.length >= REQUIRED_STABLE_FRAMES ? 'ON' : matches.length >= REQUIRED_STABLE_FRAMES ? 'OFF' : 'UNKNOWN';
  return {
    color,
    state,
    confidence: strongest?.confidence ?? 0,
    matchRatio: strongest?.matchRatio ?? 0,
    bounds: onSamples.find((item) => item.bounds)?.bounds ?? null,
  };
}

function aggregateSamples(samples: FrameSample[], phase: IndicatorPhase, rois: IndicatorSlotRoi[]): IndicatorSlotResult[] {
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

function expectedLightForPhase(phase: IndicatorPhase): IndicatorColor | null {
  if (phase === 'ALARM_VERIFY') return 'red';
  if (phase === 'FAULT_VERIFY') return 'yellow';
  return null;
}

function phaseLabel(phase: IndicatorPhase, active: boolean): string {
  if (active) return PHASE_LABELS[phase];
  return phase === 'MANUAL' ? PHASE_LABELS.MANUAL : '等待继电器测试';
}

function stateLabel(state: IndicatorState): string {
  return state === 'ON' ? '亮' : state === 'OFF' ? '灭' : '待采样';
}

function formatCaptureTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function cameraErrorText(error: unknown): string {
  if (!(error instanceof DOMException)) return error instanceof Error ? error.message : '摄像头启动失败';
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '摄像头权限未授权，请允许本程序访问视频设备';
  if (error.name === 'NotFoundError') return '未找到 USB 免驱摄像头';
  if (error.name === 'NotReadableError') return '摄像头已被其他程序占用';
  return error.message || '摄像头启动失败';
}

function captureLabel(phase: IndicatorPhase): string {
  return PHASE_LABELS[phase];
}

function visualSummary(slots: IndicatorSlotResult[], relayFunctionalTest: ProductPrecheckReport['relayFunctionalTest'] | null | undefined): { pass: number; fail: number; waiting: number } {
  if (!relayFunctionalTest || slots.length === 0) return { pass: 0, fail: 0, waiting: slots.length };
  const pass = slots.filter((slot) => slot.verdict === 'PASS').length;
  const fail = slots.filter((slot) => slot.verdict === 'FAIL').length;
  return { pass, fail, waiting: Math.max(0, slots.length - pass - fail) };
}

export interface IndicatorCameraPanelProps {
  expanded: boolean;
  batchId: string | null;
  precheckBusy: boolean;
  relayTest: RelayFunctionalTestProgress | null | undefined;
  relayFunctionalTest: ProductPrecheckReport['relayFunctionalTest'] | null | undefined;
  onSubmitEvidence?: (report: IndicatorVisionReport) => Promise<void>;
}

export const IndicatorCameraPanel: FC<IndicatorCameraPanelProps> = ({
  expanded,
  batchId,
  precheckBusy,
  relayTest,
  relayFunctionalTest,
  onSubmitEvidence,
}) => {
  const captureVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const slotRoisRef = useRef<IndicatorSlotRoi[]>(loadSlotRois());
  const phaseSamplesRef = useRef<FrameSample[]>([]);
  const runSamplesRef = useRef<FrameSample[]>([]);
  const phaseResultsRef = useRef<Map<IndicatorPhase, IndicatorSlotResult[]>>(new Map());
  const captureFrameRef = useRef<(savePhoto: boolean) => void>(() => undefined);
  const lastPhotoAtRef = useRef(0);
  const lastPhaseRef = useRef<IndicatorPhase>('MANUAL');
  const wasBusyRef = useRef(false);
  const lastBatchKeyRef = useRef<string | null>(batchId);
  const submittedBatchRef = useRef<string | null>(null);

  const [slotRois, setSlotRois] = useState<IndicatorSlotRoi[]>(loadSlotRois);
  const [devices, setDevices] = useState<CameraDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [cameraStatus, setCameraStatus] = useState<'idle' | 'requesting' | 'ready' | 'error'>('idle');
  const [cameraError, setCameraError] = useState('');
  const [captures, setCaptures] = useState<IndicatorCapture[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [liveResults, setLiveResults] = useState<IndicatorSlotResult[]>([]);
  const [calibratingSlot, setCalibratingSlot] = useState<number | null>(null);

  const activePhase: IndicatorPhase = relayTest
    ? relayTest.phase
    : precheckBusy
      ? 'BASELINE'
      : 'MANUAL';
  const samplingActive = precheckBusy && relayTest?.active !== false && activePhase !== 'COMPLETE';
  const currentCapture = captures.find((capture) => capture.id === selectedCaptureId) ?? captures[0] ?? null;
  const expectedColor = expectedLightForPhase(activePhase);
  const summary = useMemo(() => visualSummary(liveResults, relayFunctionalTest), [liveResults, relayFunctionalTest]);

  const completedResults = useCallback((): IndicatorSlotResult[] => slotRoisRef.current.map((roi) => {
    const alarm = phaseResultsRef.current.get('ALARM_VERIFY')?.find((item) => item.slot === roi.slot);
    const fault = phaseResultsRef.current.get('FAULT_VERIFY')?.find((item) => item.slot === roi.slot);
    const green = runSamplesRef.current.length >= REQUIRED_STABLE_FRAMES
      ? aggregateLight(runSamplesRef.current, roi.slot, 'green')
      : { color: 'green' as const, state: 'UNKNOWN' as const, confidence: 0, matchRatio: 0, bounds: null };
    const red = alarm?.lights.red ?? { color: 'red' as const, state: 'UNKNOWN' as const, confidence: 0, matchRatio: 0, bounds: null };
    const yellow = fault?.lights.yellow ?? { color: 'yellow' as const, state: 'UNKNOWN' as const, confidence: 0, matchRatio: 0, bounds: null };
    const lights = { green, red, yellow };
    const states = [green.state, red.state, yellow.state];
    const verdict: IndicatorVerdict = states.every((state) => state === 'ON')
      ? 'PASS'
      : states.some((state) => state === 'OFF')
        ? 'FAIL'
        : 'WAITING';
    return { slot: roi.slot, roi, verdict, lights, frames: Math.max(runSamplesRef.current.length, alarm?.frames ?? 0, fault?.frames ?? 0) };
  }), []);

  const submitCompletedEvidence = useCallback(async () => {
    if (
      !onSubmitEvidence
      || !batchId
      || !relayFunctionalTest
      || relayTest?.phase !== 'COMPLETE'
      || precheckBusy
      || captures.length === 0
      || submittedBatchRef.current === batchId
    ) return;
    const lightVerdict = (state: IndicatorState): 'PASS' | 'FAIL' | 'PENDING' => state === 'ON' ? 'PASS' : state === 'OFF' ? 'FAIL' : 'PENDING';
    const units = completedResults().map((unit) => ({
      slot: unit.slot,
      runningGreen: lightVerdict(unit.lights.green.state),
      fireRed: lightVerdict(unit.lights.red.state),
      faultYellow: lightVerdict(unit.lights.yellow.state),
      verdict: unit.verdict === 'WAITING' ? 'PENDING' : unit.verdict,
    }));
    const lightStates = units.flatMap((unit) => [unit.runningGreen, unit.fireRed, unit.faultYellow]);
    const verdict = lightStates.every((state) => state === 'PASS')
      ? 'PASS'
      : lightStates.some((state) => state === 'FAIL')
        ? 'FAIL'
        : 'PENDING';
    submittedBatchRef.current = batchId;
    try {
      await onSubmitEvidence({
        batchId,
        capturedAt: Date.now(),
        source: 'UVC_HSV',
        captureCount: captures.length,
        phases: [...new Set(captures.map((capture) => capture.phase))],
        verdict,
        units,
      });
    } catch {
      submittedBatchRef.current = null;
    }
  }, [batchId, captures, completedResults, onSubmitEvidence, precheckBusy, relayFunctionalTest, relayTest?.phase]);

  useEffect(() => {
    slotRoisRef.current = slotRois;
    try { window.localStorage.setItem(CAMERA_CONFIG_KEY, JSON.stringify(slotRois)); } catch { /* best effort */ }
  }, [slotRois]);

  useEffect(() => {
    if (batchId && batchId !== lastBatchKeyRef.current) {
      phaseSamplesRef.current = [];
      runSamplesRef.current = [];
      phaseResultsRef.current.clear();
      submittedBatchRef.current = null;
      setCaptures([]);
      setSelectedCaptureId(null);
      setLiveResults([]);
    }
    lastBatchKeyRef.current = batchId;
  }, [batchId]);

  useEffect(() => {
    if (precheckBusy && !wasBusyRef.current) {
      phaseSamplesRef.current = [];
      runSamplesRef.current = [];
      phaseResultsRef.current.clear();
      submittedBatchRef.current = null;
      setCaptures([]);
      setSelectedCaptureId(null);
      setLiveResults([]);
      lastPhaseRef.current = activePhase;
    }
    wasBusyRef.current = precheckBusy;
  }, [activePhase, precheckBusy]);

  const enumerateCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const entries = await navigator.mediaDevices.enumerateDevices();
    const next = entries
      .filter((entry) => entry.kind === 'videoinput')
      .map((entry, index) => ({ deviceId: entry.deviceId, label: entry.label || `USB 摄像头 ${index + 1}` }));
    setDevices(next);
    if (!selectedDeviceId && next[0]) setSelectedDeviceId(next[0].deviceId);
  }, [selectedDeviceId]);

  useEffect(() => {
    void enumerateCameras().catch(() => undefined);
    const handleDeviceChange = () => { void enumerateCameras().catch(() => undefined); };
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
  }, [enumerateCameras]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
    setCameraStatus('idle');
  }, []);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('当前运行环境不支持 UVC 摄像头访问');
      setCameraStatus('error');
      return;
    }
    setCameraStatus('requesting');
    setCameraError('');
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const video = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          width: { ideal: CAMERA_WIDTH },
          height: { ideal: 540 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      streamRef.current = video;
      const videos = [captureVideoRef.current, previewVideoRef.current].filter((element): element is HTMLVideoElement => Boolean(element));
      videos.forEach((element) => { element.srcObject = video; });
      await Promise.all(videos.map((element) => element.play().catch(() => undefined)));
      setCameraStatus('ready');
      await enumerateCameras();
    } catch (error) {
      setCameraStatus('error');
      setCameraError(cameraErrorText(error));
    }
  }, [enumerateCameras, selectedDeviceId]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    if (!streamRef.current || cameraStatus !== 'ready') return;
    const videos = [captureVideoRef.current, previewVideoRef.current].filter((element): element is HTMLVideoElement => Boolean(element));
    videos.forEach((element) => {
      element.srcObject = streamRef.current;
      void element.play().catch(() => undefined);
    });
  }, [cameraStatus, expanded]);

  const makeCapture = useCallback((phase: IndicatorPhase, image: string, slots: IndicatorSlotResult[], sampleCount: number): IndicatorCapture => ({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    batchId,
    phase,
    label: captureLabel(phase),
    capturedAt: Date.now(),
    image,
    slots,
    sampleCount,
  }), [batchId]);

  const captureFrame = useCallback((savePhoto: boolean) => {
    const video = captureVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0) return;
    const width = Math.min(CAMERA_WIDTH, video.videoWidth);
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    const phase = activePhase;
    const phaseChanged = phase !== lastPhaseRef.current;
    if (phaseChanged) {
      phaseSamplesRef.current = [];
      lastPhaseRef.current = phase;
    }
    const frame: FrameSample = {
      capturedAt: Date.now(),
      phase,
      slots: analyzeIndicatorFrame(context.getImageData(0, 0, width, height), slotRoisRef.current, phase),
    };
    phaseSamplesRef.current = [...phaseSamplesRef.current, frame].slice(-MAX_PHASE_SAMPLES);
    if (phase !== 'MANUAL') runSamplesRef.current = [...runSamplesRef.current, frame].slice(-MAX_RUN_SAMPLES);
    const phaseAggregated = aggregateSamples(phaseSamplesRef.current, phase, slotRoisRef.current);
    const aggregated = phase !== 'MANUAL' && runSamplesRef.current.length >= REQUIRED_STABLE_FRAMES
      ? phaseAggregated.map((slot) => ({
        ...slot,
        lights: { ...slot.lights, green: aggregateLight(runSamplesRef.current, slot.slot, 'green') },
      }))
      : phaseAggregated;
    phaseResultsRef.current.set(phase, aggregated);
    setLiveResults(aggregated);

    const shouldSave = savePhoto || phase !== 'MANUAL' && (
      frame.capturedAt - lastPhotoAtRef.current >= PHOTO_INTERVAL_MS
      || phaseChanged
    );
    if (!shouldSave) return;
    lastPhotoAtRef.current = frame.capturedAt;
    const image = canvas.toDataURL('image/jpeg', 0.78);
    const capture = makeCapture(phase, image, aggregated, phaseSamplesRef.current.length);
    setCaptures((current) => [capture, ...current].slice(0, MAX_CAPTURE_HISTORY));
    setSelectedCaptureId(capture.id);
  }, [activePhase, makeCapture]);

  useEffect(() => {
    captureFrameRef.current = captureFrame;
  }, [captureFrame]);

  useEffect(() => {
    if (cameraStatus !== 'ready' || !samplingActive) return;
    const timer = window.setInterval(() => {
      captureFrameRef.current(false);
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [cameraStatus, samplingActive]);

  useEffect(() => {
    if (relayFunctionalTest && relayTest?.phase === 'COMPLETE' && !precheckBusy) setLiveResults(completedResults());
  }, [completedResults, precheckBusy, relayFunctionalTest, relayTest?.phase]);

  useEffect(() => { void submitCompletedEvidence(); }, [submitCompletedEvidence]);

  const handleViewportClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (calibratingSlot === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    setSlotRois((current) => current.map((roi) => roi.slot === calibratingSlot
      ? { ...roi, x: clamp(x - roi.width / 2, 0, 1 - roi.width), y: clamp(y - roi.height / 2, 0, 1 - roi.height) }
      : roi));
    setCalibratingSlot((current) => current && current < 6 ? current + 1 : null);
  };

  const resetCalibration = () => {
    setSlotRois(DEFAULT_SLOT_ROIS);
    setCalibratingSlot(null);
  };

  const selectCapture = (capture: IndicatorCapture) => {
    setSelectedCaptureId(capture.id);
    setLiveResults(capture.slots);
  };

  const activeImage = currentCapture?.image ?? null;

  return (
    <div className={`indicator-camera ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <video ref={captureVideoRef} className="indicator-camera__source" muted playsInline aria-hidden="true" />
      <canvas ref={canvasRef} className="indicator-camera__canvas" aria-hidden="true" />
      {expanded && <>
        <div className="indicator-camera__heading">
          <div>
            <span className="indicator-camera__eyebrow"><Camera />INDICATOR VISION / UVC</span>
            <strong>指示灯视觉取证</strong>
            <small>{samplingActive ? `自动跟随：${phaseLabel(activePhase, true)}` : '只通过照片判断颜色与位置，不读取探测器状态替代实拍证据'}</small>
          </div>
          <div className={`indicator-camera__health is-${cameraStatus}`}>
            <span><i />{cameraStatus === 'ready' ? 'UVC 在线' : cameraStatus === 'requesting' ? '请求权限' : cameraStatus === 'error' ? '不可用' : '未启用'}</span>
            <b>{samplingActive ? '自动采样' : '等待采样'}</b>
          </div>
        </div>

        <div className="indicator-camera__toolbar">
          <label className="indicator-camera__device-select"><span>视频设备</span><select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)} disabled={cameraStatus === 'requesting'}><option value="">默认摄像头</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
          {cameraStatus === 'ready'
            ? <button type="button" className="indicator-camera__button is-muted" onClick={stopCamera}><PauseCircle />关闭摄像头</button>
            : <button type="button" className="indicator-camera__button is-primary" onClick={() => void startCamera()} disabled={cameraStatus === 'requesting'}><Play />启用 USB 摄像头</button>}
          <button type="button" className={`indicator-camera__button ${calibratingSlot ? 'is-calibrating' : ''}`} onClick={() => setCalibratingSlot(calibratingSlot ? null : 1)} disabled={cameraStatus !== 'ready'}><LocateFixed />{calibratingSlot ? `点击设置 D${calibratingSlot}` : '校准 6 槽位'}</button>
          <button type="button" className="indicator-camera__button" onClick={() => captureFrameRef.current(true)} disabled={cameraStatus !== 'ready'}><Camera />手动拍照</button>
          <button type="button" className="indicator-camera__icon-button" onClick={resetCalibration} title="恢复默认槽位位置" aria-label="恢复默认槽位位置"><RotateCcw /></button>
        </div>

        {cameraError && <div className="indicator-camera__error"><CircleAlert />{cameraError}</div>}
        {calibratingSlot && <div className="indicator-camera__calibration-note"><Settings2 />请在实时画面内点击 D{calibratingSlot} 指示灯组中心；每次点击自动进入下一个槽位。</div>}

        <div className="indicator-camera__workbench">
          <div className="indicator-camera__viewport" onClick={handleViewportClick} role={calibratingSlot ? 'button' : undefined} tabIndex={calibratingSlot ? 0 : undefined}>
            <video className="indicator-camera__preview" ref={previewVideoRef} muted playsInline />
            {cameraStatus !== 'ready' && <div className="indicator-camera__placeholder"><Video /><b>{cameraStatus === 'error' ? '摄像头不可用' : '启用 UVC 后显示实时画面'}</b><small>首次使用请先选择设备并完成 6 槽位校准</small></div>}
            <div className="indicator-camera__roi-layer" aria-hidden="true">
              {slotRois.map((roi) => {
                const result = liveResults.find((item) => item.slot === roi.slot);
                return <div key={roi.slot} className={`indicator-camera__roi ${calibratingSlot === roi.slot ? 'is-target' : ''} ${result?.verdict === 'PASS' ? 'is-pass' : result?.verdict === 'FAIL' ? 'is-fail' : ''}`} style={{ left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.width * 100}%`, height: `${roi.height * 100}%` }}><b>D{roi.slot}</b>{result && <span>{result.verdict === 'PASS' ? 'OK' : result.verdict === 'FAIL' ? 'NG' : '—'}</span>}{result && COLORS.map(({ key, className }) => { const bounds = result.lights[key].bounds; return bounds && <i key={key} className={`${className} is-detected`} style={{ left: `${(bounds.x - roi.x) / roi.width * 100}%`, top: `${(bounds.y - roi.y) / roi.height * 100}%`, width: `${bounds.width / roi.width * 100}%`, height: `${bounds.height / roi.height * 100}%` }} />; })}</div>;
              })}
            </div>
          </div>

          <aside className="indicator-camera__side-panel">
            <div className="indicator-camera__phase"><span>当前视觉环节</span><strong>{phaseLabel(activePhase, samplingActive)}</strong><small>{expectedColor ? `只验证${expectedColor === 'red' ? '火警红灯' : '故障黄灯'}是否在对应槽位亮起` : '运行绿灯通过整段采样窗口判断闪烁'}</small></div>
            <div className="indicator-camera__slot-grid">
              {slotRois.map((roi) => {
                const result = liveResults.find((item) => item.slot === roi.slot);
                return <div className={`indicator-camera__slot ${result?.verdict === 'PASS' ? 'is-pass' : result?.verdict === 'FAIL' ? 'is-fail' : ''}`} key={roi.slot}><b>D{roi.slot}</b><div>{COLORS.map(({ key, className, label }) => <span key={key} className={result?.lights[key].state === 'ON' ? className + ' is-on' : ''} title={`${label} ${result ? stateLabel(result.lights[key].state) : '待采样'}`}><i />{result ? stateLabel(result.lights[key].state) : '—'}</span>)}</div><small>{result?.verdict === 'PASS' ? '对应灯正常' : result?.verdict === 'FAIL' ? '未识别到目标灯' : '采样中'}</small></div>;
              })}
            </div>
            <div className="indicator-camera__counts"><span><b>{summary.pass}</b>通过</span><span><b>{summary.fail}</b>异常</span><span><b>{summary.waiting}</b>待采样</span></div>
          </aside>
        </div>

        <div className="indicator-camera__evidence">
          <div className="indicator-camera__evidence-preview">
            <header><div><b>对应环节照片</b><span>{currentCapture ? `${currentCapture.label} · ${formatCaptureTime(currentCapture.capturedAt)}` : '尚未生成照片'}</span></div>{currentCapture && <a href={currentCapture.image} download={`indicator-${currentCapture.phase}-${currentCapture.capturedAt}.jpg`} title="下载当前照片" aria-label="下载当前照片"><Download /></a>}</header>
            <div className="indicator-camera__photo-frame">
              {activeImage ? <><img src={activeImage} alt={`${currentCapture?.label ?? '指示灯'}现场照片`} />{currentCapture?.slots.map((slot) => <div key={slot.slot} className={`indicator-camera__photo-roi ${slot.verdict === 'PASS' ? 'is-pass' : slot.verdict === 'FAIL' ? 'is-fail' : ''}`} style={{ left: `${slot.roi.x * 100}%`, top: `${slot.roi.y * 100}%`, width: `${slot.roi.width * 100}%`, height: `${slot.roi.height * 100}%` }}><b>D{slot.slot}</b>{COLORS.map(({ key, className }) => slot.lights[key].bounds && <i key={key} className={`${className} is-detected`} style={{ left: `${(slot.lights[key].bounds.x - slot.roi.x) / slot.roi.width * 100}%`, top: `${(slot.lights[key].bounds.y - slot.roi.y) / slot.roi.height * 100}%`, width: `${slot.lights[key].bounds.width / slot.roi.width * 100}%`, height: `${slot.lights[key].bounds.height / slot.roi.height * 100}%` }} />)}</div>)}</> : <div className="indicator-camera__photo-empty"><Camera /><span>启用摄像头并完成一次取证后，这里会显示照片与 D1–D6 标注</span></div>}
            </div>
          </div>
          <div className="indicator-camera__capture-list"><header><b>采样记录</b><span>{captures.length} 张</span></header>{captures.length === 0 && <small className="indicator-camera__capture-empty">继电器测试时自动按阶段抓拍；绿灯至少跨 2 帧确认。</small>}{captures.map((capture) => <button type="button" key={capture.id} className={capture.id === currentCapture?.id ? 'is-selected' : ''} onClick={() => selectCapture(capture)}><img src={capture.image} alt="" /><span><b>{capture.label}</b><small>{formatCaptureTime(capture.capturedAt)} · {capture.sampleCount} 帧</small></span><em>{capture.slots.filter((slot) => slot.verdict === 'PASS').length}/6</em></button>)}</div>
        </div>

        <footer className="indicator-camera__footer"><span><ShieldCheck />HSV 颜色分割 · ROI 位置匹配 · 绿灯跨帧判定</span><span>视觉结果是照片证据，正式继电器结论仍保留 PLC / DIO 实测链路</span></footer>
      </>}
    </div>
  );
};
