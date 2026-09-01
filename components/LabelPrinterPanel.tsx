import { useEffect, useState, useSyncExternalStore } from 'react';
import { Printer, RefreshCw, RotateCcw } from 'lucide-react';
import { labelPrinterRuntime, type ProductLabelPrintJob } from './label-printer-runtime';

interface Props {
  backendHttpUrl: string;
}

const colors = {
  panel: '#061b28',
  panel2: '#071620',
  line: '#23576a',
  cyan: '#43dced',
  text: '#ccecf5',
  title: '#f0fcff',
  muted: '#7fa9b4',
  pass: '#62e7b6',
  warn: '#e2c363',
  fail: '#f27769',
};

const fieldStyle = {
  minWidth: 0,
  border: `1px solid ${colors.line}`,
  background: colors.panel2,
  color: colors.text,
  padding: '7px 8px',
  fontSize: 11,
  outline: 'none',
} as const;

function healthText(health: ReturnType<typeof labelPrinterRuntime.getSnapshot>['health']): string {
  if (health === 'ready') return '就绪';
  if (health === 'printing') return '打印中';
  if (health === 'service-offline') return '打印服务离线';
  if (health === 'printer-offline') return '打印机未连接';
  if (health === 'connecting') return '连接中';
  if (health === 'error') return '异常';
  return '待初始化';
}

function healthColor(health: ReturnType<typeof labelPrinterRuntime.getSnapshot>['health']): string {
  if (health === 'ready') return colors.pass;
  if (health === 'printing') return colors.cyan;
  if (health === 'connecting' || health === 'idle') return colors.warn;
  return colors.fail;
}

function jobStatus(job: ProductLabelPrintJob): { text: string; color: string } {
  if (job.status === 'WAITING') return { text: '待打印', color: colors.warn };
  if (job.status === 'PRINTING') return { text: '打印中', color: colors.cyan };
  if (job.status === 'PRINTED') return { text: job.reprintCount > 0 ? `已补打×${job.reprintCount}` : '已打印', color: colors.pass };
  if (job.status === 'BLOCKED') return { text: '编号未生成', color: colors.warn };
  return { text: '打印失败', color: colors.fail };
}

function shortError(value: string | null): string {
  if (!value) return '';
  if (value === 'PRODUCT_CODE_NOT_GENERATED') return '产品编号未生成';
  if (value === 'PRINT_LEASE_EXPIRED') return '上次打印任务超时，已重新排队';
  return value;
}

