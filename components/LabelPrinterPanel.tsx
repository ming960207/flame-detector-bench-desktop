import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  CheckCircle2,
  LayoutTemplate,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Ruler,
  ScanLine,
  Settings2,
  Wifi,
} from 'lucide-react';
import {
  LABEL_TEMPLATE,
  labelNoiseText,
  labelPrinterRuntime,
  type PrinterConnectionType,
  type ProductLabelPrintJob,
} from './label-printer-runtime';
import './label-printer.css';

interface Props {
  backendHttpUrl: string;
}

interface MESStatusView {
  enabled: boolean;
  apiKeyConfigured: boolean;
  pendingJobs: number;
  lastError?: string;
}

type StatusTone = 'wait' | 'printing' | 'printed' | 'blocked' | 'failed';

interface JobStatusView {
  text: string;
  tone: StatusTone;
}

interface PreviewData {
  slot: number;
  model: string;
  code: string;
  verdict: string;
  isolation: boolean;
  date: string;
  noise: string;
}

const FALLBACK_PREVIEW: PreviewData[] = [
  {
    slot: 1,
    model: 'GHT-1050-02',
    code: '410205901010100001',
    verdict: 'A类合格',
    isolation: false,
    date: '2026-09-14',
    noise: 'P2 151 · P3 181',
  },
  {
    slot: 2,
    model: 'GHT-1050-02',
    code: '410205901010100002',
    verdict: 'B类合格',
    isolation: false,
    date: '2026-09-14',
    noise: 'P2 152 · P3 182',
  },
];

function healthText(health: ReturnType<typeof labelPrinterRuntime.getSnapshot>['health']): string {
  if (health === 'ready') return '就绪';
  if (health === 'printing') return '打印中';
  if (health === 'service-offline') return '服务离线';
  if (health === 'printer-offline') return '未连接';
  if (health === 'connecting') return '连接中';
  if (health === 'error') return '异常';
  return '待初始化';
}

function healthTone(health: ReturnType<typeof labelPrinterRuntime.getSnapshot>['health']): string {
  if (health === 'ready') return 'is-ready';
  if (health === 'printing') return 'is-printing';
  if (health === 'connecting' || health === 'idle') return 'is-wait';
  return 'is-fail';
}

function jobStatus(job: ProductLabelPrintJob): JobStatusView {
  if (job.status === 'WAITING') return { text: '待打印', tone: 'wait' };
  if (job.status === 'PRINTING') return { text: '打印中', tone: 'printing' };
  if (job.status === 'PRINTED') return { text: job.reprintCount > 0 ? `已补打 ×${job.reprintCount}` : '已打印', tone: 'printed' };
  if (job.status === 'BLOCKED') return { text: '编号未生成', tone: 'blocked' };
  return { text: '打印失败', tone: 'failed' };
}

function shortError(value: string | null): string {
  if (!value) return '';
  if (value === 'PRODUCT_CODE_NOT_GENERATED') return '产品编号未生成';
  if (value === 'PRINT_LEASE_EXPIRED') return '上次任务超时，已重新排队';
  return value;
}

