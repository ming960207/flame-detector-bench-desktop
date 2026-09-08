import { getRawTcpSocket, type FlameDetectorClient } from './flame-detector-device.js';
import { FlameDetectorService } from './flame-detector-service.js';
import type { FlameUnitConfig } from '../config.js';

/**
 * Field waveform startup policy.
 *
 * The detector may acknowledge the send-mode command several seconds before it
 * starts continuous waveform streaming. Re-sending the FF mode frame during that
 * transition can restart the detector-side startup sequence forever: transport is
 * connected and every command is ACKed, but no valid waveform sample is produced.
 *
 * Keep fast exponential retries only for the "no ACK / command failed" case. Once
 * an ACK is received, leave the physical stream untouched and let the existing
 * waveform watchdog decide whether a new mode switch is required after the full
 * stale timeout (currently 10 s). A valid decoded sample still remains the only
 * event that marks the stream ready and clears the request state.
 *
 * This module is intentionally loaded before the field runtime creates detector
 * services. TypeScript `private` members are normal prototype members at runtime;
 * the patch is kept here as a narrow startup policy so the established decoder and
 * transport implementation do not need to be forked.
 */

type InternalService = Record<string, any>;

type RxStats = {
  bytes: number;
  chunks: number;
  customHeaderHits: number;
  ackHits: number;
  firstAt: number;
  lastLogAt: number;
  firstValidLogged: boolean;
};

const POLICY_MARK = Symbol.for('flame-detector-bench.waveform-startup-policy.v1');
const SEND_MODE_ACK = Buffer.from('0110300000024ec8', 'hex');
const CUSTOM_HEADER = Buffer.from([0x5A, 0xA5]);
const RX_LOG_INTERVAL_MS = 5_000;
const socketStats = new WeakMap<object, RxStats>();

function countOccurrences(buffer: Buffer, needle: Buffer): number {
  if (needle.length === 0 || buffer.length < needle.length) return 0;
  let count = 0;
  let offset = buffer.indexOf(needle);
  while (offset >= 0) {
    count += 1;
    offset = buffer.indexOf(needle, offset + 1);
  }
  return count;
}

function stateHistoryTotal(service: InternalService, unitIndex: number): number {
  const state = service.units?.get?.(unitIndex);
  return Number(state?.historySampleTotal ?? 0);
}

