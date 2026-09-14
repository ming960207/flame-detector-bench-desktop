import './mes-status-live-runtime.css';

type MESConnectionState = 'DISABLED' | 'MISCONFIGURED' | 'ERROR' | 'PENDING' | 'READY' | 'HEALTHY' | 'UNAVAILABLE';

interface MESStatusPayload {
  enabled: boolean;
  apiKeyConfigured: boolean;
  operatorConfigured: boolean;
  operatorName: string;
  pendingJobs: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  connectionState: MESConnectionState;
  baseUrl?: string;
  timestamp: number;
}

const DESKTOP_RUNTIME = typeof window !== 'undefined' ? window.desktopRuntime : undefined;
const FIELD_DEV_HTTP = typeof window !== 'undefined' ? `http://${window.location.hostname}:3001` : 'http://127.0.0.1:3001';
const FIELD_DEV_PAGE = typeof window !== 'undefined' && !DESKTOP_RUNTIME && window.location.port === '3002';
const HTTP = DESKTOP_RUNTIME?.backendHttpUrl || (FIELD_DEV_PAGE ? FIELD_DEV_HTTP : import.meta.env.VITE_BACKEND_API_URL || FIELD_DEV_HTTP);
const POLL_INTERVAL_MS = 5_000;

function isFieldRuntimePage(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.VITE_RUNTIME_MODE === 'offline' || window.location.port === '3000') return false;
  if (import.meta.env.VITE_RUNTIME_MODE === 'test' || import.meta.env.MODE === 'test') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'test' || window.location.hash.includes('test')) return false;
  if (window.location.port === '3005' || window.location.port === '3305') return false;
  return true;
}

function formatTimestamp(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '暂无';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(value);
  }
}

function ensureBadge(): HTMLElement | null {
  const headerMeta = document.querySelector<HTMLElement>('.wutos-header__meta');
  if (!headerMeta) return null;

  const existing = headerMeta.querySelector<HTMLElement>('[data-mes-status-live]');
  if (existing) return existing;

  const badge = document.createElement('span');
  badge.dataset.mesStatusLive = '1';
  badge.className = 'wutos-mes-status is-loading';
  badge.tabIndex = 0;
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  badge.innerHTML = [
    '<i class="wutos-mes-status__dot" aria-hidden="true"></i>',
    '<b class="wutos-mes-status__label">MES 检查中</b>',
    '<span class="wutos-mes-status__detail" aria-label="MES连接状态详情">',
    '  <strong>MES 自动上传状态</strong>',
    '  <span data-mes-row="enabled"><em>已启用</em><b>-</b></span>',
    '  <span data-mes-row="apiKey"><em>API Key</em><b>-</b></span>',
    '  <span data-mes-row="operator"><em>经办人</em><b>-</b></span>',
    '  <span data-mes-row="pending"><em>待上传批次</em><b>-</b></span>',
    '  <span data-mes-row="success"><em>最近成功时间</em><b>-</b></span>',
    '  <span data-mes-row="error"><em>最近错误</em><b>-</b></span>',
    '</span>',
  ].join('');

  const connection = headerMeta.querySelector<HTMLElement>('.wutos-connection');
  if (connection) connection.insertAdjacentElement('afterend', badge);
  else headerMeta.prepend(badge);
  return badge;
}

function setRow(badge: HTMLElement, key: string, value: string): void {
  const cell = badge.querySelector<HTMLElement>(`[data-mes-row="${key}"] b`);
  if (cell) cell.textContent = value;
}

function renderUnavailable(message: string): void {
  const badge = ensureBadge();
  if (!badge) return;
  badge.className = 'wutos-mes-status is-offline';
  const label = badge.querySelector<HTMLElement>('.wutos-mes-status__label');
  if (label) label.textContent = 'MES 状态不可用';
  setRow(badge, 'enabled', '未知');
  setRow(badge, 'apiKey', '未知');
  setRow(badge, 'operator', '未知');
  setRow(badge, 'pending', '-');
  setRow(badge, 'success', '暂无');
  setRow(badge, 'error', message || 'MES状态接口不可达');
  badge.title = `MES状态接口不可用：${message || '未知错误'}`;
}

function renderStatus(status: MESStatusPayload): void {
  const badge = ensureBadge();
  if (!badge) return;

  const state = status.connectionState;
  const className = state === 'HEALTHY' || state === 'READY'
    ? 'is-ready'
    : state === 'PENDING'
      ? 'is-pending'
      : state === 'DISABLED'
        ? 'is-disabled'
        : 'is-error';
  const labelText = state === 'HEALTHY'
    ? 'MES 正常'
    : state === 'READY'
      ? 'MES 就绪'
      : state === 'PENDING'
        ? `MES 待上传 ${status.pendingJobs}`
        : state === 'DISABLED'
          ? 'MES 未启用'
          : state === 'MISCONFIGURED'
            ? 'MES 未配置'
            : 'MES 异常';

  badge.className = `wutos-mes-status ${className}`;
  const label = badge.querySelector<HTMLElement>('.wutos-mes-status__label');
  if (label) label.textContent = labelText;

  setRow(badge, 'enabled', status.enabled ? '是' : '否');
  setRow(badge, 'apiKey', status.apiKeyConfigured ? '已配置' : '未配置');
  setRow(badge, 'operator', status.operatorConfigured ? `已配置 · ${status.operatorName || '自动检测'}` : '未配置');
  setRow(badge, 'pending', String(status.pendingJobs));
  setRow(badge, 'success', formatTimestamp(status.lastSuccessAt));
  setRow(badge, 'error', status.lastError || '无');

  badge.title = [
    `MES：${labelText}`,
    `已启用：${status.enabled ? '是' : '否'}`,
    `API Key：${status.apiKeyConfigured ? '已配置' : '未配置'}`,
    `经办人：${status.operatorConfigured ? status.operatorName || '自动检测' : '未配置'}`,
    `待上传批次：${status.pendingJobs}`,
    `最近成功时间：${formatTimestamp(status.lastSuccessAt)}`,
    `最近错误：${status.lastError || '无'}`,
  ].join('\n');
}

async function refreshMESStatus(): Promise<void> {
  try {
    const response = await fetch(`${HTTP}/api/mes/status`, { cache: 'no-store' });
    const payload = await response.json() as MESStatusPayload & { error?: string; code?: string };
    if (!response.ok) throw new Error(payload.error || payload.code || `HTTP ${response.status}`);
    renderStatus(payload);
  } catch (error) {
    renderUnavailable(error instanceof Error ? error.message : String(error));
  }
}

function startMESStatusRuntime(): void {
  if (!isFieldRuntimePage()) return;

  const observer = new MutationObserver(() => {
    if (ensureBadge()) void refreshMESStatus();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const timer = window.setInterval(() => void refreshMESStatus(), POLL_INTERVAL_MS);
  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    window.clearInterval(timer);
  }, { once: true });

  void refreshMESStatus();
}

if (typeof window !== 'undefined') {
  startMESStatusRuntime();
}
