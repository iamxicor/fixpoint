import type { ScenarioStep } from './config.js';

export interface DefaultScenarioOptions {
  settleMs?: number;
  scrollAmount?: number;
  scrollPauseMs?: number;
  /** Whether to add the final back() step. */
  back?: boolean;
}

/** wait for the first commit to settle, scroll the main list once, come back. */
export function defaultScenario(opts: DefaultScenarioOptions = {}): ScenarioStep[] {
  const steps: ScenarioStep[] = [
    { type: 'wait', ms: opts.settleMs ?? 1500 },
    { type: 'scroll', direction: 'down', amount: opts.scrollAmount ?? 600 },
    { type: 'wait', ms: opts.scrollPauseMs ?? 600 },
  ];
  if (opts.back ?? true) steps.push({ type: 'back' });
  return steps;
}

export const READ_ONLY_STEP_TYPES = new Set(['wait', 'scroll', 'tap', 'back', 'navigate']);

/** Scenario steps are read-only by construction: this rejects anything that is not one of the known step types. */
export function validateScenario(steps: unknown): ScenarioStep[] {
  if (!Array.isArray(steps)) throw new Error('scenario must be an array of steps');
  for (const s of steps) {
    if (!s || typeof s !== 'object' || !READ_ONLY_STEP_TYPES.has((s as any).type)) throw new Error(`invalid scenario step: ${JSON.stringify(s)}`);
    if ((s as any).type === 'wait' && !(Number((s as any).ms) >= 0)) throw new Error('wait step needs ms');
    if ((s as any).type === 'scroll' && !['down', 'up'].includes((s as any).direction)) throw new Error('scroll step needs direction down|up');
    if ((s as any).type === 'tap' && !(s as any).testID && !(s as any).label) throw new Error('tap step needs testID or label');
    if ((s as any).type === 'navigate' && typeof (s as any).href !== 'string') throw new Error('navigate step needs href');
  }
  return steps as ScenarioStep[];
}

export function describeScenario(steps: ScenarioStep[]): string {
  return steps
    .map((s) => {
      switch (s.type) {
        case 'wait':
          return `wait ${s.ms}ms`;
        case 'scroll':
          return `scroll ${s.direction} ${s.amount}`;
        case 'tap':
          return `tap ${s.testID ?? s.label}`;
        case 'back':
          return 'back';
        case 'navigate':
          return `navigate ${s.href}`;
      }
    })
    .join(' → ');
}
