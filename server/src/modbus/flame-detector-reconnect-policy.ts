/**
 * Back off repeated TCP connection failures without starving a recovered device.
 *
 * A fixed 250ms delay caused all six detector ports to reconnect every second
 * during the 2026-10-12 field outage. Small deterministic per-slot staggering
 * avoids synchronizing those attempts on the same network gateway.
 */
export const DETECTOR_RECONNECT_INITIAL_MS = 300;
export const DETECTOR_RECONNECT_MAX_MS = 4_000;
export const DETECTOR_RECONNECT_SLOT_STAGGER_MS = 45;

export function detectorReconnectDelayMs(consecutiveFailures: number, detectorIndex: number): number {
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(1, Math.trunc(consecutiveFailures))
    : 1;
  const slot = Number.isFinite(detectorIndex)
    ? Math.min(6, Math.max(0, Math.trunc(detectorIndex)))
    : 0;
  const backoff = Math.min(
    DETECTOR_RECONNECT_MAX_MS,
    DETECTOR_RECONNECT_INITIAL_MS * 2 ** Math.min(5, failures - 1),
  );
  return backoff + slot * DETECTOR_RECONNECT_SLOT_STAGGER_MS;
}
