type PrecheckUnit = {
  index: number;
  reasons?: string[];
};

type ProductConfigPayload = {
  precheck?: {
    units?: PrecheckUnit[];
  } | null;
};

const ENGLISH_REASON = /[A-Z]{2,}(?:_[A-Z0-9]+)+/;

function backendHttpUrl(): string {
  const runtime = (window as Window & { desktopRuntime?: { backendHttpUrl?: string } }).desktopRuntime;
  if (runtime?.backendHttpUrl) return runtime.backendHttpUrl;
  if (window.location.port === '3002') return `http://${window.location.hostname}:3001`;
  return import.meta.env.VITE_BACKEND_API_URL || `http://${window.location.hostname}:3001`;
}

function normalizedRelayReason(reason: string): string {
  return reason.replace(/^RELAY:/, '').replace(/^(ALARM|FAULT):/, '');
}

export function conciseRelayReason(reasons: readonly string[] | undefined): string {
  const codes = (reasons ?? []).map(normalizedRelayReason);
  const has = (code: string) => codes.some((reason) => reason === code || reason.startsWith(`${code}:`));

  if (has('ALARM_RELAY_NOT_ACTUATED')) return '火警继电器未动作';
  if (has('ALARM_RELAY_STUCK_AFTER_RESET')) return '火警继电器未复位';
  if (has('FAULT_RELAY_NOT_ACTUATED')) return '故障继电器未动作';
  if (has('FAULT_RELAY_STUCK_AFTER_RESET')) return '故障继电器未复位';
  if (has('ALARM_RELAY_ACTIVE_AT_BASELINE')) return '火警反馈初始异常';
  if (has('FAULT_RELAY_ACTIVE_AT_BASELINE')) return '故障反馈初始异常';
  if (has('ALARM_COMMAND_FAILED')) return '火警动作指令失败';
  if (has('FAULT_COMMAND_FAILED')) return '故障动作指令失败';
  if (has('ALARM_RESET_COMMAND_FAILED')) return '火警复位指令失败';
  if (has('FAULT_RESET_COMMAND_FAILED')) return '故障复位指令失败';
  if (has('RELAY_FEEDBACK_READ_FAILED') || has('EMERGENCY_RESET_FEEDBACK_READ_FAILED')) return '继电器反馈读取失败';
  if (has('RELAY_BASELINE_READ_FAILED')) return '继电器反馈读取失败';
  if (has('RELAY_FEEDBACK_MAPPING_MISSING') || has('DIO_NOT_CONFIGURED') || has('RELAY_TEST_GLOBAL_DISABLED')) return '继电器检测配置异常';
  if (has('EMERGENCY_RESET_COMMAND_FAILED')) return '继电器复位指令失败';
  if (has('RELAY_TEST_ABORTED')) return '继电器检测中断';
  return '继电器检测异常';
}

