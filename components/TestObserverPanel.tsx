import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Archive, RefreshCw, Save, ShieldCheck, Wifi } from 'lucide-react';
import type {
  TestProgramConfigPayload,
  TestProgramObserverDiagnostics,
  TestProgramObserverRuntimeConfig,
} from '../server/src/test-program/test-program-plan-config';
import type {
  TestProgramSnapshot,
  TestProgramStageDefinition,
} from '../server/src/test-program/test-program-types';

interface Props {
  backendHttpUrl: string;
  backendWsUrl: string;
}

interface HealthPayload {
  status: 'ok' | 'degraded';
  mode: string;
  source: TestProgramSnapshot['source'];
  runtime: TestProgramObserverRuntimeConfig;
  diagnostics: TestProgramObserverDiagnostics;
  timestamp: number;
}

interface ArchiveItem {
  runId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  verdict: string | null;
  grade: string | null;
  stageCount: number;
  completedStageCount: number;
  waveformSampleCount: number;
  detectorObservationCount: number;
  relayEventCount: number;
  archivedAt: number;
}

const colors = {
  panel: '#061b28',
  panel2: '#04131f',
  field: '#061722',
  border: '#23576a',
  cyan: '#43dced',
  text: '#ccecf5',
  title: '#f0fcff',
  muted: '#7fa9b4',
  pass: '#62e7b6',
  warn: '#e2c363',
  fail: '#f27769',
};

const inputStyle = {
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box' as const,
  border: `1px solid ${colors.border}`,
  background: colors.field,
  color: colors.text,
  padding: '7px 8px',
  fontSize: 11,
  outline: 'none',
};

