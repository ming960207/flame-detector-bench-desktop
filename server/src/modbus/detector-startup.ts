import type { FlameSample } from '../types.js';

export const DETECTOR_STARTUP_FRAME_STREAK_REQUIRED = 5;

export type DetectorStartupState =
  | 'DISCONNECTED'
  | 'POWER_ON'
  | 'COMMUNICATION_READY'
  | 'MODE_SWITCHING'
  | 'MODE_SWITCH_OK'
  | 'FIRST_FRAME_RECEIVED'
  | 'CHANNEL_SYNC_OK'
  | 'TEST_READY'
  | 'FAILED';

export interface DetectorStartupDiagnostic {
  state: DetectorStartupState;
  index: number;
  address: number;
  powerOnAt: number | null;
  communicationReadyAt: number | null;
  modeSwitchStartedAt: number | null;
  modeSwitchOkAt: number | null;
  firstFrameAt: number | null;
  firstValidSampleAt: number | null;
  channelFirstValidAt: Partial<Record<keyof FlameSample, number>>;
  channelSyncAt: number | null;
  testReadyAt: number | null;
  modeSwitchAttempts: number;
  channelValidStreak: number;
  requiredChannelCount: number;
  failureReason?: string;
}

const REQUIRED_CHANNEL_KEYS: Array<keyof FlameSample> = ['probe1', 'probe2', 'probe3'];

