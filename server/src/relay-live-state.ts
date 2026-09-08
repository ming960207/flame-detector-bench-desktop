export interface RelayLiveUnitState {
  detectorIndex: number;
  fire: boolean | null;
  fault: boolean | null;
  alarmRelay: boolean | null;
  faultRelay: boolean | null;
  context: string | null;
  updatedAt: number;
}

export interface RelayLiveState {
  batchId: string | null;
  active: boolean;
  units: RelayLiveUnitState[];
  updatedAt: number;
}

const liveState: RelayLiveState = {
  batchId: null,
  active: false,
  units: [],
  updatedAt: 0,
};

function cloneState(): RelayLiveState {
  return {
    ...liveState,
    units: liveState.units.map((unit) => ({ ...unit })),
  };
}

function unitFor(detectorIndex: number): RelayLiveUnitState {
  let unit = liveState.units.find((item) => item.detectorIndex === detectorIndex);
  if (!unit) {
    unit = {
      detectorIndex,
      fire: null,
      fault: null,
      alarmRelay: null,
      faultRelay: null,
      context: null,
      updatedAt: Date.now(),
    };
    liveState.units.push(unit);
    liveState.units.sort((left, right) => left.detectorIndex - right.detectorIndex);
  }
  return unit;
}

export function beginRelayLiveState(batchId: string | null, detectorIndexes: number[]): void {
  const now = Date.now();
  liveState.batchId = batchId;
  liveState.active = true;
  liveState.units = [...new Set(detectorIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= 6)
    .sort((left, right) => left - right)
    .map((detectorIndex) => ({
      detectorIndex,
      fire: null,
      fault: null,
      alarmRelay: null,
      faultRelay: null,
      context: 'START',
      updatedAt: now,
    }));
  liveState.updatedAt = now;
}

export function updateRelayLiveInternal(
  detectorIndex: number,
  internal: { fire: boolean; fault: boolean },
  context: string,
): void {
  const unit = unitFor(detectorIndex);
  const fire = Boolean(internal.fire);
  const fault = Boolean(internal.fault);
  if (unit.fire === fire && unit.fault === fault && unit.context === context) return;
  const now = Date.now();
  unit.fire = fire;
  unit.fault = fault;
  unit.context = context;
  unit.updatedAt = now;
  liveState.updatedAt = now;
}

export function updateRelayLivePhysical(
  detectorIndex: number,
  physical: { alarm: boolean | null; fault: boolean | null },
  context: string,
): void {
  const unit = unitFor(detectorIndex);
  const alarmRelay = typeof physical.alarm === 'boolean' ? physical.alarm : null;
  const faultRelay = typeof physical.fault === 'boolean' ? physical.fault : null;
  if (unit.alarmRelay === alarmRelay && unit.faultRelay === faultRelay && unit.context === context) return;
  const now = Date.now();
  unit.alarmRelay = alarmRelay;
  unit.faultRelay = faultRelay;
  unit.context = context;
  unit.updatedAt = now;
  liveState.updatedAt = now;
}

export function finishRelayLiveState(): void {
  liveState.active = false;
  liveState.updatedAt = Date.now();
}

export function relayLiveStateSnapshot(): RelayLiveState {
  return cloneState();
}