function dateTime(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function duration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${(value / 1000).toFixed(2)} s`;
}

function verdictText(value: string | null | undefined): string {
  if (value === 'PASS') return '合格';
  if (value === 'FAIL') return '不合格';
  if (value === 'PENDING') return '待判定';
  return value || '未判定';
}

function channelText(value: TestProgramObserverDiagnostics['activeChannel'] | undefined): string {
  if (value === 'WEBSOCKET_AND_POLL') return 'WebSocket 实时 + HTTP 校验';
  if (value === 'WEBSOCKET_PRIMARY') return 'WebSocket 实时监听';
  if (value === 'HTTP_POLL_FALLBACK') return 'HTTP 轮询兜底';
  return '监听断开';
}

function healthTone(health: HealthPayload | null): string {
  if (health?.status === 'ok') return colors.pass;
  if (health?.diagnostics?.sourceConnected) return colors.warn;
  return colors.fail;
}

function stageSamples(snapshot: TestProgramSnapshot | null): number {
  return snapshot?.currentRun?.stages.reduce(
    (total, stage) => total + stage.waveforms.reduce((sum, waveform) => sum + waveform.sampleCount, 0),
    0,
  ) ?? 0;
}

function detectorObservations(snapshot: TestProgramSnapshot | null): number {
  return snapshot?.currentRun?.stages.reduce(
    (total, stage) => total + stage.detectors.reduce((sum, detector) => sum + detector.observationCount, 0),
    0,
  ) ?? 0;
}

export function TestObserverPanel({ backendHttpUrl, backendWsUrl }: Props) {
  const [snapshot, setSnapshot] = useState<TestProgramSnapshot | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [config, setConfig] = useState<TestProgramConfigPayload | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<TestProgramObserverRuntimeConfig | null>(null);
  const [planDraft, setPlanDraft] = useState<TestProgramStageDefinition[]>([]);
  const [archives, setArchives] = useState<ArchiveItem[]>([]);
  const [uiWsConnected, setUiWsConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [healthResponse, snapshotResponse, configResponse, archivesResponse] = await Promise.all([
      fetch(`${backendHttpUrl}/api/test-program/health`),
      fetch(`${backendHttpUrl}/api/test-program/snapshot`),
      fetch(`${backendHttpUrl}/api/test-program/config`),
      fetch(`${backendHttpUrl}/api/test-program/archives?limit=8`),
    ]);
    if (!healthResponse.ok || !snapshotResponse.ok || !configResponse.ok || !archivesResponse.ok) {
      throw new Error('测试监听程序状态读取失败');
    }
    const [nextHealth, nextSnapshot, nextConfig, archivePayload] = await Promise.all([
      healthResponse.json() as Promise<HealthPayload>,
      snapshotResponse.json() as Promise<TestProgramSnapshot>,
      configResponse.json() as Promise<TestProgramConfigPayload>,
      archivesResponse.json() as Promise<{ items?: ArchiveItem[] }>,
    ]);
    setHealth(nextHealth);
    setSnapshot(nextSnapshot);
    setConfig(nextConfig);
    setRuntimeDraft(nextConfig.runtime);
    setPlanDraft(nextConfig.plan);
    setArchives(archivePayload.items ?? []);
  }, [backendHttpUrl]);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch(`${backendHttpUrl}/api/test-program/health`);
      if (response.ok) setHealth(await response.json() as HealthPayload);
    } catch { /* keep last known health */ }
  }, [backendHttpUrl]);

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => void refreshHealth(), 2_000);
    return () => window.clearInterval(timer);
  }, [load, refreshHealth]);

  useEffect(() => {
    let disposed = false;
    let reconnect: number | null = null;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (disposed) return;
      try {
        socket = new WebSocket(backendWsUrl);
      } catch {
        reconnect = window.setTimeout(connect, 1_500);
        return;
      }
      socket.onopen = () => setUiWsConnected(true);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; payload?: unknown };
          if (message.type === 'test_snapshot') setSnapshot(message.payload as TestProgramSnapshot);
          if (message.type === 'test_source_error') {
            const error = (message.payload as { error?: string } | undefined)?.error;
            if (error) setMessage(`监听源异常：${error}`);
          }
        } catch { /* ignore unrelated/invalid message */ }
      };
      socket.onerror = () => setUiWsConnected(false);
      socket.onclose = () => {
        setUiWsConnected(false);
        if (!disposed) reconnect = window.setTimeout(connect, 1_500);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnect !== null) window.clearTimeout(reconnect);
      socket?.close();
    };
  }, [backendWsUrl]);

  const save = async () => {
    if (!runtimeDraft || planDraft.length === 0) return;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${backendHttpUrl}/api/test-program/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: runtimeDraft, plan: planDraft }),
      });
      const payload = await response.json() as TestProgramConfigPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || '测试监听配置保存失败');
      setConfig(payload);
      setRuntimeDraft(payload.runtime);
      setPlanDraft(payload.plan);
      setHealth((current) => current ? { ...current, runtime: payload.runtime, diagnostics: payload.diagnostics } : current);
      setMessage('监听配置已保存并立即生效；工序规划从下一轮归档开始使用。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const run = snapshot?.currentRun ?? null;
  const units = snapshot?.lastDetectorState?.units ?? [];
  const sampleCount = stageSamples(snapshot);
  const observationCount = detectorObservations(snapshot);
  const runtime = runtimeDraft;
  const diagnostics = health?.diagnostics ?? config?.diagnostics;
  const healthy = health?.status === 'ok';
  const summaryCards = useMemo(() => [
    ['监听状态', healthy ? '在线' : diagnostics?.sourceConnected ? '降级运行' : '离线', healthTone(health)],
    ['数据通道', channelText(diagnostics?.activeChannel), diagnostics?.sourceConnected ? colors.cyan : colors.fail],
    ['当前批次', run?.runId ?? '待机', colors.text],
    ['当前阶段', run?.stages?.at(-1)?.label ?? snapshot?.lastProcess?.processLabel ?? '待机', colors.text],
    ['波形样本', String(sampleCount), colors.text],
    ['探测器观测', String(observationCount), colors.text],
  ], [diagnostics, health, healthy, observationCount, run, sampleCount, snapshot]);

  return <div style={{ display: 'grid', gap: 14, color: colors.text }}>
    <section style={{ border: `1px solid ${colors.border}`, background: `linear-gradient(180deg, ${colors.panel}, ${colors.panel2})` }}>
      <header style={{ padding: '11px 13px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={17} color={colors.cyan} />
          <strong style={{ color: colors.title }}>测试监听程序 · 嵌入式只读观察器</strong>
          <span style={{ color: healthTone(health), fontSize: 11 }}>{healthy ? '健康' : diagnostics?.sourceConnected ? '降级' : '断开'}</span>
        </div>
        <button type="button" onClick={() => void load().catch((error) => setMessage(String(error)))} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', display: 'inline-flex', gap: 5, alignItems: 'center' }}><RefreshCw size={13} />刷新</button>
      </header>

      <div style={{ padding: 13, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 7 }}>
          {summaryCards.map(([label, value, color]) => <div key={String(label)} style={{ border: `1px solid ${colors.border}`, background: colors.field, padding: '8px 9px', minWidth: 0 }}>
            <div style={{ color: colors.muted, fontSize: 9.5 }}>{label}</div>
            <strong title={String(value)} style={{ display: 'block', marginTop: 3, color: String(color), fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(value)}</strong>
          </div>)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(4, 1fr)', gap: 8, border: `1px solid ${colors.border}`, background: '#04131f', padding: '9px 10px', fontSize: 10.5 }}>
          <div><span style={{ color: colors.muted }}>正式状态源</span><strong style={{ display: 'block', marginTop: 3 }}>{snapshot?.source.formalBackendUrl ?? config?.source ?? '-'}</strong></div>
          <div><span style={{ color: colors.muted }}>服务内 WS</span><strong style={{ display: 'block', marginTop: 3, color: diagnostics?.wsConnected ? colors.pass : colors.warn }}>{diagnostics?.wsConnected ? '已连接' : '未连接'}</strong></div>
          <div><span style={{ color: colors.muted }}>HTTP 兜底</span><strong style={{ display: 'block', marginTop: 3, color: diagnostics?.pollConnected ? colors.pass : colors.warn }}>{diagnostics?.pollConnected ? '正常' : '未就绪'}</strong></div>
          <div><span style={{ color: colors.muted }}>最近活动</span><strong style={{ display: 'block', marginTop: 3 }}>{dateTime(diagnostics?.lastActivityAt)}</strong></div>
          <div><span style={{ color: colors.muted }}>详情页通道</span><strong style={{ display: 'block', marginTop: 3, color: uiWsConnected ? colors.pass : colors.warn }}>{uiWsConnected ? '实时' : '重连中'}</strong></div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', border: `1px solid ${colors.border}`, background: '#05202b', padding: '8px 10px', fontSize: 10.5 }}>
          <ShieldCheck size={14} color={colors.pass} />
          <strong style={{ color: colors.pass }}>硬隔离：</strong>
          <span>监听器不创建 PLC/Modbus 连接、不写 PLC、不控制探测器；仅消费正式 FieldRuntime 已发布的状态和波形。</span>
        </div>
        {(snapshot?.source.lastError || message) && <div style={{ border: `1px solid ${colors.warn}`, background: '#241f10', color: colors.warn, padding: '8px 10px', fontSize: 10.5 }}>{message || snapshot?.source.lastError}</div>}
      </div>
    </section>

    <section style={{ border: `1px solid ${colors.border}`, background: colors.panel2 }}>
      <header style={{ padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div><strong style={{ color: colors.title }}>实时监听数据</strong><div style={{ color: colors.muted, fontSize: 10, marginTop: 3 }}>当前工序、6 台探测器最新值与本轮监听累计量。</div></div>
        <span style={{ color: colors.muted, fontSize: 10 }}>最后快照 {dateTime(snapshot?.updatedAt)}</span>
      </header>
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 7 }}>
          {[
            ['运行状态', run?.status ?? 'IDLE'],
            ['本轮耗时', duration(run ? (run.durationMs ?? (Date.now() - run.startedAt)) : null)],
            ['阶段记录', String(run?.stages.length ?? 0)],
            ['继电器事件', String(run?.relayEvents.length ?? 0)],
            ['当前判定', verdictText(run?.decision.verdict ?? snapshot?.lastSummary?.finalVerdict?.verdict as string | undefined)],
          ].map(([label, value]) => <div key={label} style={{ border: `1px solid ${colors.border}`, background: colors.field, padding: '7px 9px' }}><span style={{ color: colors.muted, fontSize: 9.5 }}>{label}</span><strong style={{ display: 'block', marginTop: 2 }}>{value}</strong></div>)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0,1fr))', gap: 7 }}>
          {Array.from({ length: 6 }, (_, offset) => {
            const index = offset + 1;
            const unit = units.find((item) => item.index === index);
            return <div key={index} style={{ border: `1px solid ${colors.border}`, background: colors.field, padding: '8px 9px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 5 }}><strong style={{ color: colors.title }}>D{index}</strong><span style={{ color: unit?.online ? colors.pass : colors.fail, fontSize: 10 }}>{unit?.online ? 'ONLINE' : 'OFFLINE'}</span></div>
              <div style={{ marginTop: 6, fontFamily: 'Consolas, monospace', fontSize: 9.5, lineHeight: 1.55, color: colors.muted }}>
                <div>P1 {unit?.probe1 ?? '-'}</div><div>P2 {unit?.probe2 ?? '-'}</div><div>P3 {unit?.probe3 ?? '-'}</div><div>P4 {unit?.probe4 ?? '-'}</div>
              </div>
              {(unit?.fire || unit?.fault) && <div style={{ marginTop: 4, color: colors.fail, fontSize: 9.5 }}>{unit.fire ? '火警 ' : ''}{unit.fault ? '故障' : ''}</div>}
            </div>;
          })}
        </div>
      </div>
    </section>

    <section style={{ border: `1px solid ${colors.border}`, background: colors.panel2 }}>
      <header style={{ padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div><strong style={{ color: colors.title }}>监听与归档配置</strong><div style={{ color: colors.muted, fontSize: 10, marginTop: 3 }}>运行参数立即生效；阶段规划只影响测试观察器归档，不改变正式 PLC 工序。</div></div>
        <button type="button" disabled={saving || !runtime} onClick={() => void save()} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, color: colors.cyan }}><Save size={13} />{saving ? '保存中…' : '保存配置'}</button>
      </header>
      <div style={{ padding: 12, display: 'grid', gap: 12 }}>
        {runtime && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 }}>
          {[
            ['HTTP轮询(ms)', 'pollIntervalMs', 250, 10000],
            ['WS重连(ms)', 'reconnectIntervalMs', 250, 30000],
            ['完成收尾(ms)', 'completionFlushDelayMs', 50, 5000],
            ['失联判定(ms)', 'staleAfterMs', 1000, 120000],
          ].map(([label, key, min, max]) => <label key={String(key)} style={{ display: 'grid', gap: 5, color: colors.muted, fontSize: 10.5 }}>
            {label}
            <input type="number" min={Number(min)} max={Number(max)} value={runtime[key as keyof TestProgramObserverRuntimeConfig]} onChange={(event) => setRuntimeDraft((current) => current ? { ...current, [key]: Number(event.target.value) } : current)} style={inputStyle} />
          </label>)}
        </div>}

        <div style={{ border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 170px minmax(220px,1fr)', gap: 8, padding: '7px 9px', background: '#082537', color: colors.muted, fontSize: 9.5 }}><span>阶段</span><span>规划时长（秒）</span><span>依据</span></div>
          {planDraft.map((stage) => <div key={stage.id} style={{ display: 'grid', gridTemplateColumns: '180px 170px minmax(220px,1fr)', gap: 8, alignItems: 'center', padding: '6px 9px', borderTop: `1px solid ${colors.border}`, fontSize: 10.5 }}>
            <div><strong>{stage.label}</strong><small style={{ display: 'block', color: colors.muted }}>{stage.id}</small></div>
            <input
              type="number"
              min={0}
              step="0.1"
              placeholder="未配置"
              value={stage.plannedDurationMs === null ? '' : stage.plannedDurationMs / 1000}
              onChange={(event) => {
                const value = event.target.value.trim();
                setPlanDraft((current) => current.map((item) => item.id === stage.id
                  ? { ...item, plannedDurationMs: value === '' ? null : Math.max(0, Number(value) * 1000) }
                  : item));
              }}
              style={inputStyle}
            />
            <span style={{ color: colors.muted }}>{stage.planBasis || '观察器本地规划 / 仅统计'}</span>
          </div>)}
        </div>
      </div>
    </section>

    <section style={{ border: `1px solid ${colors.border}`, background: colors.panel2 }}>
      <header style={{ padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 7 }}><Archive size={14} color={colors.cyan} /><strong style={{ color: colors.title }}>最近测试监听归档</strong></header>
      <div style={{ padding: 10, display: 'grid', gap: 6 }}>
        {archives.length === 0 && <div style={{ color: colors.muted, fontSize: 10.5, padding: 8 }}>暂无监听归档；正式自动工序完成后会自动生成。</div>}
        {archives.map((item) => <div key={item.runId} style={{ display: 'grid', gridTemplateColumns: 'minmax(190px,1.4fr) 90px 90px 110px 110px 170px', gap: 8, border: `1px solid ${colors.border}`, background: colors.field, padding: '7px 9px', alignItems: 'center', fontSize: 10 }}>
          <strong title={item.runId} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.runId}</strong>
          <span>{item.status}</span><span style={{ color: item.verdict === 'PASS' ? colors.pass : item.verdict === 'FAIL' ? colors.fail : colors.warn }}>{verdictText(item.verdict)}</span>
          <span>样本 {item.waveformSampleCount}</span><span>观测 {item.detectorObservationCount}</span><span>{dateTime(item.archivedAt)}</span>
        </div>)}
      </div>
    </section>

    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: colors.muted, fontSize: 10 }}><Wifi size={13} />配置来源：{config?.planSource ?? '-'} · PLC参考更新时间：{dateTime(config?.plcConfigUpdatedAt)} · 监听器与主程序使用同一统一后端生命周期。</div>
  </div>;
}
