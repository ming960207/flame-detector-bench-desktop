export type LabelPrintJobStatus = 'WAITING' | 'PRINTING' | 'PRINTED' | 'FAILED' | 'BLOCKED';
export type PrinterConnectionType = 'usb' | 'wifi';

export interface ProductLabelPrintJob {
  id: string;
  batchId: string;
  slot: number;
  productName: '点型红外火焰探测器';
  productModel: string;
  productCode: string | null;
  qrContent: string | null;
  verdict: 'A类合格' | 'B类合格' | '不合格';
  isolation: boolean;
  productionDate: number;
  noiseValues: number[];
  status: LabelPrintJobStatus;
  attempts: number;
  reprintCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  printedAt: number | null;
}

export interface LabelPrintQueueSummary {
  waiting: number;
  printing: number;
  printed: number;
  failed: number;
  blocked: number;
  total: number;
}

export interface LabelPrinterDevice {
  connectionType: PrinterConnectionType;
  name: string;
  port?: number;
  address?: string;
}

export interface LocalLabelPrinterConfig {
  autoPrint: boolean;
  connectionType: PrinterConnectionType;
  printerName: string;
  printerPort: number;
  wifiAddress: string;
  wifiPrinterName: string;
  wifiPort: number;
  density: number;
  labelType: number;
  printMode: number;
}

export interface LabelPrinterRuntimeState {
  health: 'idle' | 'connecting' | 'service-offline' | 'printer-offline' | 'ready' | 'printing' | 'error';
  detail: string;
  printers: LabelPrinterDevice[];
  config: LocalLabelPrinterConfig;
  jobs: ProductLabelPrintJob[];
  summary: LabelPrintQueueSummary;
  currentJobId: string | null;
  lastPrintedJobId: string | null;
}

interface JcAck {
  apiName?: string;
  code?: number;
  info?: unknown;
  result?: unknown;
  resultAck?: {
    errorCode?: number;
    info?: unknown;
    printCopies?: number;
    result?: unknown;
    callback?: unknown;
    online?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: JcAck) => void;
  reject: (reason?: unknown) => void;
  timer: number;
}

const STORAGE_KEY = 'flame-detector-label-printer-config-v1';
const DEFAULT_CONFIG: LocalLabelPrinterConfig = {
  autoPrint: true,
  connectionType: 'usb',
  printerName: '',
  printerPort: 0,
  wifiAddress: '',
  wifiPrinterName: '',
  wifiPort: 0,
  density: 3,
  labelType: 1,
  printMode: 1,
};

function normalizeConnectionType(value: unknown): PrinterConnectionType {
  return value === 'wifi' ? 'wifi' : 'usb';
}

function loadConfig(): LocalLabelPrinterConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<LocalLabelPrinterConfig>;
    return {
      autoPrint: parsed.autoPrint !== false,
      connectionType: normalizeConnectionType(parsed.connectionType),
      printerName: typeof parsed.printerName === 'string' ? parsed.printerName : '',
      printerPort: Number.isFinite(Number(parsed.printerPort)) ? Number(parsed.printerPort) : 0,
      wifiAddress: typeof parsed.wifiAddress === 'string' ? parsed.wifiAddress : '',
      wifiPrinterName: typeof parsed.wifiPrinterName === 'string' ? parsed.wifiPrinterName : '',
      wifiPort: Number.isFinite(Number(parsed.wifiPort)) ? Number(parsed.wifiPort) : 0,
      density: Number.isFinite(Number(parsed.density)) ? Number(parsed.density) : 3,
      labelType: [1, 2, 3, 4, 5, 6, 10].includes(Number(parsed.labelType)) ? Number(parsed.labelType) : 1,
      printMode: [1, 2].includes(Number(parsed.printMode)) ? Number(parsed.printMode) : 1,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: LocalLabelPrinterConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* local storage is best effort */ }
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function unpackAckPayload(response: JcAck): unknown {
  let payload = response.resultAck?.info ?? response.resultAck?.result ?? response.info ?? response.result;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* keep text */ }
  }
  return payload;
}

