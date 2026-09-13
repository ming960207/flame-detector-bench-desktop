from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'expected source block not found: {path}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


service = 'server/src/modbus/flame-detector-service.ts'
replace_once(
    service,
    """    const startedAt = Date.now();
    while (!this.disposed) {
      const report = this.getReadyReport(requiredSlots, timeoutMs);
      if (report.ready) return { ...report, startedAt };
      await new Promise((resolve) => setTimeout(resolve, READY_BARRIER_POLL_INTERVAL_MS));
    }
    return { ...this.getReadyReport(requiredSlots, timeoutMs), ready: false, startedAt, completedAt: Date.now() };
""",
    """    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (!this.disposed) {
      const report = this.getReadyReport(requiredSlots, timeoutMs);
      if (report.ready) return { ...report, startedAt };
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { ...report, ready: false, startedAt, completedAt: Date.now() };
      }
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(READY_BARRIER_POLL_INTERVAL_MS, remainingMs),
      ));
    }
    return { ...this.getReadyReport(requiredSlots, timeoutMs), ready: false, startedAt, completedAt: Date.now() };
""",
)

record_store = 'server/src/production-inspection-record-store.ts'
replace_once(
    record_store,
    """import {
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from './product-profile.js';
""",
    """import {
  expectedProbeChannels,
  selectedProductProfile,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from './product-profile.js';
""",
)
replace_once(
    record_store,
    """const REPORT_AMPLITUDE_CHANNELS = ['probe2', 'probe3'] as const;

function amplitudeValues(snapshot: FieldWaveformAnalysisSnapshot, index: number): number[] {
  const unit = snapshot.units.find((item) => item.index === index);
  if (!unit) return [];
  return REPORT_AMPLITUDE_CHANNELS
    .map((channel) => unit.noiseTest?.metrics?.[channel]?.fluctuation)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function amplitudePassed(snapshot: FieldWaveformAnalysisSnapshot, index: number): boolean {
  const unit = snapshot.units.find((item) => item.index === index);
  return Boolean(
    unit
    && unit.noiseTest?.verdict === 'PASS'
    && amplitudeValues(snapshot, index).length === REPORT_AMPLITUDE_CHANNELS.length,
  );
}
""",
    """function amplitudeValues(
  snapshot: FieldWaveformAnalysisSnapshot,
  index: number,
  channels: ReturnType<typeof expectedProbeChannels>,
): number[] {
  const unit = snapshot.units.find((item) => item.index === index);
  if (!unit) return [];
  return channels
    .map((channel) => unit.noiseTest?.metrics?.[channel]?.fluctuation)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function amplitudePassed(
  snapshot: FieldWaveformAnalysisSnapshot,
  index: number,
  channels: ReturnType<typeof expectedProbeChannels>,
): boolean {
  const unit = snapshot.units.find((item) => item.index === index);
  return Boolean(
    unit
    && unit.noiseTest?.verdict === 'PASS'
    && amplitudeValues(snapshot, index, channels).length === channels.length,
  );
}
""",
)
replace_once(
    record_store,
    """    const amplitudes = amplitudeValues(input.waveformAnalysis, slot);
    const amplitudeOk = amplitudePassed(input.waveformAnalysis, slot);
""",
    """    const amplitudeChannels = expectedProbeChannels(precheck?.actualProbeCount ?? profile.expectedProbeCount);
    const amplitudes = amplitudeValues(input.waveformAnalysis, slot, amplitudeChannels);
    const amplitudeOk = amplitudePassed(input.waveformAnalysis, slot, amplitudeChannels);
""",
)

detector_test = Path('server/test/detector-startup.test.ts')
detector_text = detector_test.read_text(encoding='utf-8')
timeout_test = """

test('waitForReady respects timeoutMs when a required detector never becomes ready', { timeout: 1_000 }, async () => {
  const service = new FlameDetectorService({
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31_111,
    units: [{ index: 1, address: 1, enabled: true, connMode: 'TCP', tcpHost: '127.0.0.1', tcpPort: 31_111 }],
  });
  const startedAt = Date.now();
  const report = await service.waitForReady({ requiredSlots: [1], timeoutMs: 80 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(report.ready, false);
  assert.equal(report.timeoutMs, 80);
  assert.deepEqual(report.requiredSlots, [1]);
  assert.equal(report.units[0]?.ready, false);
  assert.equal(report.units[0]?.startup.state, 'DISCONNECTED');
  assert.ok(elapsedMs >= 60, `waitForReady returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 500, `waitForReady ignored timeoutMs: ${elapsedMs}ms`);
});
"""
if 'waitForReady respects timeoutMs' not in detector_text:
    detector_test.write_text(detector_text.rstrip() + timeout_test.rstrip() + '\n', encoding='utf-8')

production_test = Path('server/test/production-inspection-record.test.ts')
production_text = production_test.read_text(encoding='utf-8')
old_title = "test('record keeps code status separate and reports P2/P3 noise fluctuations as amplitude', () => {"
new_title = "test('record keeps code status separate and reports all actual probe noise fluctuations as amplitude', () => {"
if old_title not in production_text:
    raise SystemExit('expected production record test title not found')
production_text = production_text.replace(old_title, new_title, 1)
old_amplitude = "assert.deepEqual(record.products[0]?.amplitude.values, [110, 105]);"
if old_amplitude not in production_text:
    raise SystemExit('expected three-probe amplitude assertion not found')
production_text = production_text.replace(
    old_amplitude,
    "assert.deepEqual(record.products[0]?.amplitude.values, [100, 110, 105]);",
    1,
)
old_document = "assert.match(document, /110，105/);"
if old_document not in production_text:
    raise SystemExit('expected amplitude document assertion not found')
production_text = production_text.replace(old_document, "assert.match(document, /100，110，105/);", 1)

mapping_test = """

test('production amplitude channels follow the actual probe count', () => {
  const dualConfig = normalizeProductDetectionConfig({ selectedType: 'DUAL_WAVELENGTH' }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const dualPrecheck = precheck(false) as any;
  for (const unit of dualPrecheck.units) unit.actualProbeCount = 2;
  const dualRecord = buildProductionInspectionRecord({
    batchId: 'batch-dual', productConfig: dualConfig, precheck: dualPrecheck, detectorVerdict: detectorVerdict(), waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG, productionDate: Date.now(),
  });
  assert.deepEqual(dualRecord.products[0]?.amplitude.values, [110, 105]);

  const fourConfig = normalizeProductDetectionConfig({ selectedType: 'FOUR_WAVELENGTH' }, DEFAULT_PRODUCT_DETECTION_CONFIG);
  const fourPrecheck = precheck(false) as any;
  for (const unit of fourPrecheck.units) unit.actualProbeCount = 4;
  const fourRecord = buildProductionInspectionRecord({
    batchId: 'batch-four', productConfig: fourConfig, precheck: fourPrecheck, detectorVerdict: detectorVerdict(), waveformAnalysis: analysis(),
    recordConfig: DEFAULT_PRODUCTION_INSPECTION_RECORD_CONFIG, productionDate: Date.now(),
  });
  assert.deepEqual(fourRecord.products[0]?.amplitude.values, [100, 110, 105, 0]);
});
"""
if 'production amplitude channels follow the actual probe count' not in production_text:
    production_text = production_text.rstrip() + mapping_test.rstrip() + '\n'
production_test.write_text(production_text, encoding='utf-8')
