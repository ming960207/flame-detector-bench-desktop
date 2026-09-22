import './detector-status-lights.css';
import type { IndicatorVisionLightVerdict } from '../server/src/indicator-vision';
import {
  DETECTOR_STATUS_LIGHTS,
  indicatorVisionState,
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

type IndicatorVisionUnitEvidence = {
  slot: number;
  runningGreen?: IndicatorVisionLightVerdict;
  fireRed?: IndicatorVisionLightVerdict;
  faultYellow?: IndicatorVisionLightVerdict;
};

type ProductConfigPayload = {
  precheck?: {
    batchId?: string | null;
    indicatorVision?: {
      batchId?: string | null;
      units?: IndicatorVisionUnitEvidence[];
    } | null;
  } | null;
};

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

function setLight(
  group: HTMLElement,
  definition: typeof DETECTOR_STATUS_LIGHTS[number],
  active: boolean,
  known = true,
): void {
  const light = group.querySelector<HTMLElement>(`[data-kind="${definition.kind}"]`);
  if (!light) return;
  sanitizeLightElement(light);
  light.classList.toggle('is-active', active);
  light.classList.remove('is-latched');
  light.classList.toggle('is-unknown', !known);
  light.setAttribute('aria-label', !known
    ? `${definition.title}：未采集`
    : `${definition.title}：${active ? '亮' : '灭'}`);
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

    // Relay lamps are a direct mirror of the current physical DIO feedback.
    // Never latch historical action evidence and never infer them from detector
    // internal fire/fault state or from camera indicator results.
    const relayField = definition.field as RelayLightField;
    setLight(group, definition, Boolean(unit[relayField]), unit.relayObserved);
  }
}

function markStale(): void {
  for (let index = 1; index <= 6; index += 1) {
    const group = ensureLightGroup(index);
    if (!group) continue;
    group.classList.add('is-stale');
    for (const definition of DETECTOR_STATUS_LIGHTS) {
      setLight(group, definition, false, false);
      const light = group.querySelector<HTMLElement>(`[data-kind="${definition.kind}"]`);
      if (light) light.setAttribute('aria-label', `${definition.title}：状态数据暂不可用`);
    }
  }
}

let requestBusy = false;
let lastSuccessAt = 0;
let cachedProductConfig: ProductConfigPayload | null = null;
let lastProductConfigFetchAt = 0;
let runtimeDisposed = false;
let activeRequestController: AbortController | null = null;

function mergeIndicatorVisionEvidence(
  payload: StatusLightPayload,
  configPayload: ProductConfigPayload | null,
): StatusLightPayload {
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
    const payload = mergeIndicatorVisionEvidence(rawPayload, configPayload);
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