function installPolicy(): void {
  const proto = FlameDetectorService.prototype as unknown as Record<PropertyKey, any>;
  if (proto[POLICY_MARK]) return;
  proto[POLICY_MARK] = true;

  const originalAttachPushListener = proto.attachPushListener as (
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
  ) => boolean;
  const originalApplyPushFrame = proto.applyPushFrame as (
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
    frame: Buffer,
  ) => void;
  const originalApplyModbusPushFrame = proto.applyModbusPushFrame as (
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
    frame: Buffer,
  ) => void;
  const originalHandleWaveformStale = proto.handleWaveformStale as (
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
  ) => void;

  proto.attachPushListener = function patchedAttachPushListener(
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
  ): boolean {
    const attached = originalAttachPushListener.call(this, unit, client);
    if (!attached) return false;

    const socket = getRawTcpSocket(client);
    if (!socket || typeof socket.on !== 'function') return true;
    const socketKey = socket as object;
    if (socketStats.has(socketKey)) return true;

    const stats: RxStats = {
      bytes: 0,
      chunks: 0,
      customHeaderHits: 0,
      ackHits: 0,
      firstAt: 0,
      lastLogAt: 0,
      firstValidLogged: false,
    };
    socketStats.set(socketKey, stats);
    const service = this;

    socket.on('data', (chunk: Buffer) => {
      const data = Buffer.from(chunk);
      const now = Date.now();
      stats.bytes += data.length;
      stats.chunks += 1;
      stats.customHeaderHits += countOccurrences(data, CUSTOM_HEADER);
      stats.ackHits += countOccurrences(data, SEND_MODE_ACK);
      if (stats.firstAt === 0) stats.firstAt = now;

      const hasValidWaveform = stateHistoryTotal(service, unit.index) > 0;
      const shouldLog = stats.chunks === 1 || (!hasValidWaveform && now - stats.lastLogAt >= RX_LOG_INTERVAL_MS);
      if (!shouldLog) return;
      stats.lastLogAt = now;
      const preview = data.subarray(0, 24).toString('hex').toUpperCase();
      console.log(
        `[FlameService][RX] D${unit.index} raw chunks=${stats.chunks} bytes=${stats.bytes} `
        + `5AA5=${stats.customHeaderHits} ack=${stats.ackHits} head=${preview || '-'}`,
      );
    });
    return true;
  };

  const logFirstValid = (service: InternalService, unit: FlameUnitConfig, client: FlameDetectorClient, before: number) => {
    const after = stateHistoryTotal(service, unit.index);
    if (before > 0 || after <= 0) return;
    const socket = getRawTcpSocket(client);
    const stats = socket ? socketStats.get(socket as object) : undefined;
    if (stats?.firstValidLogged) return;
    if (stats) stats.firstValidLogged = true;
    const state = service.units?.get?.(unit.index);
    console.log(
      `[FlameService][RX] D${unit.index} 首个有效波形样本已形成 total=${after} `
      + `protocol=${state?.protocol ?? '-'} rawBytes=${stats?.bytes ?? 0} rawChunks=${stats?.chunks ?? 0}`,
    );
  };

  proto.applyPushFrame = function patchedApplyPushFrame(
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
    frame: Buffer,
  ): void {
    const before = stateHistoryTotal(this, unit.index);
    originalApplyPushFrame.call(this, unit, client, frame);
    logFirstValid(this, unit, client, before);
  };

  proto.applyModbusPushFrame = function patchedApplyModbusPushFrame(
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
    frame: Buffer,
  ): void {
    const before = stateHistoryTotal(this, unit.index);
    originalApplyModbusPushFrame.call(this, unit, client, frame);
    logFirstValid(this, unit, client, before);
  };

  proto.handleWaveformStale = function patchedHandleWaveformStale(
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
  ): void {
    const socket = getRawTcpSocket(client);
    const stats = socket ? socketStats.get(socket as object) : undefined;
    console.warn(
      `[FlameService][RX] D${unit.index} 波形看门狗到期，准备重新切换发送模式; `
      + `rawBytes=${stats?.bytes ?? 0} rawChunks=${stats?.chunks ?? 0} `
      + `5AA5=${stats?.customHeaderHits ?? 0} ack=${stats?.ackHits ?? 0} `
      + `samples=${stateHistoryTotal(this, unit.index)}`,
    );
    originalHandleWaveformStale.call(this, unit, client);
  };

  proto.sendBroadcastModeRequest = async function patchedSendBroadcastModeRequest(
    this: InternalService,
    unit: FlameUnitConfig,
    client: FlameDetectorClient,
  ): Promise<boolean> {
    if (
      this.disposed
      || this.closing
      || !this.waveformStreamingArmed
      || !this.broadcastModeRequestingUnits?.has?.(unit.index)
      || !this.isCurrentClient(unit, client)
    ) return false;

    const inFlightClient = this.broadcastModeRequestInFlight?.get?.(unit.index);
    if (inFlightClient === client) return false;
    if (inFlightClient && !this.isCurrentClient(unit, inFlightClient)) {
      this.broadcastModeRequestInFlight.delete(unit.index);
    }
    if (this.broadcastModeRequestInFlight.has(unit.index)) return false;

    this.broadcastModeRequestInFlight.set(unit.index, client);
    const state = this.units.get(unit.index) ?? this.defaultUnitState(unit);
    const sendMode = this.configuredWaveformSendMode();
    const attempt = (this.broadcastModeRetryAttempts.get(unit.index) ?? 0) + 1;
    let acknowledged = false;

    console.log(`[FlameService] 设备 ${unit.index} 发送波形模式切换请求 (模式 ${sendMode}, 尝试 ${attempt})`);
    try {
      const device = this.getDevice(unit, client);
      await device.sendBroadcastSendMode({
        mode: sendMode,
        attempts: 1,
        retryDelayMs: 0,
        waitForResponse: true,
      });
      if (!this.isCurrentClient(unit, client)) return false;

      acknowledged = true;
      console.log(
        `[FlameService] 设备 ${unit.index} 波形模式切换已确认；停止短周期 FF 重发，`
        + `等待首个有效波形（看门狗 ${this.waveformStaleTimeoutMs()}ms）`,
      );
      state.sendMode = sendMode;
      state.lastError = undefined;
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
      this.scheduleWaveformWatchdog(unit, client);
      return true;
    } catch (error: any) {
      console.error(`[FlameService] 设备 ${unit.index} 波形模式切换请求失败:`, error?.message || String(error));
      if (!this.isCurrentClient(unit, client)) return false;

      const lastPush = this.lastPushAt.get(unit.index) ?? 0;
      const waveformIsRecent = lastPush > 0 && Date.now() - lastPush <= this.waveformStaleTimeoutMs();
      if (waveformIsRecent) {
        state.sendMode = sendMode;
        state.online = true;
        state.sourceReady = true;
        state.syncOk = true;
        state.lastError = undefined;
      } else {
        state.sendMode = 0;
        state.online = false;
        state.sourceReady = false;
        state.syncOk = false;
        state.lastError = error?.message || String(error);
      }
      state.lastUpdate = Date.now();
      this.units.set(unit.index, state);
      return false;
    } finally {
      if (this.broadcastModeRequestInFlight.get(unit.index) === client) {
        this.broadcastModeRequestInFlight.delete(unit.index);
      }

      // Critical field fix: only command failures/no-ACK use the short exponential
      // retry loop. ACK means the detector is already transitioning into push mode;
      // touching FF again before the waveform watchdog expires can restart it.
      if (
        !acknowledged
        && this.waveformStreamingArmed
        && this.broadcastModeRequestingUnits.has(unit.index)
        && this.isCurrentClient(unit, client)
      ) {
        this.scheduleBroadcastModeRetry(unit, client);
      }
      this.emit('unit_update', state);
    }
  };

  console.log('[FlameService] 已启用现场波形启动策略：ACK 后等待首帧，超时再重切模式。');
}

installPolicy();
