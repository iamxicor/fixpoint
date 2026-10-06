import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DETERMINISTIC_METRICS, type DeterministicMetric, type VisitMetrics } from './metrics.js';

export interface Baseline {
  version: 1;
  generatedAt: string;
  label: 'dev build, iOS Simulator';
  routes: Record<string, Pick<VisitMetrics, DeterministicMetric>>;
}

export function writeBaseline(file: string, routes: Record<string, VisitMetrics>): Baseline {
  const out: Baseline = { version: 1, generatedAt: new Date().toISOString(), label: 'dev build, iOS Simulator', routes: {} };
  for (const [route, m] of Object.entries(routes)) {
    out.routes[route] = { componentRenders: m.componentRenders, avoidableRenders: m.avoidableRenders, commits: m.commits, maxComponentsPerCommit: m.maxComponentsPerCommit };
  }
  writeFileSync(file, JSON.stringify(out, null, 2));
  return out;
}

export interface BaselineRegression {
  route: string;
  metric: DeterministicMetric;
  baseline: number;
  current: number;
}

/** Deterministic metrics are compared exactly; any increase is a regression. */
export function compareBaseline(file: string, current: Record<string, VisitMetrics>, tolerance = 0): { ok: boolean; regressions: BaselineRegression[]; missing: string[] } {
  if (!existsSync(file)) return { ok: true, regressions: [], missing: Object.keys(current) };
  const base = JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  const regressions: BaselineRegression[] = [];
  const missing: string[] = [];
  for (const [route, m] of Object.entries(current)) {
    const b = base.routes[route];
    if (!b) {
      missing.push(route);
      continue;
    }
    for (const metric of DETERMINISTIC_METRICS) if (m[metric] > b[metric] + tolerance) regressions.push({ route, metric, baseline: b[metric], current: m[metric] });
  }
  return { ok: regressions.length === 0, regressions, missing };
}
