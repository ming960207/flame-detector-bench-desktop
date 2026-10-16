import type { ProductPrecheckReport } from './product-profile.js';
import type { ProductionTestSkipConfig } from './production-test-skip-config.js';

export type ResultLightState = 'PASS' | 'FAIL' | 'PENDING' | 'SKIPPED';

/** Result-card evidence is independent of live DIO levels after reset. */
export function detectorResultLights(
  index: number,
  batchId: string | null,
  precheck: ProductPrecheckReport | null,
  skip: ProductionTestSkipConfig,
): Record<'runningGreen' | 'fireRed' | 'faultYellow' | 'alarmRelay' | 'faultRelay', ResultLightState> {
  const report = batchId && precheck?.batchId === batchId ? precheck : null;
  const vision = report?.indicatorVision?.batchId === batchId
    ? report?.indicatorVision?.units.find((unit) => unit.slot === index) : undefined;
  const relayReport = report?.relayFunctionalTest?.batchId === batchId ? report?.relayFunctionalTest : null;
  const relay = relayReport?.units.find((unit) => unit.detectorIndex === index);
  const relaySkipped = Boolean(batchId && (skip.relayFunctionalTest || relayReport?.verdict === 'SKIPPED'));
  return {
    runningGreen: batchId && skip.indicatorVision ? 'SKIPPED' : vision?.runningGreen ?? 'PENDING',
    fireRed: batchId && skip.indicatorVision ? 'SKIPPED' : vision?.fireRed ?? 'PENDING',
    // Yellow is retained as camera diagnostic evidence only.
    faultYellow: vision?.faultYellow ?? 'PENDING',
    alarmRelay: relaySkipped ? 'SKIPPED' : relay?.alarm.verdict ?? 'PENDING',
    faultRelay: relaySkipped ? 'SKIPPED' : relay?.fault.verdict ?? 'PENDING',
  };
}
