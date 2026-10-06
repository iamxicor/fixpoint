import type { TraceFile } from '@fixpoint/devtools';
import { buildModel, busyUs } from '@fixpoint/analyzer';

/** Per-visit metrics the A/B compares. Counts are deterministic; times are not. */
export interface VisitMetrics {
  componentRenders: number;
  avoidableRenders: number;
  commits: number;
  maxComponentsPerCommit: number;
  /** Σ Render + Commit + Remaining Effects phase durations (ms). The cheapest honest JS time metric. */
  renderMs: number;
  /** Non-idle sampling time (ms); only present for full-trace visits. */
  jsBusyMs: number | null;
  /** Wall time from the first mark to the last (ms). */
  scenarioMs: number;
}

export const DETERMINISTIC_METRICS = ['componentRenders', 'avoidableRenders', 'commits', 'maxComponentsPerCommit'] as const;
export const TIME_METRICS = ['renderMs', 'scenarioMs'] as const;
export type DeterministicMetric = (typeof DETERMINISTIC_METRICS)[number];
export type TimeMetric = (typeof TIME_METRICS)[number];

export function visitMetrics(trace: TraceFile): VisitMetrics {
  const m = buildModel(trace);
  const renders = m.renders.filter((r) => r.kind === 'render' || r.kind === 'changed-props');
  const marks = ((trace.metadata as any)?.marks ?? []) as { at: number }[];
  let renderUs = 0;
  let maxPerCommit = 0;
  for (const c of m.commits) {
    renderUs += c.renderEndUs - c.renderStartUs + (c.commitEndUs - c.commitStartUs) + (c.effectsEndUs ? Math.max(0, c.effectsEndUs - c.commitEndUs) : 0);
    maxPerCommit = Math.max(maxPerCommit, c.components.filter((r) => r.kind === 'render' || r.kind === 'changed-props').length);
  }
  return {
    componentRenders: renders.length,
    avoidableRenders: renders.filter((r) => r.diff && (r.diff.deepEqualOnly || r.diff.callbackOnly)).length,
    commits: m.commits.length,
    maxComponentsPerCommit: maxPerCommit,
    renderMs: Math.round(renderUs / 100) / 10,
    jsBusyMs: m.samples ? Math.round(busyUs(m.samples) / 100) / 10 : null,
    scenarioMs: marks.length >= 2 ? marks[marks.length - 1]!.at - marks[0]!.at : Math.round(m.durationMs),
  };
}
