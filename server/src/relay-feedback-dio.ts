import ModbusRTU from 'modbus-serial';
import {
  DEFAULT_RELAY_DIO_CONFIG,
  normalizeRelayDioConfig,
  type RelayDioConfig,
} from './relay-functional-test.js';

export interface ModbusTcpClientLike {
  isOpen: boolean;
  setID(unitId: number): void;
  setTimeout(duration: number): void;
  connectTCP(host: string, options: { port: number; timeout: number }): Promise<void>;
  readInputRegisters(address: number, length: number): Promise<{ data: number[] }>;
  readDiscreteInputs(address: number, length: number): Promise<{ data: boolean[] }>;
  close(): void | Promise<void>;
}

type ModbusClientFactory = () => ModbusTcpClientLike;

export class RelayFeedbackDioError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'RelayFeedbackDioError';
  }
}

function defaultClientFactory(): ModbusTcpClientLike {
  return new ModbusRTU() as unknown as ModbusTcpClientLike;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * On-demand DIO feedback reader.
 *
 * It intentionally has no background timer. The relay test invokes readInputs
 * while it is checking an action or reset, so the main PLC page remains a PLC
 * page and does not become a second real-time DIO monitor.
 */
export class DioModbusTcpInputSource {
  private config: RelayDioConfig;
  private client: ModbusTcpClientLike | null = null;
  private connecting: Promise<void> | null = null;
  private reading: Promise<Record<string, boolean>> | null = null;

  constructor(
    config: RelayDioConfig,
    private readonly createClient: ModbusClientFactory = defaultClientFactory,
  ) {
    this.config = normalizeRelayDioConfig(config, DEFAULT_RELAY_DIO_CONFIG);
  }

  getConfig(): RelayDioConfig {
    return { ...this.config };
  }

  async updateConfig(config: RelayDioConfig): Promise<void> {
    const next = normalizeRelayDioConfig(config, DEFAULT_RELAY_DIO_CONFIG);
    const changed = JSON.stringify(next) !== JSON.stringify(this.config);
    this.config = next;
    if (changed) await this.disconnect();
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // The socket is already unusable; the next test will create a new client.
    }
  }

  async readInputs(): Promise<Record<string, boolean>> {
    if (this.reading) return this.reading;
    const request = this.readOnce().finally(() => {
      if (this.reading === request) this.reading = null;
    });
    this.reading = request;
    return request;
  }

  async testConnection(): Promise<{ inputCount: number }> {
    const values = await this.readInputs();
    return { inputCount: Object.keys(values).length };
  }

  private async ensureConnected(): Promise<ModbusTcpClientLike> {
    if (!this.config.host.trim()) throw new RelayFeedbackDioError('DIO_NOT_CONFIGURED');
    if (this.client?.isOpen) {
      this.client.setID(this.config.unitId);
      return this.client;
    }
    if (!this.connecting) {
      const client = this.createClient();
      this.client = client;
      client.setTimeout(this.config.requestTimeoutMs);
      this.connecting = client.connectTCP(this.config.host, {
        port: this.config.port,
        timeout: this.config.requestTimeoutMs,
      }).then(() => {
        client.setID(this.config.unitId);
      }).catch(async (error: unknown) => {
        if (this.client === client) this.client = null;
        try { await client.close(); } catch { /* connection failed */ }
        throw new RelayFeedbackDioError('DIO_CONNECTION_FAILED', errorMessage(error));
      }).finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    if (!this.client) throw new RelayFeedbackDioError('DIO_CONNECTION_FAILED');
    return this.client;
  }

  private async readOnce(): Promise<Record<string, boolean>> {
    const client = await this.ensureConnected();
    try {
      const result = this.config.functionCode === 4
        ? await client.readInputRegisters(this.config.startAddress, this.config.inputCount)
        : await client.readDiscreteInputs(this.config.startAddress, this.config.inputCount);
      if (!Array.isArray(result?.data) || result.data.length < this.config.inputCount) {
        throw new RelayFeedbackDioError('DIO_RESPONSE_INVALID');
      }
      return Object.fromEntries(Array.from({ length: this.config.inputCount }, (_, offset) => [
        `X${this.config.startAddress + offset + 1}`,
        Boolean(result.data[offset]),
      ]));
    } catch (error) {
      await this.disconnect();
      if (error instanceof RelayFeedbackDioError) throw error;
      throw new RelayFeedbackDioError('DIO_READ_FAILED', errorMessage(error));
    }
  }
}
