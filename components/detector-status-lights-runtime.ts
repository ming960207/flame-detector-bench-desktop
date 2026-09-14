import './detector-status-lights.css';
import type { IndicatorVisionLightVerdict } from '../server/src/indicator-vision';
import {
  canMergeRelayEvidence,
  DETECTOR_STATUS_LIGHTS,
  indicatorVisionState,
  startsNewRelayStatusSession,
  type DetectorStatusLightKind,
  type IndicatorVisionField,
  type RelayLightField,
} from './detector-status-lights-model';

type StatusLightUnit = {
  index: number;
  online: boolean;
  fire: boolean;
  fault: boolean;
  alarmRelay: boolean;
  faultRelay: boolean;
  relayObserved: boolean;
  indicatorVision?: Partial<Record<IndicatorVisionField, IndicatorVisionLightVerdict>>;
};

type StatusLightPayload = {
  active: boolean;
  batchId: string | null;
  updatedAt: number;
  units: StatusLightUnit[];
};

type RelayActionEvidence = {
  commandAccepted?: boolean;
  internalStateReached?: boolean;
  physicalStateReached?: boolean;
  internalRecovered?: boolean;
  physicalRecovered?: boolean;
  reasons?: string[];
};

type RelayUnitEvidence = {
  detectorIndex: number;
  baseline?: {
    alarmPhysical?: boolean | null;
    faultPhysical?: boolean | null;
  };
  alarm?: RelayActionEvidence;
  fault?: RelayActionEvidence;
};

type IndicatorVisionUnitEvidence = {
  slot: number;
  runningGreen?: IndicatorVisionLightVerdict;
  fireRed?: IndicatorVisionLightVerdict;
  faultYellow?: IndicatorVisionLightVerdict;
};

type ProductConfigPayload = {
  precheck?: {
    batchId?: string | null;
    verdict?: 'PASS' | 'FAIL' | 'PENDING';
    relayFunctionalTest?: {
      phase?: string;
      units?: RelayUnitEvidence[];
    } | null;
    indicatorVision?: {
      batchId?: string | null;
      units?: IndicatorVisionUnitEvidence[];
    } | null;
  } | null;
};

type LightKind = DetectorStatusLightKind;

function backendHttpUrl(): string {
  const runtime = (window as Window & { desktopRuntime?: { backendHttpUrl?: string } }).desktopRuntime;
  if (runtime?.backendHttpUrl) return runtime.backendHttpUrl;
  if (window.location.port === '3002') return `http://${window.location.hostname}:3001`;
  return import.meta.env.VITE_BACKEND_API_URL || `http://${window.location.hostname}:3001`;
}