export function conciseDetectionReason(reason: string, precheckReasons?: readonly string[]): string {
  const normalized = reason.trim();
  if (!normalized) return '检测未通过';
  if (normalized.includes('测试链路异常')) return '测试链路异常';
  if (normalized === 'RELAY_FUNCTIONAL_TEST_FAILED' || normalized.includes('RELAY_FUNCTIONAL_TEST_FAILED')) {
    return conciseRelayReason(precheckReasons);
  }
  if (normalized.includes('SOFTWARE_VERSION_MISMATCH')) return '软件版本不符';
  if (normalized.includes('SOFTWARE_VERSION')) return '软件版本异常';
  if (normalized.includes('PROBE_COUNT_MISMATCH')) return '探头数量不符';
  if (normalized.includes('PROBE_COUNT') || normalized.includes('PRODUCT_INFO')) return '产品信息异常';
  if (normalized.includes('DETECTOR_FAULT')) return '探测器故障';
  if (normalized.includes('DETECTOR_OFFLINE')) return '探测器离线';
  if (normalized.includes('STARTUP')) return '探测器通讯异常';
  if (normalized.includes('TEST_INVALID')) return '测试链路异常';
  if (normalized.includes('NOISE_RMS_EXCEEDS_LIMIT')) return '波动噪声超限';
  if (normalized.includes('NOISE_RMS_BELOW_LIMIT')) return '波动噪声过低';
  if (normalized.includes('NOISE_ABSOLUTE_EXCEEDS_LIMIT')) return '绝对噪声超限';
  if (normalized.includes('SIGNAL_NO_DATA')) return '探头无有效信号';
  if (normalized.includes('SAMPLES_MISSING')) return '采样数据不足';
  if (normalized.includes('HEAT_')) return '移动热源检测异常';
  if (normalized.includes('FLASH_')) return '爆闪检测异常';
  if (normalized.includes('EMC_')) return '电磁干扰检测异常';
  if (normalized.includes('INTERFERENCE')) return '抗干扰检测异常';
  if (normalized.includes('WAVEFORM')) return '波形数据异常';
  if (normalized.includes('PRECHECK')) return '产品预检异常';
  return ENGLISH_REASON.test(normalized) ? '检测未通过' : normalized;
}

function slotFromCard(card: HTMLElement): number | null {
  const label = card.getAttribute('aria-label') ?? '';
  const match = /探测器(\d+)检测结果/.exec(label);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

function applyChineseReasons(payload: ProductConfigPayload | null): void {
  const precheckByIndex = new Map((payload?.precheck?.units ?? []).map((unit) => [unit.index, unit.reasons ?? []]));
  for (const card of document.querySelectorAll<HTMLElement>('.wutos-detector-card')) {
    const failure = card.querySelector<HTMLElement>('.wutos-detector-card__failure');
    if (!failure) continue;
    const raw = (failure.textContent ?? '').trim();
    const splitAt = raw.indexOf('：');
    const prefix = splitAt >= 0 ? raw.slice(0, splitAt) : '不合格原因';
    const reason = splitAt >= 0 ? raw.slice(splitAt + 1).trim() : raw;
    const index = slotFromCard(card);
    const translated = conciseDetectionReason(reason, index === null ? undefined : precheckByIndex.get(index));
    const text = `${prefix}：${translated}`;
    if (failure.textContent !== text) failure.textContent = text;
    failure.title = translated;
  }
}

let cachedConfig: ProductConfigPayload | null = null;
let lastFetchAt = 0;
let busy = false;
let disposed = false;

async function refreshChineseReasons(): Promise<void> {
  if (disposed || busy || !document.querySelector('.wutos-detector-grid')) return;
  busy = true;
  try {
    const now = Date.now();
    if (now - lastFetchAt >= 500) {
      const response = await fetch(`${backendHttpUrl()}/api/product-config`, { cache: 'no-store' });
      if (response.ok) cachedConfig = await response.json() as ProductConfigPayload;
      lastFetchAt = now;
    }
    if (!disposed) applyChineseReasons(cachedConfig);
  } catch {
    if (!disposed) applyChineseReasons(cachedConfig);
  } finally {
    busy = false;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  type RuntimeHandle = { dispose: () => void };
  type RuntimeWindow = Window & { __wutosDetectionReasonCnRuntime?: RuntimeHandle };
  const runtimeWindow = window as RuntimeWindow;
  runtimeWindow.__wutosDetectionReasonCnRuntime?.dispose();
  disposed = false;
  const timer = window.setInterval(() => { void refreshChineseReasons(); }, 250);
  const handle: RuntimeHandle = {
    dispose: () => {
      disposed = true;
      window.clearInterval(timer);
      if (runtimeWindow.__wutosDetectionReasonCnRuntime === handle) delete runtimeWindow.__wutosDetectionReasonCnRuntime;
    },
  };
  runtimeWindow.__wutosDetectionReasonCnRuntime = handle;
  void refreshChineseReasons();
}
