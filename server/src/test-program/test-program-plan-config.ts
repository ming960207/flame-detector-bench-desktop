import {
  DEFAULT_TEST_PROGRAM_STAGE_PLAN,
  type TestProgramStageDefinition,
  type TestProgramStageId,
} from './test-program-types.js';

export type TestProgramPlanSource = 'DEFAULT' | 'PLC_REFERENCE' | 'LOCAL_OVERRIDE';

export interface TestProgramPLCStep {
  id: string;
  name: string;
  durationMs: number | null;
  waitTimeMs: number | null;
  totalDurationMs: number | null;
}

export interface TestProgramConfigPayload {
  mode: 'test-program-readonly-observer';
  source: string;
  plan: TestProgramStageDefinition[];
  planSource: TestProgramPlanSource;
  planUpdatedAt: number | null;
  plcSteps: TestProgramPLCStep[];
  plcConfigUpdatedAt: number | null;
  note: string;
}

const MAX_STAGE_DURATION_MS = 24 * 60 * 60 * 1_000;

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function secondsToMs(value: unknown): number | null {
  const seconds = numeric(value);
  return seconds === null ? null : Math.round(seconds * 1_000);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizePLCSteps(rawSteps: unknown): TestProgramPLCStep[] {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const id = String(item.id ?? item.key ?? `step-${index + 1}`).trim();
    const name = String(item.name ?? item.label ?? item.description ?? id).trim();
    if (!id || !name) return [];
    const durationMs = secondsToMs(item.duration ?? item.durationSeconds);
    const waitTimeMs = secondsToMs(item.waitTime ?? item.waitTimeSeconds);
    return [{
      id,
      name,
      durationMs,
      waitTimeMs,
      totalDurationMs: durationMs === null && waitTimeMs === null
        ? null
        : (durationMs ?? 0) + (waitTimeMs ?? 0),
    } satisfies TestProgramPLCStep];
  });
}

function stepMatches(step: TestProgramPLCStep, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => step.name.includes(keyword));
}

function matchedDuration(steps: readonly TestProgramPLCStep[], keywords: readonly string[]): { durationMs: number; basis: string } | null {
  const matches = steps.filter((step) => stepMatches(step, keywords) && step.totalDurationMs !== null);
  if (matches.length === 0) return null;
  const durationMs = matches.reduce((sum, step) => sum + (step.totalDurationMs ?? 0), 0);
  const basis = matches
    .map((step) => `${step.id} ${step.name} ${((step.totalDurationMs ?? 0) / 1_000).toFixed(2)} 秒`)
    .join(' + ');
  return { durationMs, basis };
}

/**
 * Only map unambiguous PLC step names. A broad PLC step is not silently split
 * into the three heat substages; those remain editable in the test observer.
 */
export function derivePlanFromPLCSteps(steps: readonly TestProgramPLCStep[]): TestProgramStageDefinition[] {
  const plan = DEFAULT_TEST_PROGRAM_STAGE_PLAN.map((stage) => ({ ...stage }));
  const mappings: Array<{ id: TestProgramStageId; keywords: readonly string[] }> = [
    { id: 'INIT', keywords: ['开始测试'] },
    { id: 'HEAT_POSITIONING', keywords: ['电机运转', '识别到达检测位'] },
    { id: 'HEAT_INTERFERENCE', keywords: ['热源干扰', '火焰响应'] },
    { id: 'RETURN_HOME', keywords: ['电机复位', '复位'] },
    { id: 'COMPLETE', keywords: ['结束测试'] },
  ];
  for (const mapping of mappings) {
    const match = matchedDuration(steps, mapping.keywords);
    if (!match) continue;
    const stage = plan.find((item) => item.id === mapping.id);
    if (!stage) continue;
    stage.plannedDurationMs = match.durationMs;
    stage.planBasis = `PLC 当前步骤参考：${match.basis}`;
  }
  return plan;
}

export function normalizeStagePlan(rawPlan: unknown): TestProgramStageDefinition[] {
  if (!Array.isArray(rawPlan)) throw new Error('TEST_PROGRAM_PLAN_MUST_BE_ARRAY');
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of rawPlan) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = String(item.id ?? '').trim();
    if (id) byId.set(id, item);
  }
  const missing = DEFAULT_TEST_PROGRAM_STAGE_PLAN.filter((stage) => !byId.has(stage.id));
  if (missing.length > 0) throw new Error(`TEST_PROGRAM_PLAN_STAGE_MISSING:${missing.map((stage) => stage.id).join(',')}`);
  return DEFAULT_TEST_PROGRAM_STAGE_PLAN.map((definition) => {
    const item = byId.get(definition.id) as Record<string, unknown>;
    const plannedDurationMs = item.plannedDurationMs === null || item.plannedDurationMs === ''
      ? null
      : numeric(item.plannedDurationMs);
    if (plannedDurationMs !== null && plannedDurationMs > MAX_STAGE_DURATION_MS) {
      throw new Error(`TEST_PROGRAM_PLAN_DURATION_TOO_LARGE:${definition.id}`);
    }
    if (item.plannedDurationMs !== null && item.plannedDurationMs !== '' && plannedDurationMs === null) {
      throw new Error(`TEST_PROGRAM_PLAN_DURATION_INVALID:${definition.id}`);
    }
    return {
      ...definition,
      plannedDurationMs,
      planBasis: typeof item.planBasis === 'string' && item.planBasis.trim()
        ? item.planBasis.trim()
        : definition.planBasis,
    } satisfies TestProgramStageDefinition;
  });
}

export function clonePlan(plan: readonly TestProgramStageDefinition[]): TestProgramStageDefinition[] {
  return Array.from(clone(plan));
}
