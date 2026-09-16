import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Github, Info, LoaderCircle, RefreshCw, RotateCcw, UploadCloud, X } from 'lucide-react';
import './software-release.css';

interface SoftwareVersionSnapshot {
  available: boolean;
  repository: string;
  branch: string;
  packageVersion: string;
  current: {
    commit: string | null;
    shortCommit: string | null;
    commitDate: string | null;
    builtAt: string | null;
    operation: string | null;
  };
  latest: { commit: string; shortCommit: string } | null;
  updateAvailable: boolean;
  rollback: {
    available: boolean;
    targetCommit: string | null;
    shortTargetCommit: string | null;
    recordedAt: string | null;
    status: string | null;
  };
  capabilities: { update: boolean; rollback: boolean; logSubmit: boolean };
  message?: string;
}

interface SoftwareActionResponse {
  accepted?: boolean;
  message?: string;
  error?: string;
  output?: string;
}

export interface SoftwareReleasePanelProps {
  backendHttpUrl: string;
  onClose: () => void;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '未记录';
  const parsed = new Date(value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false });
}

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : '未获取';
}

export function SoftwareReleasePanel({ backendHttpUrl, onClose }: SoftwareReleasePanelProps) {
  const [snapshot, setSnapshot] = useState<SoftwareVersionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('正在读取版本信息…');
  const [issueReference, setIssueReference] = useState('');
  const [issueNote, setIssueNote] = useState('');

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${backendHttpUrl}/api/software/version`, { cache: 'no-store' });
      const payload = await response.json() as SoftwareVersionSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || `版本信息读取失败 (${response.status})`);
      setSnapshot(payload);
      setNotice(payload.latest ? '版本信息已同步 GitHub' : '当前无法读取 GitHub 最新版本');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '版本信息读取失败');
    } finally {
      setLoading(false);
    }
  }, [backendHttpUrl]);

  useEffect(() => { void loadSnapshot(); }, [loadSnapshot]);

  const runAction = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    setNotice('正在执行操作，请不要关闭程序…');
    try {
      const response = await fetch(`${backendHttpUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as SoftwareActionResponse;
      if (!response.ok) throw new Error(payload.error || `操作失败 (${response.status})`);
      setNotice(payload.message || '操作已接受');
      if (payload.output) setNotice(`${payload.message || '操作完成'}\n${payload.output}`);
      if (path.endsWith('/logs/submit')) await loadSnapshot();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const update = () => {
    if (!snapshot?.updateAvailable) return;
    if (!window.confirm(`确认更新到 GitHub 最新版本 ${snapshot.latest?.shortCommit ?? ''}？更新会停止当前运行服务并重新构建程序。`)) return;
    void runAction('/api/software/update');
  };

  const rollback = () => {
    if (!snapshot?.rollback.available) return;
    if (!window.confirm(`确认回退到 ${snapshot.rollback.shortTargetCommit ?? '记录版本'}？回退会替换当前源码并重新构建程序。`)) return;
    void runAction('/api/software/rollback', { commit: snapshot.rollback.targetCommit });
  };

  const submitLogs = () => {
    if (!window.confirm('确认提交当前诊断日志？问题编号和描述会写入本次 GitHub 日志包清单。')) return;
    void runAction('/api/software/logs/submit', { issueReference, issueNote });
  };

  return (
    <div className="software-release-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="software-release-panel" role="dialog" aria-modal="true" aria-labelledby="software-release-title">
        <header className="software-release-panel__header">
          <div>
            <span className="section-kicker"><Info /> SOFTWARE / RELEASE CONTROL</span>
            <h2 id="software-release-title">关于与版本管理</h2>
            <p>查询 GitHub 唯一提交版本、构建时间，并在确认后执行更新、日志提交或版本回退。</p>
          </div>
          <button type="button" className="software-release-panel__close" onClick={onClose} aria-label="关闭版本管理"><X /></button>
        </header>

        <div className="software-release-panel__body">
          <section className="software-release-version-card">
            <div className="software-release-card-title"><div><span>当前安装版本</span><strong>{snapshot?.current.shortCommit ?? '读取中…'}</strong></div><span className="software-release-badge">{snapshot?.branch ?? 'branch'}</span></div>
            <div className="software-release-facts">
              <span><b>程序版本</b><em>v{snapshot?.packageVersion ?? '—'}</em></span>
              <span><b>GitHub 唯一值</b><em>{snapshot?.current.commit ?? '—'}</em></span>
              <span><b>提交时间</b><em>{formatTime(snapshot?.current.commitDate)}</em></span>
              <span><b>构建时间</b><em>{snapshot?.current.builtAt ? formatTime(snapshot.current.builtAt) : '开发运行时'}</em></span>
            </div>
          </section>

          <section className={`software-release-latest-card ${snapshot?.updateAvailable ? 'is-update' : ''}`}>
            <div className="software-release-card-title"><div><span>GitHub 最新程序</span><strong>{snapshot?.latest?.shortCommit ?? '未获取'}</strong></div><button type="button" onClick={() => void loadSnapshot()} disabled={loading || busy} aria-label="刷新版本信息"><RefreshCw className={loading ? 'is-spinning' : ''} /></button></div>
            <p>{snapshot?.latest ? `远端提交：${snapshot.latest.commit}` : '请检查网络连接或 GitHub 访问权限。'}</p>
            <div className="software-release-latest-state">{snapshot?.updateAvailable ? <><AlertTriangle />发现新版本，可执行更新</> : snapshot?.latest ? <><CheckCircle2 />当前已是 GitHub 最新版本</> : <><AlertTriangle />暂时无法比较版本</>}</div>
          </section>

          <section className="software-release-actions-card">
            <div className="software-release-card-title"><div><span>程序操作</span><strong>需确认后执行</strong></div><Github /></div>
            <div className="software-release-actions">
              <button type="button" className="is-primary" onClick={update} disabled={busy || loading || !snapshot?.capabilities.update || !snapshot?.updateAvailable}><RefreshCw />一键更新程序</button>
              <button type="button" onClick={rollback} disabled={busy || loading || !snapshot?.rollback.available}><RotateCcw />版本回退</button>
              <a href={`${snapshot?.repository ?? 'https://github.com/ming960207/flame-detector-bench-desktop'}/commits/${snapshot?.branch ?? 'refactor/unified-backend'}`} target="_blank" rel="noreferrer"><ExternalLink />查看 GitHub 提交</a>
            </div>
            <small>更新/回退完成后，浏览器开发模式请重新运行 `start-all.bat`；桌面模式按脚本提示自动重启。</small>
          </section>

          <section className="software-release-logs-card">
            <div className="software-release-card-title"><div><span>诊断日志</span><strong>可关联 GitHub 问题</strong></div><UploadCloud /></div>
            <div className="software-release-log-form">
              <label>问题编号或链接<input value={issueReference} onChange={(event) => setIssueReference(event.target.value)} placeholder="如 #123 或 GitHub Issue URL" maxLength={200} /></label>
              <label>问题说明<textarea value={issueNote} onChange={(event) => setIssueNote(event.target.value)} placeholder="填写现场现象、复现步骤或关联说明" maxLength={1000} rows={3} /></label>
            </div>
            <button type="button" className="is-primary software-release-submit" onClick={submitLogs} disabled={busy || !snapshot?.capabilities.logSubmit}><UploadCloud />提交当前诊断日志</button>
            <small>日志包会提交到 GitHub 的 `diagnostic-logs/`，并把关联问题写入 manifest。</small>
          </section>
        </div>

        <footer className="software-release-panel__footer"><span className={busy ? 'is-busy' : ''}>{busy && <LoaderCircle className="is-spinning" />}{notice}</span><span>{snapshot?.rollback.available ? `可回退版本：${snapshot.rollback.shortTargetCommit}` : '暂无可用回退点'}</span></footer>
      </section>
    </div>
  );
}
