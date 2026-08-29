import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  FileCheck2,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  XCircle,
} from 'lucide-react';
import {
  CLOSURE_STAGES,
  canAdvanceOfflineStage,
  canStartOfflineCycle,
  canStopOfflineCycle,
  createClosureCommand,
  createPassSnapshots,
  hasCurrentCompletionAuditEvidence,
  isOfflineReportReady,
  shouldApplyClosureState,
  type ClosureCommandResult,
  type ClosureCommandType,
  type ClosureState,
  type ClosureAuditEvent,
  type DetectorSnapshot,
} from '../utils/closure-client';
import './offline-closure.css';

const DESKTOP_RUNTIME = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
const BACKEND_HTTP_URL = DESKTOP_RUNTIME?.backendHttpUrl || import.meta.env.VITE_BACKEND_API_URL || `http://${window.location.hostname}:3001`;
const BACKEND_WS_URL = DESKTOP_RUNTIME?.backendWsUrl || import.meta.env.VITE_BACKEND_WS_URL || `ws://${window.location.hostname}:3001`;

const initialState: ClosureState = {
  mode: 'offline', stateVersion: 0, nextCommandSequence: 1, safetyReady: false, running: false, completed: false, alarm: false,
  stage: 'IDLE', stageCode: 0, stepCode: 0, detectorBatch: 'unknown', reportGate: 'blocked',
};

