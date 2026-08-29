import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ClosureAuditEvent } from './types.js';

const AUDIT_FILE = 'offline-closure-audit.v2.jsonl';
const GENESIS = 'OFFLINE_CLOSURE_AUDIT_V2';

export interface OfflineAuditStore {
  append(event: ClosureAuditEvent): Promise<void>;
  list(limit: number): Promise<ClosureAuditEvent[]>;
  listByBatchId(batchId: string, limit: number): Promise<ClosureAuditEvent[]>;
}

export class FileOfflineAuditStore implements OfflineAuditStore {
  private readonly filePath: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(directory = defaultAuditDirectory()) {
    this.filePath = join(directory, AUDIT_FILE);
  }

  append(event: ClosureAuditEvent): Promise<void> {
    const append = async () => {
      const records = await this.readAndVerify();
      const stored = chainEvent(event, records.at(-1)?.auditHash ?? null);
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(stored)}\n`, 'utf8');
    };
    this.writes = this.writes.then(append, append);
    return this.writes;
  }

  async list(limit: number): Promise<ClosureAuditEvent[]> {
    await this.writes;
    return (await this.readAndVerify()).slice(-limit);
  }

  async listByBatchId(batchId: string, limit: number): Promise<ClosureAuditEvent[]> {
    await this.writes;
    return (await this.readAndVerify()).filter((event) => event.batchId === batchId).slice(-limit);
  }

  private async readAndVerify(): Promise<ClosureAuditEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return verifyChain(contents.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as ClosureAuditEvent));
  }
}

export class MemoryOfflineAuditStore implements OfflineAuditStore {
  private readonly events: ClosureAuditEvent[] = [];

  async append(event: ClosureAuditEvent): Promise<void> {
    verifyChain(this.events);
    this.events.push(chainEvent(event, this.events.at(-1)?.auditHash ?? null));
  }

  async list(limit: number): Promise<ClosureAuditEvent[]> {
    return verifyChain(this.events).slice(-limit).map((event) => structuredClone(event));
  }

  async listByBatchId(batchId: string, limit: number): Promise<ClosureAuditEvent[]> {
    return verifyChain(this.events).filter((event) => event.batchId === batchId).slice(-limit).map((event) => structuredClone(event));
  }
}

function chainEvent(event: ClosureAuditEvent, previousAuditHash: string | null): ClosureAuditEvent {
  const payload = stripHashes(event);
  const auditHash = hash(previousAuditHash ?? GENESIS, payload);
  return { ...payload, previousAuditHash, auditHash };
}

function verifyChain(events: readonly ClosureAuditEvent[]): ClosureAuditEvent[] {
  let previousAuditHash: string | null = null;
  for (const event of events) {
    if (event.previousAuditHash !== previousAuditHash || typeof event.auditHash !== 'string') {
      throw new Error('OFFLINE_AUDIT_INTEGRITY_FAILED');
    }
    const expected = hash(previousAuditHash ?? GENESIS, stripHashes(event));
    if (event.auditHash !== expected) throw new Error('OFFLINE_AUDIT_INTEGRITY_FAILED');
    previousAuditHash = event.auditHash;
  }
  return [...events];
}

function stripHashes(event: ClosureAuditEvent): Omit<ClosureAuditEvent, 'previousAuditHash' | 'auditHash'> {
  const { previousAuditHash: _previousAuditHash, auditHash: _auditHash, ...payload } = event;
  return payload;
}

function hash(previousAuditHash: string, event: Omit<ClosureAuditEvent, 'previousAuditHash' | 'auditHash'>): string {
  return createHash('sha256').update(`${previousAuditHash}\n${JSON.stringify(event)}`).digest('hex').toUpperCase();
}

function defaultAuditDirectory(): string {
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR;
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return join(currentDirectory, '..', '..', 'data');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
