export type LabelPrintJobStatus = 'WAITING' | 'PRINTING' | 'PRINTED' | 'FAILED' | 'BLOCKED';

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

export interface LocalLabelPrinterConfig {
  autoPrint: boolean;
  printerName: string;
  printerPort: number;
  density: number;
  labelType: number;
  printMode: number;
}

export interface LabelPrinterRuntimeState {
  health: 'idle' | 'connecting' | 'service-offline' | 'printer-offline' | 'ready' | 'printing' | 'error';
  detail: string;
  printers: Array<{ name: string; port: number }>;
  config: LocalLabelPrinterConfig;
  jobs: ProductLabelPrintJob[];
  summary: LabelPrintQueueSummary;
  currentJobId: string | null;
  lastPrintedJobId: string | null;
}

interface JcAck {
  apiName?: string;
  resultAck?: {
    errorCode?: number;
    info?: unknown;
    printCopies?: number;
    result?: unknown;
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
  printerName: '',
  printerPort: 0,
  density: 3,
  labelType: 1,
  printMode: 1,
};

function loadConfig(): LocalLabelPrinterConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<LocalLabelPrinterConfig>;
    return {
      autoPrint: parsed.autoPrint !== false,
      printerName: typeof parsed.printerName === 'string' ? parsed.printerName : '',
      printerPort: Number.isFinite(Number(parsed.printerPort)) ? Number(parsed.printerPort) : 0,
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

class JingchenTransport {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private jobListeners = new Set<(message: JcAck) => void>();
  private selectedPrinter: { name: string; port: number } | null = null;
  private initialized = false;

  get serviceConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get printerSelected(): boolean {
    return Boolean(this.selectedPrinter);
  }

  get selected(): { name: string; port: number } | null {
    return this.selectedPrinter ? { ...this.selectedPrinter } : null;
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

      const pending = this.pending.get(apiName);
      if (pending) {
        const isCommitProgress = apiName === 'commitJob' && message.resultAck?.info !== 'commitJobApi Success!';
        if (!isCommitProgress) {
          window.clearTimeout(pending.timer);
          this.pending.delete(apiName);
          if (message.resultAck?.errorCode === 0) pending.resolve(message);
          else pending.reject(new Error(String(message.resultAck?.info || `${apiName} failed`)));
        }
      }

      if (apiName === 'commitJob') {
        for (const listener of this.jobListeners) {
          try { listener(message); } catch (error) { console.error('[标签打印] 任务监听器异常:', error); }
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

  async listUsbPrinters(): Promise<Array<{ name: string; port: number }>> {
    const response = await this.request('getAllPrinters');
    let info = response.resultAck?.info;
    if (typeof info === 'string') {
      try { info = JSON.parse(info); } catch { /* keep text */ }
    }
    const printers: Array<{ name: string; port: number }> = [];
    if (Array.isArray(info)) {
      info.forEach((item, index) => {
        if (typeof item === 'string') printers.push({ name: item, port: index });
        else if (item && typeof item === 'object') {
          const row = item as Record<string, unknown>;
          const name = String(row.printerName || row.deviceName || '').trim();
          if (name) printers.push({ name, port: Number(row.port) || index });
        }
      });
    } else if (info && typeof info === 'object') {
      Object.entries(info as Record<string, unknown>).forEach(([name, port]) => printers.push({ name, port: Number(port) || 0 }));
    }
    return printers;
  }

  async selectUsbPrinter(name: string, port: number): Promise<void> {
    await this.request('selectPrinter', { printerName: name, port });
    this.selectedPrinter = { name, port };
  }

  addJobListener(listener: (message: JcAck) => void): void {
    this.jobListeners.add(listener);
  }

  removeJobListener(listener: (message: JcAck) => void): void {
    this.jobListeners.delete(listener);
  }

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
      width: 60,
      height: 40,
      rotate: 0,
      path: 'ZT001.ttf',
      verticalShift: 0,
      HorizontalShift: 0,
    });
  }

  async text(value: string, box: { x: number; y: number; width: number; height: number; fontSize: number }, options: { bold?: boolean; align?: number } = {}): Promise<void> {
    await this.request('DrawLableText', {
      ...box,
      rotate: 0,
      value,
      fontFamily: '',
      textAlignHorizontal: options.align ?? 0,
      textAlignVertical: 0,
      letterSpacing: 0,
      lineSpacing: 1,
      lineMode: 6,
      fontStyle: [options.bold ? 1 : 0, 0, 0, 0],
    });
  }

  async line(x: number, y: number, width: number): Promise<void> {
    await this.request('DrawLableLine', { x, y, width, height: 0.3, rotate: 0, lineWidth: 0.3, lineType: 0 });
  }

  async qr(value: string): Promise<void> {
    await this.request('DrawLableQrCode', {
      x: 2.4,
      y: 10.2,
      width: 20,
      height: 20,
      rotate: 0,
      value,
      codeType: 31,
      correctLevel: 2,
    });
  }

  async commit(): Promise<void> {
    await this.request('commitJob', {
      printData: null,
      printerImageProcessingInfo: { printQuantity: 1 },
    }, 15_000);
  }

  async endJob(): Promise<void> {
    await this.request('endJob');
  }

  async cancelJob(): Promise<void> {
    try { await this.request('stopPrint'); } catch { /* best effort */ }
  }
}

class LabelPrinterRuntime {
  private readonly transport = new JingchenTransport();
  private backendHttpUrl = '';
  private timer: number | null = null;
  private subscribers = new Set<() => void>();
  private busy = false;
  private lastRecoveryAt = 0;
  private previousReady = false;
  private workerId = `label-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  private state: LabelPrinterRuntimeState = {
    health: 'idle',
    detail: '等待初始化标签打印服务',
    printers: [],
    config: loadConfig(),
    jobs: [],
    summary: { waiting: 0, printing: 0, printed: 0, failed: 0, blocked: 0, total: 0 },
    currentJobId: null,
    lastPrintedJobId: null,
  };

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getSnapshot = (): LabelPrinterRuntimeState => this.state;

  private emit(patch: Partial<LabelPrinterRuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.subscribers) listener();
  }

  private async post(path: string, body: Record<string, unknown> = {}): Promise<any> {
    const response = await fetch(`${this.backendHttpUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

  private async initializePrinter(): Promise<void> {
    if (this.busy) return;
    const now = Date.now();
    if (now - this.lastRecoveryAt < 3000 && this.state.health !== 'idle') return;
    this.lastRecoveryAt = now;
    this.emit({ health: 'connecting', detail: '正在连接精臣打印服务…' });
    try {
      await this.transport.connect();
      await this.transport.initSdk();
      const printers = await this.transport.listUsbPrinters();
      this.emit({ printers });
      const config = this.state.config;
      const saved = printers.find((printer) => printer.name === config.printerName);
      const target = saved ?? (!config.printerName && printers.length === 1 ? printers[0] : undefined);
      if (!target) {
        this.previousReady = false;
        this.emit({
          health: 'printer-offline',
          detail: printers.length === 0 ? '未检测到 USB 精臣标签打印机' : '请选择标签打印机',
        });
        return;
      }
      await this.transport.selectUsbPrinter(target.name, target.port);
      if (target.name !== config.printerName || target.port !== config.printerPort) {
        this.updateConfig({ printerName: target.name, printerPort: target.port });
      }
      const recovered = !this.previousReady;
      this.previousReady = true;
      this.emit({ health: 'ready', detail: `标签机已就绪：${target.name}` });
      if (recovered && this.state.summary.failed > 0) await this.retryFailedJobs();
    } catch (error) {
      this.previousReady = false;
      this.emit({ health: 'service-offline', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  async scanPrinters(): Promise<void> {
    this.lastRecoveryAt = 0;
    await this.initializePrinter();
  }

  async connectPrinter(name: string): Promise<void> {
    const target = this.state.printers.find((printer) => printer.name === name);
    if (!target) throw new Error('所选打印机不在当前 USB 列表中');
    await this.transport.selectUsbPrinter(target.name, target.port);
    this.updateConfig({ printerName: target.name, printerPort: target.port });
    this.previousReady = true;
    this.emit({ health: 'ready', detail: `标签机已就绪：${target.name}` });
  }

  updateConfig(patch: Partial<LocalLabelPrinterConfig>): void {
    const config: LocalLabelPrinterConfig = {
      ...this.state.config,
      ...patch,
    };
    config.density = Math.max(1, Math.min(15, Number(config.density) || 3));
    config.labelType = [1, 2, 3, 4, 5, 6, 10].includes(Number(config.labelType)) ? Number(config.labelType) : 1;
    config.printMode = [1, 2].includes(Number(config.printMode)) ? Number(config.printMode) : 1;
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

  private async retryFailedJobs(): Promise<void> {
    const failed = this.state.jobs.filter((job) => job.status === 'FAILED').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of failed) {
      try { await this.post(`/api/label-print/jobs/${encodeURIComponent(job.id)}/retry`); } catch { /* leave failed */ }
    }
    if (failed.length > 0) await this.refreshQueue();
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
      const cleanup = () => {
        this.transport.removeJobListener(listener);
        if (timeout !== null) window.clearTimeout(timeout);
      };
      const fail = async (error: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        await this.transport.cancelJob();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };
      const listener = (message: JcAck) => {
        if (message.apiName !== 'commitJob') return;
        if (message.resultAck?.info === 'commitJob ok!' && !submitted) {
          submitted = true;
          void (async () => {
            try {
              await this.transport.initBoard();
              await this.transport.text(job.isolation ? '不合格品 / 点型红外火焰探测器' : job.productName,
                { x: 2, y: 1.3, width: 42, height: 4.2, fontSize: job.isolation ? 2.25 : 2.65 }, { bold: true });
              await this.transport.text(`D${job.slot}`,
                { x: 46, y: 1.0, width: 12, height: 5.2, fontSize: 3.4 }, { bold: true, align: 1 });
              await this.transport.text(`型号：${job.productModel}`,
                { x: 2, y: 5.5, width: 42, height: 3, fontSize: 1.65 }, { bold: true });
              await this.transport.line(2, 9, 56);
              await this.transport.qr(job.qrContent!);
              await this.transport.text('产品编号',
                { x: 24.5, y: 10.0, width: 33, height: 3.1, fontSize: 1.75 }, { bold: true });
              await this.transport.text(job.productCode!,
                { x: 24.5, y: 13.1, width: 33, height: 3.8, fontSize: 2.05 }, { bold: true });
              await this.transport.text(`结果：${job.verdict}`,
                { x: 24.5, y: 17.5, width: 33, height: 4.5, fontSize: 2.75 }, { bold: true });
              await this.transport.text(`日期：${localDate(job.productionDate)}`,
                { x: 24.5, y: 22.3, width: 33, height: 3.4, fontSize: 1.85 });
              await this.transport.text(`噪声：${job.noiseValues.map((value, index) => `P${index + 1} ${value}`).join('  ')}`,
                { x: 24.5, y: 26.1, width: 33, height: 3.3, fontSize: 1.65 }, { bold: true });
              await this.transport.line(2, 32, 56);
              await this.transport.text(job.isolation ? 'NG · 请隔离处理' : '二维码内容：产品编号',
                { x: 2, y: 33.0, width: 56, height: 3.4, fontSize: job.isolation ? 2.25 : 1.35 },
                { align: 1, bold: job.isolation });
              await this.transport.commit();
            } catch (error) {
              await fail(error);
            }
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
      this.emit({
        health: 'ready',
        detail: `标签机已就绪：${this.state.config.printerName || '已连接设备'}`,
        currentJobId: null,
        lastPrintedJobId: claimed.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (claimed) {
        try {
          await this.post(`/api/label-print/jobs/${encodeURIComponent(claimed.id)}/failed`, { workerId: this.workerId, error: message });
        } catch { /* preserve original print error */ }
      }
      this.previousReady = false;
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
