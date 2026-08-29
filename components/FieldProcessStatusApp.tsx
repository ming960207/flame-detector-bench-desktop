import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { hasActivePLCProcessAlarm, type PLCProcessStatus } from '../server/src/process-status';
import type { FieldFinalVerdict } from '../server/src/closure/field-final-verdict';
import type { FieldDetectorBatchVerdict } from '../server/src/closure/field-detector-verdict';
import type { FieldWaveformAnalysisSnapshot } from '../server/src/closure/field-waveform-analysis';
import type { ProductDetectionConfig, ProductPrecheckReport } from '../server/src/product-profile';
import type { FlameDetectorState, FlameDetectorWaveformDelta } from '../server/src/types';
import type { FlameDetectorConfig } from '../types';
import { mergeFlameWaveformDelta } from '../utils/waveform';
import { FlameDetectorWorkbench } from './FlameDetectorWorkbench';
import { ProductTypeControl } from './ProductTypeControl';
import { WutosDashboard } from './WutosDashboard';
import './field-process-status.css';

const DESKTOP_RUNTIME = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
const HTTP = DESKTOP_RUNTIME?.backendHttpUrl || import.meta.env.VITE_BACKEND_API_URL || 'http://' + window.location.hostname + ':3001';
const WS = DESKTOP_RUNTIME?.backendWsUrl || import.meta.env.VITE_BACKEND_WS_URL || 'ws://' + window.location.hostname + ':3001';
const WS_RECONNECT_DELAY_MS = 250;

interface FieldSummaryPayload {
  process?: PLCProcessStatus;
  waveformAnalysis?: FieldWaveformAnalysisSnapshot;
  detectorVerdict?: FieldDetectorBatchVerdict;
  finalVerdict: FieldFinalVerdict;
  productConfig?: ProductDetectionConfig;
  productSelectionLocked?: boolean;
  productPrecheck?: ProductPrecheckReport | null;
  productPrecheckBusy?: boolean;
}

function processDisplayLabel(status: PLCProcessStatus | null | undefined) {
  const label = status?.processLabel ?? status?.label;
  if (!label) return '工序待同步';
  return hasActivePLCProcessAlarm(status) ? label + ' · 告警/中止' : label;
}

