import { EventEmitter } from 'events';
import { createRequire } from 'module';
import type { PLCDeviceConfigLocal } from './config.js';
import { PLC_PROGRAM, PLC_PROCESS_TAGS, type PLCSignalDefinition } from './plc-program-contract.js';
import { decodePLCProcessStatus, type PLCProcessIO, type PLCProcessStatus } from './process-status.js';

const require = createRequire(import.meta.url);
const NodeS7 = require('nodes7');

// S7-200 SMART V words are exposed through the S7 protocol as DB1 word offsets.
// VW600/VW602 therefore map to DB1,INT600/DB1,INT602 for nodes7; MW600/MW602
// incorrectly address the M area and return BAD 255 from this PLC.
const DEFAULT_PLC_PROCESS_POLL_INTERVAL_MS = 200;
const MIN_PLC_PROCESS_POLL_INTERVAL_MS = 100;
const MAX_PLC_PROCESS_POLL_INTERVAL_MS = 900;

/** Keep process-stage observation inside the one-second field response budget. */
export function normalizePLCProcessPollInterval(value: unknown): number {
  const configured = Number(value);
  if (!Number.isFinite(configured)) return DEFAULT_PLC_PROCESS_POLL_INTERVAL_MS;
  return Math.min(
    Math.max(Math.floor(configured), MIN_PLC_PROCESS_POLL_INTERVAL_MS),
    MAX_PLC_PROCESS_POLL_INTERVAL_MS,
  );
}

function readBit(values: Record<string, unknown>, address: string): boolean {
  const value = values[address];
  if (typeof value === 'boolean') return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : false;
}

function readArea(
  values: Record<string, unknown>,
  definitions: readonly { key: string; address: string }[],
): Record<string, boolean> {
  return Object.fromEntries(definitions.map((item) => [item.key, readBit(values, item.address)]));
}

function uniqueSignalDefinitions(definitions: readonly PLCSignalDefinition[]): PLCSignalDefinition[] {
  const byKey = new Map<string, PLCSignalDefinition>();
  for (const item of definitions) {
    if (!item.key || !item.address) continue;
    byKey.set(item.key, { ...item });
  }
  return [...byKey.values()];
}

function buildPLCProcessIO(
  values: Record<string, unknown>,
  timestamp: number,
  extraInputs: readonly PLCSignalDefinition[],
): PLCProcessIO {
  const inputs = uniqueSignalDefinitions([...PLC_PROGRAM.inputs, ...extraInputs]);
  return {
    inputs: readArea(values, inputs),
    outputs: readArea(values, PLC_PROGRAM.relays),
    internal: readArea(values, PLC_PROGRAM.internal),
    steps: readArea(values, PLC_PROGRAM.steps),
    syncedAt: timestamp,
  };
}

/** Read-only observer for the PLC process registers. It intentionally exposes no write operation. */
export class PLCProcessMonitor extends EventEmitter {
  private conn: any;
  private pollTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reading = false;
  private connected = false;
  private stopped = false;
  private current: PLCProcessStatus | undefined;
  private extraInputs: PLCSignalDefinition[];
  private processTags: string[];

  constructor(
    private readonly plc: PLCDeviceConfigLocal,
    extraInputs: readonly PLCSignalDefinition[] = [],
  ) {
    super();
    if (plc.mode !== 'S7') throw new Error('PLC_PROCESS_STATUS_REQUIRES_S7_MODE');
    this.extraInputs = uniqueSignalDefinitions(extraInputs);
    this.processTags = this.buildProcessTags();
    this.conn = new NodeS7({ silent: true });
  }

  private buildProcessTags(): string[] {
    return [...new Set([
      ...PLC_PROCESS_TAGS,
      ...this.extraInputs.map((item) => item.address),
    ])];
  }

  updateExtraInputs(extraInputs: readonly PLCSignalDefinition[]): void {
    this.extraInputs = uniqueSignalDefinitions(extraInputs);
    const nextTags = this.buildProcessTags();
    const previous = new Set(this.processTags);
    const additions = nextTags.filter((tag) => !previous.has(tag));
    this.processTags = nextTags;
    if (this.connected && additions.length > 0) {
      this.conn.addItems(additions);
      this.poll();
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopped = true;
    this.connected = false;
    this.current = undefined;
    try { this.conn.dropConnection(); } catch { /* disconnected */ }
  }

  getCurrent(): PLCProcessStatus | undefined { return this.current; }
  isConnected(): boolean { return this.connected; }

  private connect(): void {
    if (this.stopped || this.connected) return;
    this.conn = new NodeS7({ silent: true });
    this.conn.initiateConnection({ host: this.plc.ip, port: this.plc.port || 102, rack: 0, slot: 1, timeout: 5000 }, (error: unknown) => {
      if (error) {
        this.handleConnectionFailure(error);
        return;
      }
      this.connected = true;
      this.conn.addItems(this.processTags);
      if (!this.pollTimer) {
        this.pollTimer = setInterval(
          () => this.poll(),
          normalizePLCProcessPollInterval(this.plc.pollIntervalMs),
        );
      }
      this.poll();
    });
  }

  private handleConnectionFailure(error: unknown): void {
    this.connected = false;
    this.current = undefined;
    this.emit('error', error);
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 5_000);
  }

  private poll(): void {
    if (!this.connected || this.reading) return;
    this.reading = true;
    this.conn.readAllItems((error: unknown, values: Record<string, unknown>) => {
      this.reading = false;
      if (error) {
        try { this.conn.dropConnection(); } catch { /* disconnected */ }
        this.handleConnectionFailure(error);
        return;
      }
      const timestamp = Date.now();
      const io = buildPLCProcessIO(values, timestamp, this.extraInputs);
      const status = decodePLCProcessStatus({
        stageCode: Number(values['DB1,INT600']),
        stepCode: Number(values['DB1,INT602']),
        autoRunning: io.internal.autoRunning ?? false,
        complete: io.internal.complete ?? false,
        alarm: io.internal.processAlarm ?? false,
        returningHome: io.internal.returnHomeFlag ?? false,
        timestamp,
        io,
      });
      this.current = status;
      this.emit('status', status);
    });
  }
}