function timestamp(now: () => number): number {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function validSample(sample: FlameSample | undefined, requiredChannelCount: number): boolean {
  if (!sample) return false;
  const keys: Array<keyof FlameSample> = requiredChannelCount >= 4
    ? [...REQUIRED_CHANNEL_KEYS, 'probe4']
    : REQUIRED_CHANNEL_KEYS;
  return keys.every((key) => Number.isFinite(Number(sample[key])));
}

export class DetectorStartupTracker {
  private diagnostic: DetectorStartupDiagnostic;
  private readonly now: () => number;

  constructor(index: number, address: number, now: () => number = Date.now) {
    this.now = now;
    this.diagnostic = {
      state: 'DISCONNECTED',
      index,
      address,
      powerOnAt: null,
      communicationReadyAt: null,
      modeSwitchStartedAt: null,
      modeSwitchOkAt: null,
      firstFrameAt: null,
      firstValidSampleAt: null,
      channelFirstValidAt: {},
      channelSyncAt: null,
      testReadyAt: null,
      modeSwitchAttempts: 0,
      channelValidStreak: 0,
      requiredChannelCount: 3,
    };
  }

  reset(address = this.diagnostic.address): DetectorStartupDiagnostic {
    const { index } = this.diagnostic;
    this.diagnostic = {
      state: 'DISCONNECTED',
      index,
      address,
      powerOnAt: null,
      communicationReadyAt: null,
      modeSwitchStartedAt: null,
      modeSwitchOkAt: null,
      firstFrameAt: null,
      firstValidSampleAt: null,
      channelFirstValidAt: {},
      channelSyncAt: null,
      testReadyAt: null,
      modeSwitchAttempts: 0,
      channelValidStreak: 0,
      requiredChannelCount: 3,
    };
    return this.snapshot();
  }

  markPowerOn(): DetectorStartupDiagnostic {
    if (this.diagnostic.powerOnAt === null) this.diagnostic.powerOnAt = timestamp(this.now);
    this.diagnostic.state = 'POWER_ON';
    return this.snapshot();
  }

  markCommunicationReady(): DetectorStartupDiagnostic {
    if (this.diagnostic.powerOnAt === null) this.markPowerOn();
    if (this.diagnostic.communicationReadyAt === null) this.diagnostic.communicationReadyAt = timestamp(this.now);
    if (this.diagnostic.state === 'DISCONNECTED' || this.diagnostic.state === 'POWER_ON') this.diagnostic.state = 'COMMUNICATION_READY';
    return this.snapshot();
  }

  markModeSwitching(attempt: number): DetectorStartupDiagnostic {
    if (this.diagnostic.communicationReadyAt === null) this.markCommunicationReady();
    if (this.diagnostic.modeSwitchStartedAt === null) this.diagnostic.modeSwitchStartedAt = timestamp(this.now);
    this.diagnostic.modeSwitchAttempts = Math.max(this.diagnostic.modeSwitchAttempts, Math.max(0, Math.floor(attempt)));
    if (this.diagnostic.state !== 'FAILED' && this.diagnostic.state !== 'TEST_READY') this.diagnostic.state = 'MODE_SWITCHING';
    return this.snapshot();
  }

  markModeSwitchOk(): DetectorStartupDiagnostic {
    if (this.diagnostic.modeSwitchStartedAt === null) this.markModeSwitching(this.diagnostic.modeSwitchAttempts || 1);
    this.diagnostic.modeSwitchOkAt ??= timestamp(this.now);
    if (this.diagnostic.state !== 'FAILED') {
      if (this.diagnostic.channelValidStreak >= DETECTOR_STARTUP_FRAME_STREAK_REQUIRED) {
        this.diagnostic.channelSyncAt ??= timestamp(this.now);
        this.diagnostic.testReadyAt ??= timestamp(this.now);
        this.diagnostic.state = 'TEST_READY';
      } else {
        this.diagnostic.state = 'MODE_SWITCH_OK';
      }
    }
    return this.snapshot();
  }

  markModeSwitchFailure(reason: string): DetectorStartupDiagnostic {
    this.diagnostic.failureReason = reason;
    this.diagnostic.state = 'FAILED';
    return this.snapshot();
  }

  markTimeout(reason = 'DETECTOR_STARTUP_TIMEOUT'): DetectorStartupDiagnostic {
    return this.markModeSwitchFailure(reason);
  }

  observeFrame(samples: FlameSample[], requiredChannelCount = 3): DetectorStartupDiagnostic {
    this.diagnostic.requiredChannelCount = requiredChannelCount >= 4 ? 4 : 3;
    if (this.diagnostic.firstFrameAt === null && samples.length > 0) {
      this.diagnostic.firstFrameAt = timestamp(this.now);
      if (this.diagnostic.state !== 'FAILED') this.diagnostic.state = 'FIRST_FRAME_RECEIVED';
    }
    const sample = samples.at(-1);
    for (const key of [...REQUIRED_CHANNEL_KEYS, ...(this.diagnostic.requiredChannelCount >= 4 ? ['probe4' as const] : [])]) {
      if (this.diagnostic.channelFirstValidAt[key] === undefined && Number.isFinite(Number(sample?.[key]))) {
        this.diagnostic.channelFirstValidAt[key] = timestamp(this.now);
      }
    }
    if (validSample(sample, this.diagnostic.requiredChannelCount)) {
      if (this.diagnostic.firstValidSampleAt === null) this.diagnostic.firstValidSampleAt = timestamp(this.now);
      this.diagnostic.channelValidStreak += 1;
      if (this.diagnostic.channelValidStreak >= DETECTOR_STARTUP_FRAME_STREAK_REQUIRED) {
        if (this.diagnostic.channelSyncAt === null) this.diagnostic.channelSyncAt = timestamp(this.now);
        if (this.diagnostic.modeSwitchOkAt !== null) {
          if (this.diagnostic.testReadyAt === null) this.diagnostic.testReadyAt = timestamp(this.now);
          if (this.diagnostic.state !== 'FAILED') this.diagnostic.state = 'TEST_READY';
        } else if (this.diagnostic.state !== 'FAILED') {
          this.diagnostic.state = 'FIRST_FRAME_RECEIVED';
        }
      } else if (this.diagnostic.state !== 'FAILED') {
        this.diagnostic.state = 'FIRST_FRAME_RECEIVED';
      }
    } else {
      this.diagnostic.channelValidStreak = 0;
      if (this.diagnostic.state !== 'FAILED' && this.diagnostic.firstFrameAt !== null) {
        this.diagnostic.state = 'FIRST_FRAME_RECEIVED';
      }
    }
    return this.snapshot();
  }

  isReady(): boolean {
    return this.diagnostic.state === 'TEST_READY';
  }

  snapshot(): DetectorStartupDiagnostic {
    return { ...this.diagnostic, channelFirstValidAt: { ...this.diagnostic.channelFirstValidAt } };
  }
}