export function FieldProcessStatusApp() {
  const [status, setStatus] = useState<PLCProcessStatus | null>(null);
  const [detectors, setDetectors] = useState<FlameDetectorState | null>(null);
  const [waveformAnalysis, setWaveformAnalysis] = useState<FieldWaveformAnalysisSnapshot | null>(null);
  const [detectorVerdict, setDetectorVerdict] = useState<FieldDetectorBatchVerdict | null>(null);
  const [finalVerdict, setFinalVerdict] = useState<FieldFinalVerdict | null>(null);
  const [flameConfig, setFlameConfig] = useState<FlameDetectorConfig | null>(null);
  const [productConfig, setProductConfig] = useState<ProductDetectionConfig | null>(null);
  const [productLocked, setProductLocked] = useState(false);
  const [productPrecheck, setProductPrecheck] = useState<ProductPrecheckReport | null>(null);
  const [productPrecheckBusy, setProductPrecheckBusy] = useState(false);
  const [channelOnline, setChannelOnline] = useState(false);
  const [notice, setNotice] = useState('PLC 未接入：工序监测处于待同步状态。');
  const [detailsOpen, setDetailsOpen] = useState(false);

  const applySummary = useCallback((summary: FieldSummaryPayload) => {
    setStatus(summary.process ?? null);
    setWaveformAnalysis(summary.waveformAnalysis ?? null);
    setDetectorVerdict(summary.detectorVerdict ?? null);
    setFinalVerdict(summary.finalVerdict);
    if (summary.productConfig) setProductConfig(summary.productConfig);
    setProductLocked(Boolean(summary.productSelectionLocked));
    setProductPrecheck(summary.productPrecheck ?? null);
    setProductPrecheckBusy(Boolean(summary.productPrecheckBusy));
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch(HTTP + '/api/field/summary');
    if (!response.ok) throw new Error('PLC 工序服务未启动');
    const summary = await response.json() as FieldSummaryPayload;
    applySummary(summary);

    const deviceResponse = await fetch(HTTP + '/api/flame/devices');
    if (deviceResponse.ok) setDetectors(await deviceResponse.json() as FlameDetectorState);

    const configResponse = await fetch(HTTP + '/api/flame/config');
    if (configResponse.ok) {
      const configPayload = await configResponse.json() as { config?: FlameDetectorConfig };
      if (configPayload.config) setFlameConfig(configPayload.config);
    }

    setNotice(summary.process?.valid
      ? 'PLC 工序已同步：' + processDisplayLabel(summary.process)
      : 'PLC 未接入：工序监测处于待同步状态。');
  }, [applySummary]);

  const updateProductConfig = useCallback(async (patch: Partial<ProductDetectionConfig> | ProductDetectionConfig) => {
    const response = await fetch(`${HTTP}/api/product-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const result = await response.json() as { success?: boolean; config?: ProductDetectionConfig; locked?: boolean; code?: string; error?: string };
    if (!response.ok || !result.success || !result.config) {
      throw new Error(result.error || result.code || '产品配置保存失败');
    }
    setProductConfig(result.config);
    setProductLocked(Boolean(result.locked));
    setProductPrecheck(null);
    await refresh();
  }, [refresh]);

  const handleRefresh = useCallback(() => {
    void refresh().catch(() => setNotice('PLC 未接入：工序监测处于待同步状态。'));
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    void refresh().catch(() => setNotice('PLC 未接入：工序监测处于待同步状态。'));

    const connect = () => {
      try {
        socket = new WebSocket(WS);
      } catch {
        setChannelOnline(false);
        if (!disposed) timer = setTimeout(connect, WS_RECONNECT_DELAY_MS);
        return;
      }
      socket.onopen = () => setChannelOnline(true);
      socket.onerror = () => setChannelOnline(false);
      socket.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data) as { type: string; payload: unknown };
          if (message.type === 'plc_process_status') {
            const next = message.payload as PLCProcessStatus;
            setStatus(next);
            setNotice(next.valid
              ? 'PLC 工序已同步：' + processDisplayLabel(next)
              : 'PLC 返回未知工序码');
          }
          if (message.type === 'flame_state') setDetectors(message.payload as FlameDetectorState);
          if (message.type === 'flame_waveform_delta') {
            setDetectors((previous) => previous
              ? mergeFlameWaveformDelta(previous, message.payload as FlameDetectorWaveformDelta)
              : previous);
          }
          if (message.type === 'field_summary') applySummary(message.payload as FieldSummaryPayload);
        } catch {
          setNotice('数据通道返回无效消息，等待下一次同步。');
        }
      };
      socket.onclose = () => {
        setChannelOnline(false);
        if (!disposed) timer = setTimeout(connect, WS_RECONNECT_DELAY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [applySummary, refresh]);

  return <>
    <ProductTypeControl
      config={productConfig}
      locked={productLocked}
      precheck={productPrecheck}
      busy={productPrecheckBusy}
      onUpdate={updateProductConfig}
    />
    <WutosDashboard
      status={status}
      detectors={detectors}
      waveformAnalysis={waveformAnalysis}
      detectorVerdict={detectorVerdict}
      finalVerdict={finalVerdict}
      channelOnline={channelOnline}
      notice={notice}
      waveformDisplayMode={flameConfig?.waveformDisplayMode || 'normalized'}
      waveformMaxSamples={flameConfig?.waveformMaxSamples || 1000}
      onRefresh={handleRefresh}
      onOpenDetails={() => setDetailsOpen(true)}
    />
    {detailsOpen && <div className="wutos-detail-overlay" role="presentation">
      <section className="wutos-detail-shell" role="dialog" aria-modal="true" aria-labelledby="wutos-detail-title">
        <header>
          <div>
            <span className="section-kicker">FIELD DATA DETAIL</span>
            <h2 id="wutos-detail-title">六路波形与通信详情</h2>
            <p>保留现有只读波形、自检和通信配置逻辑；主屏展示产品类型、预检和正式检测摘要。</p>
          </div>
          <button type="button" onClick={() => setDetailsOpen(false)} aria-label="关闭详情"><X size={18} /></button>
        </header>
        <FlameDetectorWorkbench state={detectors} config={flameConfig} analysis={waveformAnalysis} onRefresh={handleRefresh} />
      </section>
    </div>}
  </>;
}
