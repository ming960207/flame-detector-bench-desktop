import { config } from './config.js';
import { createFieldStatusRuntime, normalizeFlameConfig, selectFieldPLCProcessObserver, type FieldStatusRuntime } from './closure/field-status-server.js';
import { FileFieldTestResultLogger } from './closure/field-test-result-log.js';
import { FlameDetectorService } from './modbus/flame-detector-service.js';
import { loadPLCConfigs, mergeWithDefaults } from './plc-config-store.js';
import { PLCProcessMonitor } from './plc-process-monitor.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
  type ProductDetectionConfig,
  type ProductPrecheckReport,
} from './product-profile.js';
import { loadSystemConfig } from './system-config-store.js';

const POSITION_ONE_CONTACT_SETTLE_MS = 800;

/**
 * Product-flow adapter around the shared detector service.
 *
 * The first formal precheck must be read-only. A four-wavelength device is not
 * identified until probeCount is read, so blindly calling setSendMode(0) before
 * that read would use the default three-wavelength write shape. We only send a
 * stop command when this process has actually armed streaming, or when a real
 * waveform stream is already arriving from a previous/crashed session (in that
 * case the frame decoder has already identified the protocol profile).
 */
export class ProductAwareFlameDetectorService extends FlameDetectorService {
  private productWaveformStarted = false;

  override async stopWaveformStreaming(): Promise<void> {
    if (!this.productWaveformStarted && !this.isDataStreamConnected()) return;
    await super.stopWaveformStreaming();
    this.productWaveformStarted = false;
  }

  override async startWaveformStreaming(): Promise<void> {
    await super.startWaveformStreaming();
    this.productWaveformStarted = true;
  }

  override async runProductPrecheck(
    productConfig: ProductDetectionConfig,
    batchId: string | null = null,
  ): Promise<ProductPrecheckReport> {
    // The detector is physically contacted by the fixture at position 1. Give
    // the existing 250 ms reconnect loop enough time to observe that contact
    // before freezing the transport state for the three sequential reads.
    await new Promise((resolve) => setTimeout(resolve, POSITION_ONE_CONTACT_SETTLE_MS));
    return super.runProductPrecheck(productConfig, batchId);
  }
}

export async function startProductAwareFieldStatusServer(): Promise<FieldStatusRuntime> {
  const savedPLCs = await loadPLCConfigs();
  const mergedPLCs = mergeWithDefaults(savedPLCs.length > 0 ? savedPLCs : config.plcs);
  config.plcs = [selectFieldPLCProcessObserver(mergedPLCs)];

  const systemConfig = await loadSystemConfig();
  const savedFlameConfig = systemConfig?.flameConfig
    ? { ...config.flame, ...systemConfig.flameConfig }
    : config.flame;
  config.flame = normalizeFlameConfig(savedFlameConfig, config.flame);
  const productConfig = normalizeProductDetectionConfig(
    systemConfig?.productDetectionConfig,
    DEFAULT_PRODUCT_DETECTION_CONFIG,
  );

  const runtime = createFieldStatusRuntime(
    new PLCProcessMonitor(config.plcs[0]!),
    new ProductAwareFlameDetectorService(config.flame, { deferWaveformUntilInspection: true }),
    new FileFieldTestResultLogger(),
    productConfig,
  );
  const port = await runtime.listen();
  console.log(`[现场状态] 已启动产品预检增强运行时：http://127.0.0.1:${port}`);
  return runtime;
}
