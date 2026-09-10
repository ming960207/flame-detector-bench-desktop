import './detector-status-lights.css';

type StatusLightUnit = {
  index: number;
  online: boolean;
  fire: boolean;
  fault: boolean;
  alarmRelay: boolean;
  faultRelay: boolean;
  relayObserved: boolean;
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

type ProductConfigPayload = {
  precheck?: {
    batchId?: string | null;
    verdict?: 'PASS' | 'FAIL' | 'PENDING';
    relayFunctionalTest?: {
      phase?: string;
      units?: RelayUnitEvidence[];
    } | null;
  } | null;
};

type LightKind = 'fire' | 'fault' | 'alarm-relay' | 'fault-relay';

const LIGHTS: ReadonlyArray<{ kind: LightKind; title: string; field: keyof Pick<StatusLightUnit, 'fire' | 'fault' | 'alarmRelay' | 'faultRelay'> }> = [
  { kind: 'fire', title: '火警', field: 'fire' },
  { kind: 'fault', title: '故障', field: 'fault' },
  { kind: 'alarm-relay', title: '火警继电器', field: 'alarmRelay' },
  { kind: 'fault-relay', title: '故障继电器', field: 'faultRelay' },
];

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
  if (group) {
    group.querySelectorAll<HTMLElement>('.wutos-detector-state-led').forEach(sanitizeLightElement);
    const metrics = card.querySelector<HTMLElement>(':scope > .wutos-detector-card__metrics');
    if (metrics && group.nextElementSibling !== metrics) card.insertBefore(group, metrics);
    return group;
  }

  group = document.createElement('div');
  group.className = 'wutos-detector-card__status-lights';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `探测器${index}四状态指示灯`);

  for (const definition of LIGHTS) {
    const light = document.createElement('span');
    light.className = `wutos-detector-state-led is-${definition.kind}`;
    light.dataset.kind = definition.kind;
    light.setAttribute('role', 'img');
    light.setAttribute('aria-label', `${definition.title}：未激活`);
    sanitizeLightElement(light);
    group.appendChild(light);
  }
  const metrics = card.querySelector<HTMLElement>(':scope > .wutos-detector-card__metrics');
  if (metrics) card.insertBefore(group, metrics);
  else card.appendChild(group);
  return group;
}

function setLight(group: HTMLElement, definition: typeof LIGHTS[number], active: boolean, known = true, latched = false): void {
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
  for (const definition of LIGHTS) {
    const relayLight = definition.kind === 'alarm-relay' || definition.kind === 'fault-relay';
    const known = relayLight ? unit.relayObserved : true;
    const latched = latchState(unit.index, definition.kind, Boolean(unit[definition.field]), known);
    setLight(group, definition, latched, known, latched);
  }
}

function markStale(): void {
  for (let index = 1; index <= 6; index += 1) {
    const group = ensureLightGroup(index);
    if (!group) continue;
    group.classList.add('is-stale');
    for (const definition of LIGHTS) {
      const light = group.querySelector<HTMLElement>(`[data-kind="${definition.kind}"]`);
      if (light) {
        const latched = isLatched(index, definition.kind);
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
const latchedLightKinds = new Map<number, Set<LightKind>>();

function resetLatchedLights(): void {
  latchedLightKinds.clear();
}

function updateRelaySession(active: boolean, batchId: string | null): void {
  // Keep the completed batch's evidence visible while idle. As soon as the next
  // production process becomes active, or its formal batch id changes, clear all
  // four LED latches before applying any evidence from the new run.
  const startsNewTest = active && (!relaySessionActive || batchId !== relaySessionBatchId);
  if (startsNewTest) {
    resetLatchedLights();
    // Do not allow a 500 ms cached /api/product-config response from the previous
    // batch to immediately re-latch LEDs after the new-batch reset.
    cachedProductConfig = null;
    lastProductConfigFetchAt = 0;
  }
  if (active) relaySessionBatchId = batchId;
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

  const evidenceBatchId = precheck?.batchId ?? null;
  // During a new active test, evidence is valid only when it belongs to the exact
  // current batch. This prevents the previous batch's completed relay evidence
  // from being merged during the short interval before the new precheck exists.
  if (payload.active && evidenceBatchId !== payload.batchId) return payload;
  if (payload.batchId && evidenceBatchId && payload.batchId !== evidenceBatchId) return payload;

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

async function productConfigEvidence(): Promise<ProductConfigPayload | null> {
  const now = Date.now();
  if (cachedProductConfig && now - lastProductConfigFetchAt < 500) return cachedProductConfig;
  try {
    const response = await fetch(`${backendHttpUrl()}/api/product-config`, { cache: 'no-store' });
    if (!response.ok) return cachedProductConfig;
    cachedProductConfig = await response.json() as ProductConfigPayload;
    lastProductConfigFetchAt = now;
    return cachedProductConfig;
  } catch {
    return cachedProductConfig;
  }
}

async function refreshStatusLights(): Promise<void> {
  if (!document.querySelector('.wutos-detector-grid') || requestBusy) return;
  requestBusy = true;
  try {
    const response = await fetch(`${backendHttpUrl()}/api/detector-status-lights`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`STATUS_LIGHTS_HTTP_${response.status}`);
    const rawPayload = await response.json() as StatusLightPayload;
    const payload = mergeRelayEvidence(rawPayload, await productConfigEvidence());
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
    if (Date.now() - lastSuccessAt > 1500) markStale();
  } finally {
    requestBusy = false;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.setInterval(() => { void refreshStatusLights(); }, 200);
  window.addEventListener('focus', () => { void refreshStatusLights(); });
  void refreshStatusLights();
}