function detectorCard(index: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.wutos-detector-card[aria-label="探测器${index}检测结果"]`);
}

function sanitizeLightElement(light: HTMLElement): void {
  // No visible labels and no native hover tooltip. Accessibility/state text is
  // carried only by aria-label so the production screen remains LED-only.
  light.textContent = '';
  light.removeAttribute('title');
}

function ensureLightGroup(index: number): HTMLElement | null {
  const card = detectorCard(index);
  if (!card) return null;
  let group = card.querySelector<HTMLElement>(':scope > .wutos-detector-card__status-lights');
  if (!group) {
    group = document.createElement('div');
    group.className = 'wutos-detector-card__status-lights';
    group.setAttribute('role', 'group');
  }
  group.setAttribute('aria-label', `探测器${index}五状态指示灯`);

  const expectedKinds = DETECTOR_STATUS_LIGHTS.map((definition) => definition.kind);
  const currentKinds = [...group.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('wutos-detector-state-led'))
    .map((child) => child.dataset.kind);
  if (currentKinds.length !== expectedKinds.length || currentKinds.some((kind, lightIndex) => kind !== expectedKinds[lightIndex])) {
    group.replaceChildren();
  }
  for (const definition of DETECTOR_STATUS_LIGHTS) {
    let light = group.querySelector<HTMLElement>(`[data-kind="${definition.kind}"]`);
    if (!light) {
      light = document.createElement('span');
      light.className = `wutos-detector-state-led is-${definition.kind}`;
      light.dataset.kind = definition.kind;
      light.setAttribute('role', 'img');
      light.setAttribute('aria-label', `${definition.title}：未采集`);
      group.appendChild(light);
    }
    sanitizeLightElement(light);
    group.appendChild(light);
  }
  const metrics = card.querySelector<HTMLElement>(':scope > .wutos-detector-card__metrics');
  if (metrics) card.insertBefore(group, metrics);
  else if (!group.parentElement) card.appendChild(group);
  return group;
}

function setLight(group: HTMLElement, definition: typeof DETECTOR_STATUS_LIGHTS[number], active: boolean, known = true, latched = false): void {
  const light = group.querySelector<HTMLElement>(`[data-kind="${definition.kind}"]`);
  if (!light) return;
  sanitizeLightElement(light);
  light.classList.toggle('is-active', active);
  light.classList.toggle('is-latched', latched);
  light.classList.toggle('is-unknown', !known && !latched);
  const text = !known
    ? latched ? `${definition.title}：锁存亮（当前未采集）` : `${definition.title}：未采集`
    : active ? latched ? `${definition.title}：锁存亮` : `${definition.title}：亮` : `${definition.title}：灭`;
  light.setAttribute('aria-label', text);
}

function applyUnit(unit: StatusLightUnit): void {
  const group = ensureLightGroup(unit.index);
  if (!group) return;
  group.classList.toggle('is-offline', !unit.online);
  group.classList.remove('is-stale');
  for (const definition of DETECTOR_STATUS_LIGHTS) {
    if (definition.source === 'vision') {
      const state = indicatorVisionState(unit.indicatorVision?.[definition.field as IndicatorVisionField]);
      setLight(group, definition, state.active, state.known);
      continue;
    }
    const relayField = definition.field as RelayLightField;
    const latched = latchState(unit.index, definition.kind, Boolean(unit[relayField]), unit.relayObserved);
    setLight(group, definition, latched, unit.relayObserved, latched);
  }
}

function markStale(): void {
  for (let index = 1; index <= 6; index += 1) {
    const group = ensureLightGroup(index);
    if (!group) continue;
    group.classList.add('is-stale');
    for (const definition of DETECTOR_STATUS_LIGHTS) {
      const light = group.querySelector<HTMLElement>(`[data-kind="${definition.kind}"]`);
      if (light) {
        const latched = definition.source === 'relay' && isLatched(index, definition.kind);
        setLight(group, definition, latched, false, latched);
        if (!latched) light.setAttribute('aria-label', `${definition.title}：状态数据暂不可用`);
      }
    }
  }
}

let requestBusy = false;
let lastSuccessAt = 0;
let relaySessionActive = false;
let relaySessionBatchId: string | null = null;
let cachedProductConfig: ProductConfigPayload | null = null;
let lastProductConfigFetchAt = 0;
let runtimeDisposed = false;
let activeRequestController: AbortController | null = null;
const latchedLightKinds = new Map<number, Set<LightKind>>();

function resetLatchedLights(): void {
  latchedLightKinds.clear();
}

function updateRelaySession(active: boolean, batchId: string | null): void {
  // Keep completed relay evidence visible while idle. As soon as the next
  // production process becomes active, or its formal batch id changes, clear all
  // relay LED latches before applying evidence from the new run.
  const startsNewTest = startsNewRelayStatusSession(
    { active: relaySessionActive, batchId: relaySessionBatchId },
    { active, batchId },
  );
  if (startsNewTest) {
    resetLatchedLights();
    // Do not allow a 500 ms cached /api/product-config response from the previous
    // batch to immediately re-latch LEDs after the new-batch reset.
    cachedProductConfig = null;
    lastProductConfigFetchAt = 0;
  }
  if (batchId !== null) relaySessionBatchId = batchId;
  relaySessionActive = active;
}

function latchState(index: number, kind: LightKind, active: boolean, known: boolean): boolean {
  let kinds = latchedLightKinds.get(index);
  if (!kinds) {
    kinds = new Set<LightKind>();
    latchedLightKinds.set(index, kinds);
  }
  if (known && active) kinds.add(kind);
  return kinds.has(kind);
}

function isLatched(index: number, kind: LightKind): boolean {
  return latchedLightKinds.get(index)?.has(kind) ?? false;
}

function relayEvidenceObserved(unit: RelayUnitEvidence): boolean {
  if (unit.baseline?.alarmPhysical != null || unit.baseline?.faultPhysical != null) return true;
  return Boolean(
    unit.alarm?.physicalStateReached
    || unit.alarm?.physicalRecovered
    || unit.fault?.physicalStateReached
    || unit.fault?.physicalRecovered,
  );
}

function mergeRelayEvidence(payload: StatusLightPayload, configPayload: ProductConfigPayload | null): StatusLightPayload {
  const precheck = configPayload?.precheck;
  const evidenceUnits = precheck?.relayFunctionalTest?.units;
  if (!Array.isArray(evidenceUnits) || evidenceUnits.length === 0) return payload;
  if (!canMergeRelayEvidence(payload.active, precheck?.verdict === 'PENDING', relaySessionActive)) return payload;

  const evidenceBatchId = precheck?.batchId ?? null;
  // During a new active test, evidence is valid only when it belongs to the exact
  // current batch. This prevents the previous batch's completed relay evidence
  // from being merged during the short interval before the new precheck exists.
  if (evidenceBatchId && evidenceBatchId !== payload.batchId) return payload;

  const evidenceByIndex = new Map(evidenceUnits.map((unit) => [unit.detectorIndex, unit]));
  return {
    ...payload,
    active: payload.active || precheck?.verdict === 'PENDING',
    batchId: payload.batchId ?? precheck?.batchId ?? null,
    units: payload.units.map((unit) => {
      const evidence = evidenceByIndex.get(unit.index);
      if (!evidence) return unit;
      const relayObserved = unit.relayObserved || relayEvidenceObserved(evidence);
      return {
        ...unit,
        // The formal relay test deliberately resets every detector after each
        // action. Therefore current live fire/fault can already be false when the
        // UI next polls. Preserve successful internal/physical observations as
        // evidence and let the existing LED latch keep them visible for the batch.
        fire: unit.fire || Boolean(evidence.alarm?.internalStateReached),
        fault: unit.fault || Boolean(evidence.fault?.internalStateReached),
        alarmRelay: unit.alarmRelay || Boolean(evidence.alarm?.physicalStateReached),
        faultRelay: unit.faultRelay || Boolean(evidence.fault?.physicalStateReached),
        relayObserved,
      };
    }),
  };
}

function mergeIndicatorVisionEvidence(payload: StatusLightPayload, configPayload: ProductConfigPayload | null): StatusLightPayload {
  const precheck = configPayload?.precheck;
  const vision = precheck?.indicatorVision;
  const evidenceUnits = vision?.units;
  if (!Array.isArray(evidenceUnits) || evidenceUnits.length === 0) return payload;

  const evidenceBatchId = precheck?.batchId ?? vision?.batchId ?? null;
  if (evidenceBatchId && evidenceBatchId !== payload.batchId) return payload;

  const evidenceByIndex = new Map(evidenceUnits.map((unit) => [unit.slot, unit]));
  return {
    ...payload,
    batchId: payload.batchId ?? evidenceBatchId,
    units: payload.units.map((unit) => {
      const evidence = evidenceByIndex.get(unit.index);
      if (!evidence) return unit;
      return {
        ...unit,
        indicatorVision: {
          runningGreen: evidence.runningGreen,
          fireRed: evidence.fireRed,
          faultYellow: evidence.faultYellow,
        },
      };
    }),
  };
}

async function productConfigEvidence(signal?: AbortSignal): Promise<ProductConfigPayload | null> {
  const now = Date.now();
  if (cachedProductConfig && now - lastProductConfigFetchAt < 500) return cachedProductConfig;
  try {
    const response = await fetch(`${backendHttpUrl()}/api/product-config`, { cache: 'no-store', signal });
    if (!response.ok) return cachedProductConfig;
    cachedProductConfig = await response.json() as ProductConfigPayload;
    lastProductConfigFetchAt = now;
    return cachedProductConfig;
  } catch {
    return cachedProductConfig;
  }
}

async function refreshStatusLights(): Promise<void> {
  if (runtimeDisposed || !document.querySelector('.wutos-detector-grid') || requestBusy) return;
  requestBusy = true;
  const controller = new AbortController();
  activeRequestController = controller;
  try {
    const response = await fetch(`${backendHttpUrl()}/api/detector-status-lights`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`STATUS_LIGHTS_HTTP_${response.status}`);
    const rawPayload = await response.json() as StatusLightPayload;
    const configPayload = await productConfigEvidence(controller.signal);
    if (runtimeDisposed) return;
    const payload = mergeIndicatorVisionEvidence(mergeRelayEvidence(rawPayload, configPayload), configPayload);
    updateRelaySession(Boolean(payload.active), payload.batchId ?? null);
    const byIndex = new Map((Array.isArray(payload.units) ? payload.units : []).map((unit) => [unit.index, unit]));
    for (let index = 1; index <= 6; index += 1) {
      const unit = byIndex.get(index) ?? {
        index,
        online: false,
        fire: false,
        fault: false,
        alarmRelay: false,
        faultRelay: false,
        relayObserved: false,
      };
      applyUnit(unit);
    }
    lastSuccessAt = Date.now();
  } catch {
    if (!runtimeDisposed && Date.now() - lastSuccessAt > 1500) markStale();
  } finally {
    if (activeRequestController === controller) activeRequestController = null;
    requestBusy = false;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  type StatusLightRuntimeHandle = { dispose: () => void };
  type StatusLightRuntimeWindow = Window & { __wutosStatusLightRuntime?: StatusLightRuntimeHandle };
  const runtimeWindow = window as StatusLightRuntimeWindow;
  runtimeWindow.__wutosStatusLightRuntime?.dispose();
  runtimeDisposed = false;
  const handleFocus = () => { void refreshStatusLights(); };
  const timer = window.setInterval(() => { void refreshStatusLights(); }, 200);
  window.addEventListener('focus', handleFocus);
  const handle: StatusLightRuntimeHandle = {
    dispose: () => {
      runtimeDisposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      activeRequestController?.abort();
      activeRequestController = null;
      if (runtimeWindow.__wutosStatusLightRuntime === handle) delete runtimeWindow.__wutosStatusLightRuntime;
    },
  };
  runtimeWindow.__wutosStatusLightRuntime = handle;
  void refreshStatusLights();
}
