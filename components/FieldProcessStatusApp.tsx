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
import { ProductModelSelector, ProductTypeControl } from './ProductTypeControl';
import { ProductionConfigurationPanel } from './ProductionConfigurationPanel';
import { WutosDashboard } from './WutosDashboard';
import './field-process-status.css';
import './wutos-main-overrides.css';

const DESKTOP_RUNTIME = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
const FIELD_DEV_HTTP = 'http://' + window.location.hostname + ':3001';
const FIELD_DEV_WS = 'ws://' + window.location.hostname + ':3001';
const FIELD_DEV_PAGE = !DESKTOP_RUNTIME && window.location.port === '3002';
const HTTP = DESKTOP_RUNTIME?.backendHttpUrl || (FIELD_DEV_PAGE ? FIELD_DEV_HTTP : import.meta.env.VITE_BACKEND_API_URL || FIELD_DEV_HTTP);
const WS = DESKTOP_RUNTIME?.backendWsUrl || (FIELD_DEV_PAGE ? FIELD_DEV_WS : import.meta.env.VITE_BACKEND_WS_URL || FIELD_DEV_WS);
const WS_RECONNECT_DELAY_MS = 250;

type DetailTab = 'device' | 'product' | 'production';

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
  const [detailTab, setDetailTab] = useState<DetailTab>('device');

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

    // Keep configuration loading independent from summary shape so a stale
    // backend build cannot leave the configuration page looking empty.
    const productResponse = await fetch(HTTP + '/api/product-config');
    if (productResponse.ok) {
      const productPayload = await productResponse.json() as {
        config?: ProductDetectionConfig;
        locked?: boolean;
        precheck?: ProductPrecheckReport | null;
      };
      if (productPayload.config) setProductConfig(productPayload.config);
      if (typeof productPayload.locked === 'boolean') setProductLocked(productPayload.locked);
      if ('precheck' in productPayload) setProductPrecheck(productPayload.precheck ?? null);
    }

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

  const openDetails = useCallback((tab: DetailTab = 'device') => {
    setDetailTab(tab);
    setDetailsOpen(true);
  }, []);

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
      resultTitleMeta={<ProductModelSelector config={productConfig} locked={productLocked} busy={productPrecheckBusy} onUpdate={updateProductConfig} />}
      onRefresh={handleRefresh}
      onOpenDetails={() => openDetails('device')}
    />

    {detailsOpen && <div className="wutos-detail-overlay" role="presentation">
      <section className="wutos-detail-shell" role="dialog" aria-modal="true" aria-labelledby="wutos-detail-title">
        <header>
          <div>
            <span className="section-kicker">FIELD DATA DETAIL</span>
            <h2 id="wutos-detail-title">检测台详情与生产配置</h2>
            <p>主屏仅保留操作员需要的实时状态；波形、产品详细配置、检验记录和生产配置统一在此查看。</p>
          </div>
          <button type="button" onClick={() => setDetailsOpen(false)} aria-label="关闭详情"><X size={18} /></button>
        </header>

        <nav className="wutos-detail-tabs" aria-label="详情页面">
          <button type="button" className={detailTab === 'device' ? 'is-active' : ''} onClick={() => setDetailTab('device')}>设备与波形</button>
          <button type="button" className={detailTab === 'product' ? 'is-active' : ''} onClick={() => setDetailTab('product')}>产品详细配置</button>
          <button type="button" className={detailTab === 'production' ? 'is-active' : ''} onClick={() => setDetailTab('production')}>检验记录 / 生产配置</button>
        </nav>

        <div className="wutos-detail-content">
          {detailTab === 'device' && <FlameDetectorWorkbench state={detectors} config={flameConfig} analysis={waveformAnalysis} onRefresh={handleRefresh} />}

          {detailTab === 'product' && <div className="wutos-detail-product">
            <p className="wutos-detail-section-note">主页面只直接选择生产型号；版本基准、探头数、继电器测试和产品编号规则等低频配置集中在这里编辑。</p>
            <ProductTypeControl
              config={productConfig}
              locked={productLocked}
              precheck={productPrecheck}
              busy={productPrecheckBusy}
              detectorVerdict={detectorVerdict}
              onUpdate={updateProductConfig}
            />
          </div>}

          {detailTab === 'production' && <div className="wutos-detail-production">
            <p className="wutos-detail-section-note">正式检验记录、历史批次、12 路继电器反馈通道、检验员及表单参数均从本详情页进入；主页面不再额外悬浮按钮。</p>
            <ProductionConfigurationPanel backendHttpUrl={HTTP} locked={productLocked} />
          </div>}
        </div>
      </section>
    </div>}
  </>;
}
