import { Socket } from 'node:net';
import { calculateModbusCRC16 } from './flame-data-decoder.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 700;
/** 现场 TCP 独立端口拓扑：每个端口仅挂一台探测器，所有探测器从站地址均为 0x01。 */
const FIELD_TCP_DEVICE_ADDRESS = 0x01;

function appendCRC(body: Buffer): Buffer {
  const crc = calculateModbusCRC16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >>> 8) & 0xFF])]);
}

function isValidFrame(frame: Buffer): boolean {
  if (frame.length < 3) return false;
  const received = (frame[frame.length - 1]! << 8) | frame[frame.length - 2]!;
  return calculateModbusCRC16(frame.subarray(0, -2)) === received;
}

function findResponse(
  buffer: Buffer,
  address: number,
  functionCode: number,
  quantity: number,
): { frame?: Buffer; error?: Error } | null {
  for (let offset = 0; offset < buffer.length; offset += 1) {
    if (buffer[offset] !== address) continue;
    const code = buffer[offset + 1];
    if (code === (functionCode | 0x80)) {
      const frameLength = 5;
      if (buffer.length - offset < frameLength) return null;
      const frame = buffer.subarray(offset, offset + frameLength);
      if (isValidFrame(frame)) return { error: new Error(`探测器返回 Modbus 异常码 0x${(frame[2] ?? 0).toString(16).padStart(2, '0')}`) };
      continue;
    }
    if (code !== functionCode) continue;

    const byteCount = buffer[offset + 2] ?? 0;
    if (functionCode === 0x03 && byteCount !== quantity * 2) continue;
    const frameLength = functionCode === 0x03 ? 5 + byteCount : 8;
    if (buffer.length - offset < frameLength) return null;
    const frame = buffer.subarray(offset, offset + frameLength);
    if (!isValidFrame(frame)) continue;
    return { frame: Buffer.from(frame) };
  }
  return null;
}

export class RawTcpModbusClient {
  private readonly requestTimeoutMs: number;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(
    public readonly socket: Socket,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
  }

  get isOpen(): boolean {
    return !this.socket.destroyed && this.socket.writable !== false;
  }

  async readHoldingRegisters(address: number, startAddress: number, quantity: number): Promise<{ data: number[] }> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 125) throw new Error('Modbus RTU 读取寄存器数量无效');
    // Raw TCP 现场每个 TCP 端口仅对应一台地址 01 的探测器；禁止把 detectorIndex/持久化 address 带入帧地址。
    void address;
    const targetAddress = FIELD_TCP_DEVICE_ADDRESS;
    const body = Buffer.from([
      targetAddress,
      0x03,
      (startAddress >>> 8) & 0xFF,
      startAddress & 0xFF,
      (quantity >>> 8) & 0xFF,
      quantity & 0xFF,
    ]);
    const response = await this.enqueue(() => this.exchange(appendCRC(body), targetAddress, 0x03, quantity));
    const data = Array.from({ length: quantity }, (_, index) => response.readUInt16BE(3 + index * 2));
    return { data };
  }

  async writeRegisters(address: number, startAddress: number, values: number[]): Promise<void> {
    if (!Number.isInteger(values.length) || values.length < 1 || values.length > 123) throw new Error('Modbus RTU 写入寄存器数量无效');
    // 普通有地址 Raw TCP 写也固定走 01；火警/故障/复位控制另由 relay-simulation 走 FF 广播写。
    void address;
    const targetAddress = FIELD_TCP_DEVICE_ADDRESS;
    const body = Buffer.alloc(7 + values.length * 2);
    body[0] = targetAddress;
    body[1] = 0x10;
    body.writeUInt16BE(startAddress & 0xFFFF, 2);
    body.writeUInt16BE(values.length, 4);
    body[6] = values.length * 2;
    values.forEach((value, index) => body.writeUInt16BE(Number(value) & 0xFFFF, 7 + index * 2));
    await this.enqueue(() => this.exchange(appendCRC(body), targetAddress, 0x10, values.length));
  }

  async sendRawFrame(frame: Buffer): Promise<void> {
    if (!Buffer.isBuffer(frame) || frame.length < 3) throw new Error('探测器原始帧无效');
    const request = Buffer.from(frame);
    await this.enqueue(() => this.writeOneWay(request));
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        this.socket.destroy();
        finish();
      }, 1000);
      this.socket.once('close', finish);
      this.socket.once('error', finish);
      try {
        this.socket.end(finish);
      } catch {
        this.socket.destroy();
        finish();
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.requestTail.then(operation, operation);
    this.requestTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private exchange(request: Buffer, address: number, functionCode: number, quantity: number): Promise<Buffer> {
    if (!this.isOpen) return Promise.reject(new Error('探测器原始 TCP 连接不可用'));
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const onData = (chunk: Buffer) => {
        if (settled) return;
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const found = findResponse(buffer, address, functionCode, quantity);
        if (found?.error) finish(found.error);
        else if (found?.frame) finish(undefined, found.frame);
        else if (buffer.length > 8192) buffer = buffer.subarray(-256);
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error('探测器原始 TCP 连接已关闭'));
      let buffer = Buffer.alloc(0);
      const cleanup = () => {
        this.socket.removeListener('data', onData);
        this.socket.removeListener('error', onError);
        this.socket.removeListener('close', onClose);
        clearTimeout(timer);
      };
      const finish = (error?: Error, response?: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(response!);
      };

      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
      timer = setTimeout(() => finish(new Error(`等待探测器 Modbus RTU 回包超时（${this.requestTimeoutMs}ms）`)), this.requestTimeoutMs);
      try {
        this.socket.write(request, (error) => {
          if (error) finish(error);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeOneWay(request: Buffer): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error('探测器原始 TCP 连接不可用'));
    return new Promise<void>((resolve, reject) => {
      try {
        this.socket.write(request, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export async function connectRawTcpClient(host: string, port: number, timeoutMs: number): Promise<RawTcpModbusClient> {
  const socket = new Socket();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new Error(`探测器 TCP 连接超时（${host}:${port}）`));
      }, timeoutMs);
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.setKeepAlive(true, 1000);
      socket.setNoDelay(true);
      socket.connect(port, host);
    });
    return new RawTcpModbusClient(socket, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