export function LabelPrinterPanel({ backendHttpUrl }: Props) {
  const state = useSyncExternalStore(labelPrinterRuntime.subscribe, labelPrinterRuntime.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    labelPrinterRuntime.start(backendHttpUrl);
  }, [backendHttpUrl]);

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

  return <section style={{
    marginTop: 14,
    border: `1px solid ${colors.line}`,
    background: `linear-gradient(180deg, ${colors.panel}, ${colors.panel2})`,
    color: colors.text,
  }}>
    <header style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      padding: '11px 13px',
      borderBottom: `1px solid ${colors.line}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Printer size={16} color={colors.cyan} />
        <strong style={{ color: colors.title, fontSize: 13 }}>产品标签自动打印</strong>
        <span style={{ fontSize: 11, color: healthColor(state.health) }}>{healthText(state.health)}</span>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: colors.text, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={state.config.autoPrint}
          onChange={(event) => labelPrinterRuntime.updateConfig({ autoPrint: event.target.checked })}
        />
        自动打印
      </label>
    </header>

    <div style={{ padding: 13, display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(210px, 1.6fr) auto repeat(3, minmax(90px, .55fr))', gap: 8, alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 5, fontSize: 10.5, color: colors.muted }}>
          标签机
          <select
            value={state.config.printerName}
            onChange={(event) => {
              const name = event.target.value;
              labelPrinterRuntime.updateConfig({ printerName: name });
              if (name) void run(() => labelPrinterRuntime.connectPrinter(name), '打印机已连接');
            }}
            style={{ ...fieldStyle, width: '100%' }}
          >
            <option value="">-- 选择 USB 标签机 --</option>
            {state.printers.map((printer) => <option key={`${printer.name}:${printer.port}`} value={printer.name}>{printer.name}</option>)}
          </select>
        </label>

        <button
          type="button"
          disabled={busy || state.health === 'printing'}
          onClick={() => void run(() => labelPrinterRuntime.scanPrinters(), '扫描完成')}
          style={{ ...fieldStyle, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, height: 31 }}
        >
          <RefreshCw size={13} />扫描
        </button>

        <label style={{ display: 'grid', gap: 5, fontSize: 10.5, color: colors.muted }}>
          浓度
          <select value={state.config.density} onChange={(event) => labelPrinterRuntime.updateConfig({ density: Number(event.target.value) })} style={fieldStyle}>
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 5, fontSize: 10.5, color: colors.muted }}>
          标签纸
          <select value={state.config.labelType} onChange={(event) => labelPrinterRuntime.updateConfig({ labelType: Number(event.target.value) })} style={fieldStyle}>
            <option value={1}>间隙纸</option><option value={2}>黑标纸</option><option value={3}>连续纸</option><option value={4}>定孔纸</option><option value={5}>透明纸</option><option value={6}>标牌</option><option value={10}>黑标间隙纸</option>
          </select>
        </label>

        <label style={{ display: 'grid', gap: 5, fontSize: 10.5, color: colors.muted }}>
          打印方式
          <select value={state.config.printMode} onChange={(event) => labelPrinterRuntime.updateConfig({ printMode: Number(event.target.value) })} style={fieldStyle}>
            <option value={1}>热敏</option><option value={2}>热转印</option>
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 22, padding: '7px 9px', background: '#04131f', border: `1px solid ${colors.line}`, fontSize: 10.5 }}>
        <span style={{ color: healthColor(state.health), fontWeight: 700 }}>{state.detail}</span>
        <span style={{ color: colors.muted }}>60×40 横版</span>
        <span style={{ color: colors.muted }}>QR=产品编号</span>
        <span style={{ color: colors.muted }}>D1→D6</span>
        <span style={{ color: colors.muted }}>1台/1张</span>
        {message && <span style={{ marginLeft: 'auto', color: message.includes('已') || message.includes('完成') ? colors.pass : colors.fail }}>{message}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 7 }}>
        {[
          ['待打印', state.summary.waiting, colors.warn],
          ['打印中', state.summary.printing, colors.cyan],
          ['已打印', state.summary.printed, colors.pass],
          ['失败', state.summary.failed, colors.fail],
          ['编号缺失', state.summary.blocked, colors.warn],
        ].map(([label, value, color]) => <div key={String(label)} style={{ border: `1px solid ${colors.line}`, background: '#051722', padding: '7px 9px' }}>
          <div style={{ color: colors.muted, fontSize: 9.5 }}>{label}</div>
          <strong style={{ display: 'block', marginTop: 2, color: String(color), fontSize: 16 }}>{String(value)}</strong>
        </div>)}
      </div>

      <div style={{ border: `1px solid ${colors.line}`, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '54px 132px minmax(165px,1fr) 94px 92px 74px', gap: 8, padding: '7px 9px', background: '#082537', color: colors.muted, fontSize: 9.5 }}>
          <span>槽位</span><span>型号</span><span>产品编号</span><span>结果</span><span>打印状态</span><span>操作</span>
        </div>
        <div style={{ maxHeight: 265, overflow: 'auto' }}>
          {recent.length === 0 && <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 11 }}>暂无标签任务</div>}
          {recent.map((job) => {
            const status = jobStatus(job);
            const retryable = job.status === 'FAILED' || job.status === 'PRINTED';
            return <div key={job.id} style={{
              display: 'grid',
              gridTemplateColumns: '54px 132px minmax(165px,1fr) 94px 92px 74px',
              gap: 8,
              alignItems: 'center',
              padding: '7px 9px',
              borderTop: `1px solid ${colors.line}`,
              fontSize: 10.5,
            }}>
              <strong style={{ color: colors.title }}>D{job.slot}</strong>
              <span>{job.productModel}</span>
              <span title={job.productCode || shortError(job.lastError)} style={{ fontFamily: 'Consolas, monospace', color: job.productCode ? colors.text : colors.warn, overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.productCode || '未生成'}</span>
              <strong style={{ color: job.isolation ? colors.fail : colors.text }}>{job.verdict}</strong>
              <span title={shortError(job.lastError)} style={{ color: status.color }}>{status.text}</span>
              {retryable ? <button
                type="button"
                disabled={busy || state.health === 'printing'}
                onClick={() => void run(() => labelPrinterRuntime.retryJob(job.id), job.status === 'PRINTED' ? `D${job.slot} 已加入补打队列` : `D${job.slot} 已重新排队`)}
                style={{ border: `1px solid ${colors.line}`, background: '#082537', color: colors.cyan, padding: '4px 6px', cursor: 'pointer', fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
              ><RotateCcw size={11} />{job.status === 'PRINTED' ? '补打' : '重试'}</button> : <span style={{ color: colors.muted }}>—</span>}
            </div>;
          })}
        </div>
      </div>
    </div>
  </section>;
}