export function OfflineClosureApp() {
  const [state, setState] = useState<ClosureState>(initialState);
  const [connected, setConnected] = useState(false);
  const [lastResult, setLastResult] = useState<ClosureCommandResult | null>(null);
  const [notice, setNotice] = useState('正在读取离线闭环状态…');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(1);
  const appliedStateVersion = useRef(initialState.stateVersion);

  const reportReady = isOfflineReportReady(state);
  const activeStageIndex = CLOSURE_STAGES.findIndex(({ stage }) => stage === state.stage);
  const detectorLabel = useMemo(() => ({
    pending: '待提交', valid: '6 / 6 有效', invalid: '批次无效', unknown: '未判定',
  }[state.detectorBatch]), [state.detectorBatch]);

  const applyState = useCallback((next: ClosureState) => {
    if (!shouldApplyClosureState(appliedStateVersion.current, next.stateVersion)) return;
    appliedStateVersion.current = next.stateVersion;
    sequence.current = Math.max(sequence.current, next.nextCommandSequence);
    setState(next);
    if (next.reasonCode) setNotice(next.reasonCode);
  }, []);

  const loadState = useCallback(async () => {
    const response = await fetch(`${BACKEND_HTTP_URL}/api/closure/state`);
    if (!response.ok) throw new Error(`状态读取失败 (${response.status})`);
    applyState(await response.json() as ClosureState);
  }, [applyState]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    void loadState().then(() => setNotice('离线闭环已连接；未连接 PLC、MQTT 或外部报告服务。')).catch((error) => {
      setNotice(error instanceof Error ? error.message : '无法读取离线服务');
    });

    const connect = () => {
      socket = new WebSocket(BACKEND_WS_URL);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type: string; payload: unknown };
        if (message.type === 'closure_state') applyState(message.payload as ClosureState);
        if (message.type === 'closure_command_result') {
          const result = message.payload as ClosureCommandResult;
          setLastResult(result);
          applyState(result.state);
          setNotice(result.reasonCode || `命令${result.status === 'accepted' ? '已接受' : result.status}`);
        }
        if (message.type === 'error') {
          const payload = message.payload as { code?: string; error?: string };
          setNotice(payload.code || payload.error || '服务端拒绝了请求');
        }
      };
      socket.onerror = () => setNotice('离线服务连接异常');
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) reconnectTimer = setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [applyState, loadState]);

  const post = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${BACKEND_HTTP_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as T & { code?: string };
    if (!response.ok) throw new Error(payload.code || `请求被拒绝 (${response.status})`);
    return payload;
  }, []);

  const submitCommand = useCallback(async (type: ClosureCommandType, batchId?: string, snapshots?: DetectorSnapshot[]) => {
    setBusy(true);
    try {
      const result = await post<ClosureCommandResult>('/api/closure/commands', createClosureCommand(
        type,
        sequence.current++,
        typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `ui-${Date.now()}-${sequence.current}`,
        Date.now(),
        batchId,
        snapshots,
      ));
      setLastResult(result);
      applyState(result.state);
      setNotice(result.reasonCode || `命令${result.status === 'accepted' ? '已接受' : result.status}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '命令发送失败');
    } finally {
      setBusy(false);
    }
  }, [applyState, post]);

  const setSafetyReady = useCallback(async (safetyReady: boolean) => {
    setBusy(true);
    try {
      applyState(await post<ClosureState>('/api/closure/test/safety', { safetyReady }));
      setNotice(safetyReady ? '已注入离线安全就绪状态' : '已注入安全失效；当前批次将安全中止');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '安全状态更新失败');
    } finally {
      setBusy(false);
    }
  }, [applyState, post]);

  const advanceStage = useCallback(async () => {
    setBusy(true);
    try {
      applyState(await post<ClosureState>('/api/closure/test/advance-stage'));
      setNotice('已由离线适配器确认推进一个阶段');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '阶段推进失败');
    } finally {
      setBusy(false);
    }
  }, [applyState, post]);

  const submitDetectorBatch = useCallback(async (invalid = false) => {
    if (!state.activeBatchId) {
      setNotice('没有活动批次，不能提交探测器快照');
      return;
    }
    const snapshots = createPassSnapshots(state.activeBatchId);
    if (invalid) snapshots[0] = { ...snapshots[0], verdict: 'UNKNOWN' };
    await submitCommand('SUBMIT_BATCH', state.activeBatchId, snapshots);
  }, [state.activeBatchId, submitCommand]);

  const downloadSimulationRecord = useCallback(async () => {
    if (!reportReady) return;
    if (!state.activeBatchId) {
      setNotice('当前报告缺少活动批次标识，不能导出。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${BACKEND_HTTP_URL}/api/closure/audit?batchId=${encodeURIComponent(state.activeBatchId)}&limit=1000`);
      if (!response.ok) throw new Error(`审计链读取失败 (${response.status})`);
      const payload = await response.json() as { integrity?: string; events?: ClosureAuditEvent[] };
      if (payload.integrity !== 'verified' || !Array.isArray(payload.events)) throw new Error('审计链完整性校验失败');
      if (!hasCurrentCompletionAuditEvidence(payload.events, state)) throw new Error('当前完成状态缺少审计证据，拒绝导出');

      const record = JSON.stringify({
        recordType: 'OFFLINE_SIMULATION',
        disclaimer: '仅证明上位机内部闭环；不代表 PLC、安全回路或现场设备已验证。',
        generatedAt: new Date().toISOString(),
        closureState: state,
        commandResult: lastResult,
        auditIntegrity: payload.integrity,
        auditEventCount: payload.events.length,
        auditEvents: payload.events,
      }, null, 2);
      const url = URL.createObjectURL(new Blob([record], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `offline-closure-${state.activeBatchId || 'record'}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice('已生成包含完整审计链的本地“离线仿真记录”；未执行上传。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '离线仿真记录生成失败');
    } finally {
      setBusy(false);
    }
  }, [lastResult, reportReady, state]);

  return (
    <main className="closure-console">
      <section className="closure-hero" aria-labelledby="closure-title">
        <div className="closure-hero__eyebrow"><FlaskConical size={16} aria-hidden="true" /> OFFLINE CONTROL ROOM / V1</div>
        <div className="closure-hero__content">
          <div>
            <h1 id="closure-title">火焰探测器<br /><em>四阶段闭环</em></h1>
            <p>上位机离线仿真 · EMC 后回初始位确认 · 六台探测器批次门禁 · 不接入物理 PLC</p>
          </div>
          <div className={`closure-link ${connected ? 'is-online' : ''}`}>
            <Wifi size={17} aria-hidden="true" />
            <span>{connected ? '本机服务已连接' : '等待本机服务'}</span>
          </div>
        </div>
        <div className="closure-rule" />
        <p className="closure-disclaimer"><AlertTriangle size={15} aria-hidden="true" /> 安全回路、PLC 输出与现场 FAT/SAT 均不在本次离线仿真范围内。</p>
      </section>

      <section className="closure-status-grid" aria-label="当前闭环状态">
        <StatusCard label="安全许可" value={state.safetyReady ? '已就绪' : '未就绪'} tone={state.safetyReady ? 'good' : 'danger'} icon={state.safetyReady ? ShieldCheck : ShieldAlert} />
        <StatusCard label="当前阶段" value={stageLabel(state.stage)} tone={state.running ? 'active' : state.completed ? 'good' : 'muted'} icon={state.completed ? CheckCircle2 : LoaderCircle} />
        <StatusCard label="探测器批次" value={detectorLabel} tone={state.detectorBatch === 'valid' ? 'good' : state.detectorBatch === 'invalid' ? 'danger' : 'muted'} icon={state.detectorBatch === 'valid' ? CheckCircle2 : XCircle} />
        <StatusCard label="报告门禁" value={reportReady ? '已放行' : '已阻止'} tone={reportReady ? 'good' : 'danger'} icon={reportReady ? FileCheck2 : CircleStop} />
      </section>

      <section className="closure-workspace">
        <article className="closure-panel closure-process" aria-labelledby="process-title">
          <div className="closure-panel__heading">
            <div><span>PROCESS TRACK</span><h2 id="process-title">工艺裁决轨道</h2></div>
            <button className="closure-icon-button" type="button" onClick={() => void loadState()} aria-label="刷新服务端状态"><RefreshCw size={17} /></button>
          </div>
          <ol className="closure-track">
            {CLOSURE_STAGES.map(({ stage, label, subtitle }, index) => {
              const isCurrent = state.stage === stage;
              const isDone = activeStageIndex > index || state.stage === 'COMPLETE';
              return <li key={stage} className={`${isCurrent ? 'is-current' : ''} ${isDone ? 'is-done' : ''}`}>
                <span className="closure-track__node">{isDone ? <CheckCircle2 size={15} /> : String(index + 1).padStart(2, '0')}</span>
                <div><strong>{label}</strong><small>{subtitle}</small></div>
                {index < CLOSURE_STAGES.length - 1 && <ChevronRight className="closure-track__arrow" size={18} aria-hidden="true" />}
              </li>;
            })}
          </ol>
          <div className="closure-stage-code"><span>PLC-compatible code</span><code>VW600 = {state.stageCode} · VW602 = {state.stepCode}</code></div>
        </article>

        <article className="closure-panel closure-actions" aria-labelledby="actions-title">
          <div className="closure-panel__heading"><div><span>COMMAND DESK</span><h2 id="actions-title">高层命令</h2></div><span className="closure-version">REV {state.stateVersion}</span></div>
          <div className="closure-actions__row">
            <button className="closure-button closure-button--primary" type="button" disabled={busy || !canStartOfflineCycle(state)} onClick={() => void submitCommand('START')}><Play size={17} /> 请求启动</button>
            <button className="closure-button closure-button--stop" type="button" disabled={busy || !canStopOfflineCycle(state)} onClick={() => void submitCommand('STOP', state.activeBatchId)}><CircleStop size={17} /> 原子停止</button>
            <button className="closure-button closure-button--quiet" type="button" disabled={busy} onClick={() => void submitCommand('RESET')}><RefreshCw size={16} /> 复位模型</button>
          </div>
          <div className="closure-safety-row">
            <span>离线安全输入</span>
            <button type="button" disabled={busy || state.safetyReady} onClick={() => void setSafetyReady(true)}>置为就绪</button>
            <button type="button" disabled={busy || !state.safetyReady} onClick={() => void setSafetyReady(false)}>模拟失效</button>
          </div>
          <button className="closure-advance" type="button" disabled={busy || !canAdvanceOfflineStage(state)} onClick={() => void advanceStage()}><ChevronRight size={18} /> 由离线适配器确认推进下一阶段</button>
          <p className="closure-command-note">界面不写 DO/Q 区，不以浏览器计时推进工艺；每次操作都由服务端状态机裁决。</p>
        </article>

        <article className="closure-panel closure-detectors" aria-labelledby="detectors-title">
          <div className="closure-panel__heading"><div><span>QUALITY GATE</span><h2 id="detectors-title">六台探测器批次</h2></div><span className={`closure-badge ${state.detectorBatch}`}>{detectorLabel}</span></div>
          <div className="closure-detector-grid">
            {Array.from({ length: 6 }, (_, index) => <div className={`closure-detector ${state.detectorBatch}`} key={index}><span>D{index + 1}</span><i aria-hidden="true" /> <small>{state.detectorBatch === 'valid' ? 'PASS' : 'AWAIT'}</small></div>)}
          </div>
          <p className="closure-batch-id">Batch / {state.activeBatchId || '— 无活动批次 —'}</p>
          <div className="closure-actions__row">
            <button className="closure-button closure-button--pass" type="button" disabled={busy || !state.activeBatchId || state.stage !== 'EMC'} onClick={() => void submitDetectorBatch(false)}><CheckCircle2 size={16} /> 注入 6×PASS</button>
            <button className="closure-button closure-button--quiet" type="button" disabled={busy || !state.activeBatchId || state.stage !== 'EMC'} onClick={() => void submitDetectorBatch(true)}><XCircle size={16} /> 注入 UNKNOWN</button>
          </div>
          <small className="closure-footnote">仅服务端确认地址、批次 ID、时间窗、通信状态、火警响应与 verdict 后，批次才可能有效。</small>
        </article>

        <article className={`closure-panel closure-report ${reportReady ? 'is-ready' : ''}`} aria-labelledby="report-title">
          <div className="closure-panel__heading"><div><span>RECORD GATE</span><h2 id="report-title">离线仿真记录</h2></div>{reportReady ? <FileCheck2 size={23} /> : <CircleStop size={23} />}</div>
          <p>{reportReady ? '四工艺阶段、回初始位确认及六台快照均已验证。可导出本地仿真记录。' : '保持关闭。完成四工艺阶段、确认回初始位并验证当前批次之前，不能生成“合格”记录。'}</p>
          <button className="closure-button closure-button--record" type="button" disabled={!reportReady || busy} onClick={() => void downloadSimulationRecord()}><FileCheck2 size={17} /> 导出离线仿真记录</button>
          <small>不自动上传，不调用外部报告服务。</small>
        </article>
      </section>

      <footer className="closure-notice" role="status"><span className={lastResult?.status === 'rejected' || lastResult?.reasonCode?.startsWith('DETECTOR_') || state.alarm ? 'is-danger' : ''} /> {notice}</footer>
    </main>
  );
}

function StatusCard({ label, value, tone, icon: Icon }: { label: string; value: string; tone: string; icon: typeof ShieldCheck }) {
  return <div className={`closure-status-card ${tone}`}><Icon size={19} aria-hidden="true" /><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function stageLabel(stage: ClosureState['stage']): string {
  return ({ IDLE: '待机', INIT: '初始化', HEAT: '移动热源', FLASH: '爆闪干扰', EMC: '电磁占位', RETURN_HOME: '回初始位', COMPLETE: '已完成', ABORTED: '已中止' })[stage];
}
