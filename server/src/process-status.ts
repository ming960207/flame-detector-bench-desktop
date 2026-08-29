export type PLCProcessStage = 'IDLE' | 'INIT' | 'HEAT' | 'FLASH' | 'EMC' | 'RETURN_HOME' | 'COMPLETE' | 'FAULT' | 'UNKNOWN';
export type PLCProcessCurrentStage = Exclude<PLCProcessStage, 'FAULT'>;
export type PLCHeatSubstage = 'IDLE' | 'POSITIONING' | 'SIGNAL_STABILIZATION' | 'NOISE_CAPTURE' | 'HEAT_INTERFERENCE';

export const PLC_HEAT_SUBSTAGE_LABELS: Record<PLCHeatSubstage, string> = {
  IDLE: '非热源阶段',
  POSITIONING: '热源定位/阶段过渡',
  SIGNAL_STABILIZATION: '信号稳定阶段',
  NOISE_CAPTURE: '噪声采集阶段',
  HEAT_INTERFERENCE: '热源干扰采集阶段',
};

export interface PLCProcessIO {
  inputs: Record<string, boolean>;
  outputs: Record<string, boolean>;
  internal: Record<string, boolean>;
  steps: Record<string, boolean>;
  syncedAt: number;
}

export interface PLCProcessRegisters {
  stageCode: number;
  stepCode: number;
  autoRunning: boolean;
  complete: boolean;
  alarm: boolean;
  returningHome: boolean;
  timestamp: number;
  io?: PLCProcessIO;
}

export interface PLCProcessStatus extends PLCProcessRegisters {
  stage: PLCProcessStage;
  label: string;
  processStage: PLCProcessCurrentStage;
  processLabel: string;
  heatSubstage: PLCHeatSubstage;
  heatSubstageLabel: string;
  valid: boolean;
  reason?: string;
}

export type PLCProcessCompletionState = Partial<Pick<
  PLCProcessStatus,
  'stage' | 'processStage' | 'complete' | 'alarm' | 'io'
>>;

/** Completion is authoritative even when an older producer still wraps it as FAULT. */
export function isPLCProcessComplete(status: PLCProcessCompletionState | null | undefined): boolean {
  return Boolean(
    status?.complete
    || status?.stage === 'COMPLETE'
    || status?.processStage === 'COMPLETE'
    || status?.io?.internal?.complete,
  );
}

/** Post-run alarm/stop bits must not turn a completed inspection back into an abort. */
export function hasActivePLCProcessAlarm(status: PLCProcessCompletionState | null | undefined): boolean {
  return Boolean(status?.alarm) && !isPLCProcessComplete(status);
}

interface DecodedProcessStage {
  stage: PLCProcessCurrentStage;
  label: string;
  valid: boolean;
  reason?: string;
}

function decodeCurrentProcessStage(registers: PLCProcessRegisters): DecodedProcessStage {
  if (registers.complete && registers.stageCode === 0 && registers.stepCode === 0) {
    return { stage: 'COMPLETE', label: '已完成', valid: true };
  }
  if (!registers.autoRunning && registers.stageCode === 0 && registers.stepCode === 0) {
    return { stage: 'IDLE', label: '待机', valid: true };
  }
  // M11.4 remains authoritative while the PLC retracts from the EMC position.
  // During the observed return-home transition VW600/VW602 can briefly rebound
  // to the heat codes (2/2 or 2/3), which must not reopen the heat analysis.
  if (registers.returningHome && (registers.stageCode === 1 || registers.stageCode === 2)) {
    return { stage: 'RETURN_HOME', label: '回初始位确认', valid: true };
  }
  if (registers.stageCode === 1 && registers.stepCode === 1) {
    return { stage: 'INIT', label: '初始化', valid: true };
  }
  if (registers.stageCode === 2 && (registers.stepCode === 2 || registers.stepCode === 3)) {
    return { stage: 'HEAT', label: '移动热源', valid: true };
  }
  if (registers.stageCode === 3 && registers.stepCode === 3) {
    return { stage: 'FLASH', label: '爆闪干扰', valid: true };
  }
  if (registers.stageCode === 4 && registers.stepCode === 3) {
    return { stage: 'EMC', label: '电磁干扰', valid: true };
  }
  return {
    stage: 'UNKNOWN',
    label: '未知工序码',
    valid: false,
    reason: `不支持的工序码 VW600=${registers.stageCode}, VW602=${registers.stepCode}`,
  };
}

function decodeHeatSubstage(registers: PLCProcessRegisters, processStage: PLCProcessCurrentStage): PLCHeatSubstage {
  if (processStage !== 'HEAT') return 'IDLE';
  if (registers.io?.steps?.stepM10_4 === true) return 'HEAT_INTERFERENCE';
  if (registers.io?.internal?.noiseCaptureWindow === true) return 'NOISE_CAPTURE';
  if (registers.io?.internal?.signalStabilizing === true) return 'SIGNAL_STABILIZATION';
  return 'POSITIONING';
}

/**
 * Decodes the read-only PLC process registers defined in plc-hmi-upper-contract.json.
 * VW600/VW602 can overlap during the post-EMC retract, so M11.4 is required to
 * distinguish the return-home sequence from initialisation and transient heat codes.
 */
export function decodePLCProcessStatus(registers: PLCProcessRegisters): PLCProcessStatus {
  const base = { ...registers };
  const process = decodeCurrentProcessStage(registers);
  const heatSubstage = decodeHeatSubstage(registers, process.stage);
  // M0.1 is latched by the PLC when a run finishes. The normal post-run
  // stop/safety state can therefore coexist with COMPLETE; do not turn an
  // already completed batch back into FAULT and suppress its final verdict.
  if (registers.alarm && !isPLCProcessComplete({ ...registers, processStage: process.stage })) {
    return {
      ...base,
      stage: 'FAULT',
      label: '故障/中止',
      processStage: process.stage,
      processLabel: process.label,
      heatSubstage,
      heatSubstageLabel: PLC_HEAT_SUBSTAGE_LABELS[heatSubstage],
      valid: true,
    };
  }
  return {
    ...base,
    ...process,
    processStage: process.stage,
    processLabel: process.label,
    heatSubstage,
    heatSubstageLabel: PLC_HEAT_SUBSTAGE_LABELS[heatSubstage],
  };
}