function previewDate(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '2026-09-14';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function previewData(job: ProductLabelPrintJob | undefined, index: number): PreviewData {
  const fallback = FALLBACK_PREVIEW[index] ?? FALLBACK_PREVIEW[0];
  if (!job) return fallback;
  return {
    slot: job.slot,
    model: job.productModel,
    code: job.productCode || '待生成',
    verdict: job.verdict,
    isolation: job.isolation,
    date: previewDate(job.productionDate),
    noise: labelNoiseText(job) || '噪声待采集',
  };
}

function messageTone(message: string): string {
  return /失败|异常|未|离线|无效|错误|超时/.test(message) ? 'is-error' : 'is-success';
}

function LabelPreview({ data }: { data: PreviewData }) {
  const resultTone = data.isolation ? 'is-fail' : data.verdict.includes('B') ? 'is-b' : 'is-pass';
  return <article className={`label-preview-paper ${resultTone}`} aria-label={`D${data.slot} 标签预览`}>
    <div className="label-preview-paper-topline">
      <span>LGSK / TRACE</span>
      <strong>D{data.slot}</strong>
    </div>
    <div className="label-preview-name">火焰探测器</div>
    <div className="label-preview-model">型号 {data.model}</div>
    <div className="label-preview-main">
      <div className="label-preview-qr" aria-hidden="true">
        <QrCode size={42} strokeWidth={1.8} />
        <small>QR</small>
      </div>
      <div className="label-preview-detail">
        <span>检测结果</span>
        <b>{data.isolation ? 'NG 隔离' : data.verdict}</b>
        <small>{data.date}</small>
        <em>{data.isolation ? '请隔离处理' : '扫码追溯'}</em>
      </div>
    </div>
    <div className="label-preview-footer">
      <b>编号 {data.code}</b>
      <span>{data.noise}</span>
    </div>
  </article>;
}

export function LabelPrinterPanel({ backendHttpUrl }: Props) {
  const state = useSyncExternalStore(labelPrinterRuntime.subscribe, labelPrinterRuntime.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [mesStatus, setMESStatus] = useState<MESStatusView | null>(null);
  const [mesBusy, setMESBusy] = useState(false);

  useEffect(() => {
    labelPrinterRuntime.start(backendHttpUrl);
  }, [backendHttpUrl]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${backendHttpUrl}/api/production-config`)
      .then(async (response) => {
        const payload = await response.json() as { mes?: MESStatusView };
        if (!response.ok) throw new Error('MES 配置读取失败');
        if (!cancelled) setMESStatus(payload.mes ?? null);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [backendHttpUrl]);

  const toggleMES = async (enabled: boolean) => {
    setMESBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/production-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mesConfig: { enabled } }),
      });
      const payload = await response.json() as { success?: boolean; mes?: MESStatusView; error?: string; code?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || payload.code || 'MES 配置保存失败');
      setMESStatus(payload.mes ?? null);
      setMessage(enabled ? '已开启 MES 自动上传' : '已关闭 MES 自动上传');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMESBusy(false);
    }
  };

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const recent = state.jobs.slice(0, 18);
  const usbPrinters = state.printers.filter((printer) => printer.connectionType === 'usb');
  const wifiPrinters = state.printers.filter((printer) => printer.connectionType === 'wifi');
  const isWifi = state.config.connectionType === 'wifi';
  const selectedWifi = wifiPrinters.find((printer) => printer.name === state.config.wifiPrinterName && printer.port === state.config.wifiPort);
  const selectedWifiKey = selectedWifi ? `${selectedWifi.name}:${selectedWifi.port}` : '';
  const previewItems = [previewData(recent[0], 0), previewData(recent[1], 1)];
  const mesWarning = Boolean(mesStatus?.enabled && !mesStatus.apiKeyConfigured);

  return <section className="label-printer-panel">
    <header className="label-printer-header">
      <div className="label-printer-heading">
        <div className="label-printer-icon"><Printer size={20} /></div>
        <div>
          <span className="label-printer-kicker">PRINT BAY / 追溯输出</span>
          <h2>产品标签自动打印</h2>
          <p>检测完成后按 D1 → D6 顺序出纸，默认使用双列图片标签纸。</p>
        </div>
      </div>
      <div className="label-printer-header-actions">
        <div className={`printer-health ${healthTone(state.health)}`}>
          <i />
          <b>{healthText(state.health)}</b>
          <small>{isWifi ? 'WiFi' : 'USB'}</small>
        </div>
        <label className="label-toggle" title="关闭时不自动打印；开启后只自动打印开启之后生成的标签">
          <input
            type="checkbox"
            checked={state.config.autoPrint}
            onChange={(event) => labelPrinterRuntime.updateConfig({ autoPrint: event.target.checked })}
          />
          <span className="label-toggle-track" aria-hidden="true"><i /></span>
          <span className="label-toggle-copy"><b>自动打印</b><small>仅处理新任务</small></span>
        </label>
        <label className={`label-toggle ${mesWarning ? 'is-warning' : ''}`} title={mesWarning ? '已勾选，但后端尚未配置 MES API Key' : '测试报告生成后，自动上传产品编号并关联报告附件'}>
          <input
            type="checkbox"
            checked={mesStatus?.enabled ?? false}
            disabled={mesBusy}
            onChange={(event) => void toggleMES(event.target.checked)}
          />
          <span className="label-toggle-track" aria-hidden="true"><i /></span>
          <span className="label-toggle-copy"><b>上传 MES</b><small>{mesStatus?.pendingJobs ? `待传 ${mesStatus.pendingJobs}` : '报告自动关联'}</small></span>
        </label>
      </div>
    </header>

    <div className="label-printer-body">
      <div className="label-printer-workspace">
        <section className="label-preview-card">
          <header className="label-card-heading">
            <div>
              <span className="label-card-kicker">TEMPLATE PREVIEW</span>
              <h3>双列标签预览</h3>
            </div>
            <span className="label-card-badge"><LayoutTemplate size={13} /> 2-UP</span>
          </header>

          <div className="label-preview-stage">
            <div className="label-preview-axis label-preview-axis-top"><span>0</span><span>30</span><span>60 mm</span></div>
            <div className="label-preview-row">
              {previewItems.map((item) => <LabelPreview key={item.slot} data={item} />)}
            </div>
            <div className="label-preview-centerline" aria-hidden="true"><span>双列分界</span></div>
            <div className="label-preview-axis label-preview-axis-bottom"><span>单张 30 × 20 mm</span><span>总画布 60 × 20 mm</span></div>
          </div>

          <div className="label-spec-strip">
            <div><Ruler size={15} /><span><small>单张标签</small><b>{LABEL_TEMPLATE.labelWidth} × {LABEL_TEMPLATE.labelHeight} mm</b></span></div>
            <div><ScanLine size={15} /><span><small>每行数量</small><b>{LABEL_TEMPLATE.columns} 张</b></span></div>
            <div><QrCode size={15} /><span><small>追溯内容</small><b>产品编号</b></span></div>
          </div>
          <p className="label-preview-note"><CheckCircle2 size={14} /> 预览按实际打印坐标缩放；二维码、编号、检测结果均保留在单张标签安全区内。</p>
        </section>

        <div className="label-printer-controls">
          <section className="label-control-card">
            <header className="label-card-heading">
              <div>
                <span className="label-card-kicker">DEVICE LINK</span>
                <h3>打印机连接</h3>
              </div>
              <span className={`label-inline-status ${healthTone(state.health)}`}>{healthText(state.health)}</span>
            </header>

            <div className="label-form-grid label-form-grid-connection">
              <label className="label-field">
                <span>连接方式</span>
                <select
                  value={state.config.connectionType}
                  disabled={busy || state.health === 'printing'}
                  onChange={(event) => {
                    const connectionType = event.target.value as PrinterConnectionType;
                    void run(
                      () => labelPrinterRuntime.changeConnectionType(connectionType),
                      `已切换为${connectionType === 'wifi' ? ' WiFi' : ' USB'}连接`,
                    );
                  }}
                >
                  <option value="usb">USB</option>
                  <option value="wifi">WiFi / 局域网</option>
                </select>
              </label>
              {!isWifi ? <label className="label-field">
                <span>USB 标签机</span>
                <select
                  value={state.config.printerName}
                  disabled={busy || state.health === 'printing'}
                  onChange={(event) => {
                    const name = event.target.value;
                    labelPrinterRuntime.updateConfig({ printerName: name });
                    if (name) void run(() => labelPrinterRuntime.connectUsbPrinter(name), 'USB 标签机已连接');
                  }}
                >
                  <option value="">选择 USB 标签机</option>
                  {usbPrinters.map((printer) => <option key={`${printer.name}:${printer.port}`} value={printer.name}>{printer.name}</option>)}
                </select>
              </label> : <label className="label-field">
                <span>WiFi 标签机</span>
                <select
                  value={selectedWifiKey}
                  disabled={busy || state.health === 'printing'}
                  onChange={(event) => {
                    const target = wifiPrinters.find((printer) => `${printer.name}:${printer.port}` === event.target.value);
                    if (!target) return;
                    labelPrinterRuntime.updateConfig({ wifiPrinterName: target.name, wifiPort: target.port || 0, wifiAddress: target.address || '' });
                  }}
                >
                  <option value="">请先扫描 WiFi 标签机</option>
                  {wifiPrinters.map((printer) => <option key={`${printer.name}:${printer.port}`} value={`${printer.name}:${printer.port}`}>{printer.name} · TCP {printer.port}</option>)}
                </select>
              </label>}
            </div>

            <div className="label-action-row">
              <button
                type="button"
                className="label-button label-button-secondary"
                disabled={busy || state.health === 'printing'}
                onClick={() => void run(() => labelPrinterRuntime.scanPrinters(), isWifi ? 'WiFi 扫描完成' : 'USB 扫描完成')}
              ><RefreshCw size={14} />扫描设备</button>
              {isWifi && <button
                type="button"
                className="label-button label-button-primary"
                disabled={busy || state.health === 'printing' || !selectedWifi}
                onClick={() => void run(
                  () => labelPrinterRuntime.connectWifiPrinter(selectedWifi!.name, selectedWifi!.port || 0),
                  'WiFi 标签机已连接',
                )}
              ><Wifi size={14} />连接 WiFi</button>}
            </div>

            {isWifi && <div className="label-connection-note">
              <Wifi size={14} />
              <span>{selectedWifi ? `${selectedWifi.name} · TCP ${selectedWifi.port}${selectedWifi.address ? ` · ${selectedWifi.address}` : ''}` : '扫描后从上方列表选择在线设备'}</span>
            </div>}
          </section>

          <section className="label-control-card">
            <header className="label-card-heading">
              <div>
                <span className="label-card-kicker">OUTPUT PROFILE</span>
                <h3>输出参数</h3>
              </div>
              <Settings2 size={16} />
            </header>
            <div className="label-form-grid label-form-grid-three">
              <label className="label-field">
                <span>纸张类型</span>
                <select value={state.config.labelType} onChange={(event) => labelPrinterRuntime.updateConfig({ labelType: Number(event.target.value) })}>
                  <option value={1}>间隙纸 · 30×20 × 2</option>
                  <option value={2}>黑标纸</option>
                  <option value={3}>连续纸</option>
                  <option value={4}>定孔纸</option>
                  <option value={5}>透明纸</option>
                  <option value={6}>标牌</option>
                  <option value={10}>黑标间隙纸</option>
                </select>
              </label>
              <label className="label-field">
                <span>浓度</span>
                <select value={state.config.density} onChange={(event) => labelPrinterRuntime.updateConfig({ density: Number(event.target.value) })}>
                  {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="label-field">
                <span>打印方式</span>
                <select value={state.config.printMode} onChange={(event) => labelPrinterRuntime.updateConfig({ printMode: Number(event.target.value) })}>
                  <option value={1}>热敏</option>
                  <option value={2}>热转印</option>
                </select>
              </label>
            </div>
            <div className="label-template-lock">
              <LayoutTemplate size={16} />
              <div><b>默认模板：双列生产追溯</b><span>每行 2 张 · 单张 30 × 20 mm · QR = 产品编号</span></div>
            </div>
          </section>

          <div className={`label-printer-notice ${healthTone(state.health)}`}>
            <i />
            <span>{state.detail}</span>
            {message && <b className={messageTone(message)}>{message}</b>}
          </div>
        </div>
      </div>

      <section className="label-queue-card">
        <header className="label-queue-heading">
          <div>
            <span className="label-card-kicker">QUEUE / PRINT HISTORY</span>
            <h3>标签任务</h3>
          </div>
          <span className="label-queue-sequence"><span />按 D1 → D6 顺序出纸 · 一行最多 2 张</span>
        </header>

        <div className="label-queue-summary">
          {[
            ['待打印', state.summary.waiting, 'wait'],
            ['打印中', state.summary.printing, 'printing'],
            ['已打印', state.summary.printed, 'printed'],
            ['失败', state.summary.failed, 'failed'],
            ['编号缺失', state.summary.blocked, 'blocked'],
          ].map(([label, value, tone]) => <div key={String(label)} className={`label-queue-stat is-${tone}`}><span>{label}</span><b>{String(value)}</b></div>)}
        </div>

        <div className="label-queue-table" role="table" aria-label="标签打印任务列表">
          <div className="label-queue-row label-queue-row-heading" role="row">
            <span>槽位</span><span>型号</span><span>产品编号</span><span>检测结果</span><span>打印状态</span><span>操作</span>
          </div>
          <div className="label-queue-scroll">
            {recent.length === 0 && <div className="label-queue-empty"><Printer size={19} /><span>暂无标签任务</span><small>完成一轮检测后，D1–D6 标签会自动进入队列。</small></div>}
            {recent.map((job) => {
              const status = jobStatus(job);
              const retryable = job.status === 'FAILED' || job.status === 'PRINTED';
              return <div key={job.id} className="label-queue-row" role="row">
                <div className="label-queue-slot"><b>D{job.slot}</b><small>{job.batchId.slice(-8)}</small></div>
                <span className="label-queue-model" title={job.productModel}>{job.productModel}</span>
                <span className={`label-queue-code ${job.productCode ? '' : 'is-missing'}`} title={job.productCode || shortError(job.lastError)}>{job.productCode || '等待编号'}</span>
                <strong className={job.isolation ? 'is-fail' : 'is-pass'}>{job.verdict}</strong>
                <span className={`label-queue-status is-${status.tone}`} title={shortError(job.lastError)}><i />{status.text}{job.lastError && <small>{shortError(job.lastError)}</small>}</span>
                {retryable ? <button
                  type="button"
                  className="label-retry-button"
                  disabled={busy || state.health === 'printing'}
                  onClick={() => void run(() => labelPrinterRuntime.retryJob(job.id), job.status === 'PRINTED' ? `D${job.slot} 已加入补打队列` : `D${job.slot} 已重新排队`)}
                ><RotateCcw size={12} />{job.status === 'PRINTED' ? '补打' : '重试'}</button> : <span className="label-queue-action-empty">—</span>}
              </div>;
            })}
          </div>
        </div>
      </section>
    </div>
  </section>;
}