function normalizeIpv4(value: string): string {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function isValidIpv4(value: string): boolean {
  const parts = normalizeIpv4(value).split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
}

function normalizeErrorCode(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    if (typeof parsed === 'string' && parsed.trim() !== '') {
      const parsedNumber = Number(parsed);
      return Number.isFinite(parsedNumber) ? parsedNumber : undefined;
    }
  } catch { /* keep plain text */ }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function ackResultIsSuccessful(response: JcAck): boolean {
  const code = normalizeErrorCode(response.resultAck?.errorCode ?? response.code);
  if (code !== undefined && code !== 0) return false;
  const result = response.resultAck?.result ?? response.result;
  return result !== false && String(result).toLowerCase() !== 'false';
}

function ackErrorMessage(response: JcAck, fallback: string): string {
  const info = response.resultAck?.info ?? response.info;
  const code = normalizeErrorCode(response.resultAck?.errorCode ?? response.code);
  const detail = typeof info === 'string' ? info : info == null ? '' : JSON.stringify(info);
  return detail || (code === undefined ? fallback : `${fallback}（错误码 ${code}）`);
}

export function normalizeWifiPrinterDevices(payload: unknown): LabelPrinterDevice[] {
  let source = payload;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    const resultAck = record.resultAck;
    if (resultAck && typeof resultAck === 'object') {
      source = (resultAck as Record<string, unknown>).info ?? (resultAck as Record<string, unknown>).result ?? [];
    } else {
      source = record.list ?? record.devices ?? record.printers ?? [];
    }
  }
  if (typeof source === 'string') {
    try { source = JSON.parse(source) as unknown; } catch { return []; }
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    source = record.list ?? record.devices ?? record.printers ?? [];
  }
  if (!Array.isArray(source)) return [];

  const devices: LabelPrinterDevice[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = String(row.deviceName ?? row.printerName ?? row.name ?? '').trim();
    const port = normalizePort(row.tcpPort ?? row.port);
    if (!name || port === 0) continue;
    const rawAddress = String(row.IP ?? row.ip ?? row.ipAddress ?? row.address ?? '').trim();
    const address = normalizeIpv4(rawAddress);
    const key = `${name}\u0000${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    devices.push({ connectionType: 'wifi', name, port, ...(isValidIpv4(address) ? { address } : {}) });
  }
  return devices;
}

class JingchenTransport {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private jobListeners = new Set<(message: JcAck) => void>();
  private statusListeners = new Set<(message: JcAck) => void>();
  private selectedPrinter: LabelPrinterDevice | null = null;
  private initialized = false;

  get serviceConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async decodeMessage(data: unknown): Promise<string> {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return await data.text();
    return String(data ?? '');
  }

  private handleMessage = async (event: MessageEvent) => {
    try {
      const text = await this.decodeMessage(event.data);
      const message = JSON.parse(text) as JcAck;
      const apiName = String(message.apiName || '');
      if (!apiName) return;
      const pendingApiName = this.pending.has(apiName)
        ? apiName
        : (apiName === 'selectPrinter' && this.pending.has('connectWifiPrinter') ? 'connectWifiPrinter' : apiName);
      const pending = this.pending.get(pendingApiName);
      if (pending) {
        const isCommitProgress = apiName === 'commitJob' && message.resultAck?.info !== 'commitJobApi Success!';
        if (!isCommitProgress) {
          window.clearTimeout(pending.timer);
          this.pending.delete(pendingApiName);
          const rawCode = message.resultAck?.errorCode ?? message.code;
          if (rawCode === undefined || Number(rawCode) === 0) pending.resolve(message);
          else pending.reject(new Error(String(message.resultAck?.info ?? message.info ?? `${apiName} failed (${rawCode})`)));
        }
      }
      if (apiName === 'commitJob') {
        for (const listener of this.jobListeners) {
          try { listener(message); } catch (error) { console.error('[标签打印] 任务监听器异常:', error); }
        }
      }
      const callback = message.resultAck?.callback;
      if (apiName === 'printStatus' || apiName === 'getPrinterHighLevelInfo' || callback !== undefined || message.resultAck?.online !== undefined) {
        for (const listener of this.statusListeners) {
          try { listener(message); } catch (error) { console.error('[标签打印] 状态监听器异常:', error); }
        }
      }
    } catch (error) {
      console.warn('[标签打印] 无法解析精臣打印服务消息:', error);
    }
  };

  private openPort(port: number, timeoutMs = 1500): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.binaryType = 'arraybuffer';
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error(`精臣打印服务端口 ${port} 连接超时`));
      }, timeoutMs);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.socket = socket;
        this.socket.onmessage = this.handleMessage;
        this.socket.onclose = () => {
          if (this.socket === socket) {
            this.socket = null;
            this.selectedPrinter = null;
            this.initialized = false;
            this.rejectPending(new Error('精臣打印服务连接已断开'));
          }
        };
        this.socket.onerror = () => undefined;
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error(`精臣打印服务端口 ${port} 不可用`));
      };
    });
  }

  async connect(): Promise<void> {
    if (this.serviceConnected) return;
    let lastError: unknown;
    for (const port of [37989, 37888]) {
      try {
        await this.openPort(port);
        console.info(`[标签打印] 已连接精臣打印服务 ws://127.0.0.1:${port}`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('未检测到精臣打印服务 jcPrinterSdk.exe');
  }

  private request(apiName: string, parameter?: unknown, timeoutMs = 10_000): Promise<JcAck> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('精臣打印服务未连接'));
    if (this.pending.has(apiName)) return Promise.reject(new Error(`${apiName} 请求仍在处理中`));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(apiName);
        reject(new Error(`${apiName} 响应超时`));
      }, timeoutMs);
      this.pending.set(apiName, { resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify(parameter === undefined ? { apiName } : { apiName, parameter }));
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(apiName);
        reject(error);
      }
    });
  }

  async initSdk(): Promise<void> {
    if (this.initialized) return;
    await this.request('initSdk', { fontDir: '' });
    this.initialized = true;
  }

  async listUsbPrinters(): Promise<LabelPrinterDevice[]> {
    const response = await this.request('getAllPrinters');
    const info = unpackAckPayload(response);
    const printers: LabelPrinterDevice[] = [];
    if (Array.isArray(info)) {
      info.forEach((item, index) => {
        if (typeof item === 'string') printers.push({ connectionType: 'usb', name: item, port: index });
        else if (item && typeof item === 'object') {
          const row = item as Record<string, unknown>;
          const name = String(row.printerName || row.deviceName || row.name || '').trim();
          if (name) printers.push({ connectionType: 'usb', name, port: Number(row.port) || index });
        }
      });
    } else if (info && typeof info === 'object') {
      Object.entries(info as Record<string, unknown>).forEach(([name, port]) => printers.push({ connectionType: 'usb', name, port: Number(port) || 0 }));
    }
    console.info(`[标签打印] USB扫描完成 count=${printers.length}`);
    return printers;
  }

  async listWifiPrinters(): Promise<LabelPrinterDevice[]> {
    let response: JcAck;
    try {
      response = await this.request('scanWifiPrinter', undefined, 25_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`当前精臣打印服务未能完成 WiFi 设备扫描：${detail}。请确认 jcPrinterSdk.exe 已启动且电脑与标签机在同一局域网。`);
    }
    if (!ackResultIsSuccessful(response)) throw new Error(ackErrorMessage(response, 'WiFi 扫描失败'));
    const printers = normalizeWifiPrinterDevices(response);
    console.info(`[标签打印] WiFi扫描完成 count=${printers.length} devices=${printers.map((item) => `${item.name}@${item.address}`).join(',') || '-'}`);
    return printers;
  }

  async selectUsbPrinter(name: string, port: number): Promise<void> {
    await this.request('selectPrinter', { printerName: name, port });
    this.selectedPrinter = { connectionType: 'usb', name, port };
    console.info(`[标签打印] USB标签机连接成功 name=${name} port=${port}`);
  }

  async selectWifiPrinter(nameValue: string, portValue: number, address = ''): Promise<void> {
    const name = nameValue.trim();
    const port = normalizePort(portValue);
    if (!name) throw new Error('WiFi 标签机名称不能为空');
    if (port === 0) throw new Error(`WiFi 标签机 TCP 端口无效：${portValue || '(空)'}`);
    try {
      const response = await this.request('connectWifiPrinter', { printerName: name, port }, 25_000);
      if (!ackResultIsSuccessful(response)) throw new Error(ackErrorMessage(response, 'WiFi 标签机连接失败'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`WiFi 标签机连接失败 ${name}:${port}：${detail}。请重新扫描后选择在线设备。`);
    }
    this.selectedPrinter = { connectionType: 'wifi', name, port, ...(isValidIpv4(address) ? { address: normalizeIpv4(address) } : {}) };
    console.info(`[标签打印] WiFi标签机连接成功 name=${name} port=${port}${address ? ` address=${address}` : ''}`);
  }

  addJobListener(listener: (message: JcAck) => void): void { this.jobListeners.add(listener); }
  removeJobListener(listener: (message: JcAck) => void): void { this.jobListeners.delete(listener); }
  addStatusListener(listener: (message: JcAck) => void): void { this.statusListeners.add(listener); }
  removeStatusListener(listener: (message: JcAck) => void): void { this.statusListeners.delete(listener); }

  async startJob(config: LocalLabelPrinterConfig): Promise<void> {
    await this.request('startJob', {
      printDensity: config.density,
      printLabelType: config.labelType,
      printMode: config.printMode,
      count: 1,
    });
  }

  async initBoard(): Promise<void> {
    await this.request('InitDrawingBoard', {
      width: 60, height: 40, rotate: 0, path: 'ZT001.ttf', verticalShift: 0, HorizontalShift: 0,
    });
  }

  async text(value: string, box: { x: number; y: number; width: number; height: number; fontSize: number }, options: { bold?: boolean; align?: number } = {}): Promise<void> {
    await this.request('DrawLableText', {
      ...box, rotate: 0, value, fontFamily: '', textAlignHorizontal: options.align ?? 0, textAlignVertical: 0,
      letterSpacing: 0, lineSpacing: 1, lineMode: 6, fontStyle: [options.bold ? 1 : 0, 0, 0, 0],
    });
  }

  async line(x: number, y: number, width: number): Promise<void> {
    await this.request('DrawLableLine', { x, y, width, height: 0.3, rotate: 0, lineWidth: 0.3, lineType: 0 });
  }

  async qr(value: string): Promise<void> {
    await this.request('DrawLableQrCode', { x: 2.4, y: 10.2, width: 20, height: 20, rotate: 0, value, codeType: 31, correctLevel: 2 });
  }

  async commit(): Promise<void> {
    await this.request('commitJob', { printData: null, printerImageProcessingInfo: { printQuantity: 1 } }, 15_000);
  }

  async endJob(): Promise<void> { await this.request('endJob'); }
  async cancelJob(): Promise<void> { try { await this.request('stopPrint'); } catch { /* best effort */ } }
}

