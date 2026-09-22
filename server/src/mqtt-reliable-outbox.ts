import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MQTT_OUTBOX_BACKLOG_WARNING_THRESHOLD = 100;

export interface PendingReliableMessage {
  topic: string;
  payload: unknown;
  queuedAt: number;
}

interface PersistedOutboxItem extends PendingReliableMessage {
  key: string;
}

export interface ReliableOutboxStatus {
  pending: number;
  oldestPendingAt?: number;
  backlogWarning: boolean;
  persistenceHealthy: boolean;
  lastError?: string;
  file: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Disk-backed MQTT inspection queue.
 *
 * Production inspection evidence must never be silently evicted because a broker
 * stayed offline for too long. There is deliberately no count-based retention cap.
 * A corrupt queue file is preserved with a .corrupt-* suffix instead of being
 * overwritten, and persistence health is exposed to the caller for operator alarm.
 */
export class ReliableMQTTOutbox {
  private readonly messages = new Map<string, PendingReliableMessage>();
  private persistenceHealthy = true;
  private lastError = '';

  constructor(readonly file: string) {
    this.load();
  }

  get size(): number {
    return this.messages.size;
  }

  entries(): Array<[string, PendingReliableMessage]> {
    return Array.from(this.messages.entries()).map(([key, value]) => [key, { ...value }]);
  }

  status(): ReliableOutboxStatus {
    const oldestPendingAt = this.messages.size > 0
      ? Math.min(...Array.from(this.messages.values()).map((message) => message.queuedAt))
      : undefined;
    return {
      pending: this.messages.size,
      ...(oldestPendingAt === undefined ? {} : { oldestPendingAt }),
      backlogWarning: this.messages.size >= MQTT_OUTBOX_BACKLOG_WARNING_THRESHOLD,
      persistenceHealthy: this.persistenceHealthy,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      file: this.file,
    };
  }

  set(key: string, message: PendingReliableMessage): boolean {
    this.messages.set(key, { ...message });
    return this.persist();
  }

  delete(key: string): boolean {
    if (!this.messages.delete(key)) return true;
    return this.persist();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('MQTT_OUTBOX_FORMAT_INVALID');
      for (const item of parsed) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const value = item as Partial<PersistedOutboxItem>;
        if (typeof value.key !== 'string' || !value.key || typeof value.topic !== 'string' || !value.topic) continue;
        this.messages.set(value.key.slice(0, 256), {
          topic: value.topic.slice(0, 1024),
          payload: value.payload,
          queuedAt: Number.isFinite(Number(value.queuedAt)) ? Number(value.queuedAt) : Date.now(),
        });
      }
    } catch (error) {
      const preserved = `${this.file}.corrupt-${Date.now()}`;
      let preservedNote = '';
      try {
        renameSync(this.file, preserved);
        preservedNote = `; preserved=${preserved}`;
      } catch (preserveError) {
        preservedNote = `; preserve_failed=${errorMessage(preserveError)}`;
      }
      this.persistenceHealthy = false;
      this.lastError = `MQTT_OUTBOX_READ_FAILED:${errorMessage(error)}${preservedNote}`;
      console.error('[MQTT Server] 待上传队列读取失败，原文件已尽量保留:', this.lastError);
    }
  }

  private persist(): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.messages.size === 0) {
        try { unlinkSync(this.file); } catch { /* file may not exist */ }
        this.persistenceHealthy = true;
        this.lastError = '';
        return true;
      }
      const items: PersistedOutboxItem[] = Array.from(this.messages.entries()).map(([key, message]) => ({ key, ...message }));
      const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
        renameSync(temporary, this.file);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* no temporary file */ }
        throw error;
      }
      this.persistenceHealthy = true;
      this.lastError = '';
      return true;
    } catch (error) {
      this.persistenceHealthy = false;
      this.lastError = `MQTT_OUTBOX_WRITE_FAILED:${errorMessage(error)}`;
      console.error('[MQTT Server] 待上传队列保存失败:', this.lastError);
      return false;
    }
  }
}