class LabelPrinterRuntime {
  private readonly transport = new JingchenTransport();
  private backendHttpUrl = '';
  private timer: number | null = null;
  private subscribers = new Set<() => void>();
  private busy = false;
  private lastRecoveryAt = 0;
  private workerId = `label-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  private state: LabelPrinterRuntimeState = {
    health: 'idle', detail: '等待初始化标签打印服务', printers: [], config: loadConfig(), jobs: [],
    summary: { waiting: 0, printing: 0, printed: 0, failed: 0, blocked: 0, total: 0 },
    currentJobId: null, lastPrintedJobId: null,
  };

  constructor() {
    this.transport.addStatusListener(this.handlePrinterStatus);
  }

  private handlePrinterStatus = (message: JcAck): void => {
    const apiName = String(message.apiName || '');
    const callback = message.resultAck?.callback;
    const callbackName = callback && typeof callback === 'object'
      ? String((callback as Record<string, unknown>).name || '').toLowerCase()
      : '';
    const online = String(message.resultAck?.online || '').toLowerCase();
    const statusApi = apiName === 'printStatus' || apiName === 'getPrinterHighLevelInfo';
    const disconnected = callbackName.includes('disconnect') || online === 'offline' || (statusApi && message.resultAck?.result === false);
    if (!disconnected || this.state.health === 'printing') return;
    const type = this.state.config.connectionType === 'wifi' ? 'WiFi' : 'USB';
    this.emit({ health: 'printer-offline', detail: `${type} 标签机连接已断开，请重新扫描并连接`, currentJobId: null });
  };

  subscribe = (listener: () => void): (() => void) => { this.subscribers.add(listener); return () => this.subscribers.delete(listener); };
  getSnapshot = (): LabelPrinterRuntimeState => this.state;

  private emit(patch: Partial<LabelPrinterRuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.subscribers) listener();
  }

  private async post(path: string, body: Record<string, unknown> = {}): Promise<any> {
    const response = await fetch(`${this.backendHttpUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.code || `HTTP ${response.status}`);
    return payload;
  }

  start(backendHttpUrl: string): void {
    if (!backendHttpUrl) return;
    this.backendHttpUrl = backendHttpUrl.replace(/\/$/, '');
    if (this.timer !== null) return;
    void this.initializePrinter();
    void this.tick();
    this.timer = window.setInterval(() => void this.tick(), 1200);
  }

  private readyDetail(config = this.state.config): string {
    if (config.connectionType === 'wifi') {
      const endpoint = config.wifiAddress
        ? `${config.wifiAddress}${config.wifiPort ? `:${config.wifiPort}` : ''}`
        : (config.wifiPort ? `TCP ${config.wifiPort}` : '已连接设备');
      return `WiFi 标签机已就绪：${config.wifiPrinterName || '精臣标签机'} · ${endpoint}`;
    }
    return `USB 标签机已就绪：${config.printerName || '已连接设备'}`;
  }

  private async initializePrinter(force = false): Promise<void> {
    if (this.busy) return;
    const now = Date.now();
    if (!force && now - this.lastRecoveryAt < 3000 && this.state.health !== 'idle') return;
    this.lastRecoveryAt = now;
    const config = this.state.config;
    this.emit({ health: 'connecting', detail: `正在初始化${config.connectionType === 'wifi' ? ' WiFi' : ' USB'}标签机…` });
    try {
      await this.transport.connect();
      await this.transport.initSdk();

      if (config.connectionType === 'wifi') {
        const printers = await this.transport.listWifiPrinters();
        this.emit({ printers });
        if (printers.length === 0) {
          this.emit({ health: 'printer-offline', detail: '未搜索到 WiFi 精臣标签机；请确认同一局域网后重新扫描' });
          return;
        }
        const saved = config.wifiPrinterName
          ? printers.find((printer) => printer.name === config.wifiPrinterName && (!config.wifiPort || printer.port === config.wifiPort))
          : undefined;
        const target = saved ?? (!config.wifiPrinterName && printers.length === 1 ? printers[0] : undefined);
        if (!target) {
          this.emit({ health: 'printer-offline', detail: config.wifiPrinterName ? '已发现 WiFi 标签机，但未找到上次选择的设备，请重新选择' : `已发现 ${printers.length} 台 WiFi 标签机，请选择设备` });
          return;
        }
        await this.connectWifiPrinter(target.name, target.port || 0);
        return;
      }

      const printers = await this.transport.listUsbPrinters();
      this.emit({ printers });
      const saved = printers.find((printer) => printer.name === config.printerName);
      const target = saved ?? (!config.printerName && printers.length === 1 ? printers[0] : undefined);
      if (!target) {
        this.emit({ health: 'printer-offline', detail: printers.length === 0 ? '未检测到 USB 精臣标签打印机' : '请选择 USB 标签打印机' });
        return;
      }
      await this.transport.selectUsbPrinter(target.name, target.port || 0);
      if (target.name !== config.printerName || target.port !== config.printerPort) {
        this.updateConfig({ printerName: target.name, printerPort: target.port || 0 });
      }
      this.emit({ health: 'ready', detail: this.readyDetail() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[标签打印] 初始化失败 mode=${config.connectionType}:`, error);
      this.emit({ health: this.transport.serviceConnected ? 'printer-offline' : 'service-offline', detail });
    }
  }

  async scanPrinters(): Promise<void> {
    this.lastRecoveryAt = 0;
    const type = this.state.config.connectionType;
    this.emit({ printers: [], health: 'connecting', detail: type === 'wifi' ? '正在扫描局域网 WiFi 标签机…' : '正在扫描 USB 标签机…' });
    try {
      await this.transport.connect();
      await this.transport.initSdk();
      if (type === 'wifi') {
        const printers = await this.transport.listWifiPrinters();
        const selected = printers.find((printer) => printer.name === this.state.config.wifiPrinterName && (!this.state.config.wifiPort || printer.port === this.state.config.wifiPort)) ?? (printers.length === 1 ? printers[0] : undefined);
        if (selected) {
          this.updateConfig({ wifiPrinterName: selected.name, wifiPort: selected.port || 0, wifiAddress: selected.address || '' });
        }
        this.emit({
          printers,
          health: 'printer-offline',
          detail: printers.length > 0 ? `已发现 ${printers.length} 台 WiFi 标签机，请选择后连接` : '未搜索到 WiFi 标签机；请确认电脑与标签机在同一局域网',
        });
        return;
      }
      const printers = await this.transport.listUsbPrinters();
      this.emit({ printers, health: 'printer-offline', detail: printers.length > 0 ? `已发现 ${printers.length} 台 USB 标签机，请选择设备` : '未检测到 USB 精臣标签打印机' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit({ health: this.transport.serviceConnected ? 'printer-offline' : 'service-offline', detail });
      throw error;
    }
  }

  async changeConnectionType(connectionType: PrinterConnectionType): Promise<void> {
    if (this.state.health === 'printing') throw new Error('打印任务执行中，不能切换标签机连接方式');
    this.updateConfig({ connectionType });
    this.lastRecoveryAt = 0;
    this.emit({ printers: [], health: 'connecting', detail: `正在切换到${connectionType === 'wifi' ? ' WiFi' : ' USB'}标签机…` });
    await this.initializePrinter(true);
  }

  async connectUsbPrinter(name: string): Promise<void> {
    const target = this.state.printers.find((printer) => printer.connectionType === 'usb' && printer.name === name);
    if (!target) throw new Error('所选打印机不在当前 USB 列表中，请重新扫描');
    await this.transport.connect();
    await this.transport.initSdk();
    await this.transport.selectUsbPrinter(target.name, target.port || 0);
    this.updateConfig({ connectionType: 'usb', printerName: target.name, printerPort: target.port || 0 });
    this.emit({ health: 'ready', detail: this.readyDetail() });
  }

  async connectPrinter(name: string): Promise<void> { await this.connectUsbPrinter(name); }

  async connectWifiPrinter(nameValue: string, portValue: number): Promise<void> {
    const name = nameValue.trim();
    const port = normalizePort(portValue);
    const target = this.state.printers.find((printer) => printer.connectionType === 'wifi' && printer.name === name && printer.port === port);
    if (!target) throw new Error('所选 WiFi 标签机不在当前扫描列表中，请重新扫描');
    await this.transport.connect();
    await this.transport.initSdk();
    await this.transport.selectWifiPrinter(target.name, target.port || 0, target.address);
    this.updateConfig({ connectionType: 'wifi', wifiAddress: target.address || '', wifiPrinterName: target.name, wifiPort: target.port || 0 });
    this.emit({ health: 'ready', detail: this.readyDetail() });
  }

  updateConfig(patch: Partial<LocalLabelPrinterConfig>): void {
    const config: LocalLabelPrinterConfig = { ...this.state.config, ...patch };
    config.connectionType = normalizeConnectionType(config.connectionType);
    config.density = Math.max(1, Math.min(15, Number(config.density) || 3));
    config.labelType = [1, 2, 3, 4, 5, 6, 10].includes(Number(config.labelType)) ? Number(config.labelType) : 1;
    config.printMode = [1, 2].includes(Number(config.printMode)) ? Number(config.printMode) : 1;
    config.printerPort = Number.isFinite(Number(config.printerPort)) ? Number(config.printerPort) : 0;
    config.wifiAddress = normalizeIpv4(String(config.wifiAddress || ''));
    config.wifiPrinterName = String(config.wifiPrinterName || '').trim();
    config.wifiPort = normalizePort(config.wifiPort);
    saveConfig(config);
    this.emit({ config });
  }

  private async refreshQueue(): Promise<void> {
    if (!this.backendHttpUrl) return;
    const response = await fetch(`${this.backendHttpUrl}/api/label-print/jobs?limit=60`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`标签队列读取失败 HTTP ${response.status}`);
    const payload = await response.json() as { jobs: ProductLabelPrintJob[]; summary: LabelPrintQueueSummary };
    this.emit({ jobs: payload.jobs || [], summary: payload.summary || this.state.summary });
  }

  async retryJob(id: string): Promise<void> {
    await this.post(`/api/label-print/jobs/${encodeURIComponent(id)}/retry`);
    await this.refreshQueue();
  }

  private async drawAndPrint(job: ProductLabelPrintJob): Promise<void> {
    if (!job.productCode || !job.qrContent) throw new Error('产品编号未生成，无法打印二维码标签');
    let submitted = false;
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let timeout: number | null = null;
      const cleanup = () => { this.transport.removeJobListener(listener); if (timeout !== null) window.clearTimeout(timeout); };
      const fail = async (error: unknown) => {
        if (finished) return;
        finished = true; cleanup(); await this.transport.cancelJob();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = () => { if (finished) return; finished = true; cleanup(); resolve(); };
      const listener = (message: JcAck) => {
        if (message.apiName !== 'commitJob') return;
        if (message.resultAck?.info === 'commitJob ok!' && !submitted) {
          submitted = true;
          void (async () => {
            try {
              await this.transport.initBoard();
              await this.transport.text(job.isolation ? '不合格品 / 点型红外火焰探测器' : job.productName,
                { x: 2, y: 1.3, width: 42, height: 4.2, fontSize: job.isolation ? 2.25 : 2.65 }, { bold: true });
              await this.transport.text(`D${job.slot}`, { x: 46, y: 1.0, width: 12, height: 5.2, fontSize: 3.4 }, { bold: true, align: 1 });
              await this.transport.text(`型号：${job.productModel}`, { x: 2, y: 5.5, width: 42, height: 3, fontSize: 1.65 }, { bold: true });
              await this.transport.line(2, 9, 56);
              await this.transport.qr(job.qrContent!);
              await this.transport.text('产品编号', { x: 24.5, y: 10.0, width: 33, height: 3.1, fontSize: 1.75 }, { bold: true });
              await this.transport.text(job.productCode!, { x: 24.5, y: 13.1, width: 33, height: 3.8, fontSize: 2.05 }, { bold: true });
              await this.transport.text(`结果：${job.verdict}`, { x: 24.5, y: 17.5, width: 33, height: 4.5, fontSize: 2.75 }, { bold: true });
              await this.transport.text(`日期：${localDate(job.productionDate)}`, { x: 24.5, y: 22.3, width: 33, height: 3.4, fontSize: 1.85 });
              await this.transport.text(`噪声：${job.noiseValues.map((value, index) => `P${index + 1} ${value}`).join('  ')}`,
                { x: 24.5, y: 26.1, width: 33, height: 3.3, fontSize: 1.65 }, { bold: true });
              await this.transport.line(2, 32, 56);
              await this.transport.text(job.isolation ? 'NG · 请隔离处理' : '二维码内容：产品编号',
                { x: 2, y: 33.0, width: 56, height: 3.4, fontSize: job.isolation ? 2.25 : 1.35 }, { align: 1, bold: job.isolation });
              await this.transport.commit();
            } catch (error) { await fail(error); }
          })();
          return;
        }
        if (message.resultAck?.printCopies !== undefined && Number(message.resultAck.printCopies) >= 1) {
          void this.transport.endJob().then(succeed).catch(fail);
          return;
        }
        if (message.resultAck?.errorCode !== undefined && message.resultAck.errorCode !== 0) {
          void fail(new Error(String(message.resultAck.info || '打印机硬件异常')));
        }
      };
      this.transport.addJobListener(listener);
      timeout = window.setTimeout(() => void fail(new Error('标签打印超时，请检查打印机、标签纸和 jcPrinterSdk.exe')), 20_000);
      void this.transport.startJob(this.state.config).catch(fail);
    });
  }

  private async claimAndPrint(): Promise<void> {
    if (this.busy || !this.state.config.autoPrint || this.state.health !== 'ready') return;
    this.busy = true;
    let claimed: ProductLabelPrintJob | null = null;
    try {
      const payload = await this.post('/api/label-print/claim', { workerId: this.workerId }) as { job: ProductLabelPrintJob | null };
      claimed = payload.job;
      if (!claimed) return;
      this.emit({ health: 'printing', detail: `正在打印 D${claimed.slot} · ${claimed.verdict}`, currentJobId: claimed.id });
      await this.drawAndPrint(claimed);
      await this.post(`/api/label-print/jobs/${encodeURIComponent(claimed.id)}/printed`, { workerId: this.workerId });
      this.emit({ health: 'ready', detail: this.readyDetail(), currentJobId: null, lastPrintedJobId: claimed.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[标签打印] 打印任务失败:', error);
      if (claimed) {
        try { await this.post(`/api/label-print/jobs/${encodeURIComponent(claimed.id)}/failed`, { workerId: this.workerId, error: message }); } catch { /* preserve original */ }
      }
      this.emit({ health: 'error', detail: message, currentJobId: null });
    } finally {
      this.busy = false;
      try { await this.refreshQueue(); } catch { /* next tick retries */ }
    }
  }

  private async tick(): Promise<void> {
    if (!this.backendHttpUrl) return;
    try { await this.refreshQueue(); } catch { return; }
    if (!this.state.config.autoPrint) return;
    if (this.state.health !== 'ready') {
      if (!this.busy) await this.initializePrinter();
      return;
    }
    await this.claimAndPrint();
  }
}

export const labelPrinterRuntime = new LabelPrinterRuntime();
