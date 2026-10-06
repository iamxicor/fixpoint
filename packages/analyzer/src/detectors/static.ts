import { aggregateSnapshot, diffAggregates } from '../heap/parse.js';
import type { Finding } from '../types.js';
import { findingId, plural, round, scoreFor, severityFor, type Detector } from './context.js';

function packageOf(modulePath: string): string | null {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(modulePath);
  return m ? m[1]! : null;
}

const ROUTE_FILE = /^app\/(.+)\.(tsx?|jsx?)$/;
const isRouteModule = (p: string) => {
  const m = ROUTE_FILE.exec(p);
  if (!m) return false;
  const name = m[1]!.split('/').pop()!;
  return !name.startsWith('_layout') && !name.startsWith('+') && !/^(?:index\.)?(test|spec)$/.test(name);
};

/** startup-critical-path: modules initialised before the first screen was ready. */
export const startupCriticalPath: Detector = async (ctx) => {
  const s = ctx.input.startup;
  if (!s) return [];
  const mods = s.modulesInitialized;
  const total = mods.length;
  const byPkg = new Map<string, number>();
  let appModules = 0;
  for (const m of mods) {
    const pkg = packageOf(m);
    if (pkg) byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + 1);
    else appModules++;
  }
  const topPkgs = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const out: Finding[] = [];
  const severity = severityFor(total, 500, 1500, 3000) ?? 'low';
  const timing = s.rnStartupTiming ?? null;
  const bundleMs = timing && timing.executeJavaScriptBundleEntryPointStart != null && timing.endTime != null ? round(timing.endTime - timing.executeJavaScriptBundleEntryPointStart) : null;
  out.push({
    id: findingId('startup-critical-path', 'modules'),
    kind: 'startup-critical-path',
    severity,
    score: scoreFor(severity, total, true),
    metric: {
      name: 'modulesInitializedBeforeFirstScreen',
      value: total,
      unit: 'count',
      deterministic: true,
      method: 'Metro module registry entries with isInitialized=true when the first route reported ready',
      secondary: [
        { name: 'appModules', value: appModules, unit: 'count', deterministic: true },
        { name: 'nodeModulesPackages', value: byPkg.size, unit: 'count', deterministic: true },
        ...(bundleMs != null ? [{ name: 'bundleEntryToEndMs', value: bundleMs, unit: 'ms' as const, deterministic: false }] : []),
      ],
    },
    evidence: { frames: [], components: [], commits: [], extra: { topPackages: Object.fromEntries(topPkgs), rnStartupTiming: timing, firstRoute: s.firstRoute ?? null } },
    location: { file: s.firstRouteModule ?? null, line: null, column: null, symbol: s.firstRoute ?? 'startup' },
    suggestedFixes: ['lazy-require'],
    summary: `${total} modules were initialised before the first screen (${s.firstRoute ?? 'unknown route'}) was ready: ${appModules} from the app and ${total - appModules} from ${byPkg.size} packages. Largest packages: ${topPkgs.slice(0, 5).map(([p, n]) => `${p} (${n})`).join(', ')}. Each module initialised here runs its top-level code on the startup critical path.`,
  });
  const eager = mods.filter((m) => isRouteModule(m) && m !== s.firstRouteModule);
  if (eager.length > 0) {
    const sev = severityFor(eager.length, 1, 5, 20)!;
    out.push({
      id: findingId('startup-critical-path', 'eager-routes'),
      kind: 'startup-critical-path',
      severity: sev,
      score: scoreFor(sev, eager.length, true),
      metric: { name: 'routeModulesInitializedEagerly', value: eager.length, unit: 'count', deterministic: true, method: 'route files under app/ (excluding layouts) initialised before the first screen, other than the first route itself' },
      evidence: { frames: [], components: [], commits: [], extra: { routes: eager.slice(0, 40) } },
      location: { file: eager[0] ?? null, line: null, column: null, symbol: 'routes' },
      suggestedFixes: ['lazy-require'],
      summary: `${plural(eager.length, 'route module')} other than the first screen ran at startup (for example ${eager.slice(0, 3).join(', ')}). Routes that are imported eagerly from layouts or shared modules pay their initialisation cost on every cold start.`,
    });
  }
  return out;
};

/** heap-growth: retained objects by constructor after navigate-and-back cycles. */
export const heapGrowth: Detector = async (ctx) => {
  const h = ctx.input.heap;
  if (!h) return [];
  const before = aggregateSnapshot(h.before);
  const after = aggregateSnapshot(h.after);
  const rows = diffAggregates(before, after).filter((r) => ['object', 'closure', 'array', 'native', 'string'].includes(r.type));
  const cycles = Math.max(1, h.cycles);
  const min = Math.max(ctx.thresholds.heapGrowthMinObjects, cycles);
  const out: Finding[] = [];
  for (const r of rows.filter((x) => x.delta >= min).slice(0, 8)) {
    const perCycle = round(r.delta / cycles, 1);
    const severity = severityFor(r.bytesDelta, 50_000, 500_000, 5_000_000) ?? severityFor(r.delta, min, min * 10, min * 100) ?? 'low';
    const sym = r.constructor || `(${r.type})`;
    out.push({
      id: findingId('heap-growth', r.type, r.constructor),
      kind: 'heap-growth',
      severity,
      score: scoreFor(severity, r.bytesDelta, true),
      metric: {
        name: 'retainedObjectsPerCycle',
        value: perCycle,
        unit: 'count',
        deterministic: true,
        method: `heap snapshot node count by constructor, after minus before, divided by ${cycles} navigate-and-back cycles (GC forced before each snapshot)`,
        secondary: [
          { name: 'objectsDelta', value: r.delta, unit: 'count', deterministic: true },
          { name: 'bytesDelta', value: r.bytesDelta, unit: 'bytes', deterministic: true },
          { name: 'countBefore', value: r.countBefore, unit: 'count', deterministic: true },
          { name: 'countAfter', value: r.countAfter, unit: 'count', deterministic: true },
        ],
      },
      evidence: { frames: [], components: [], commits: [], extra: { type: r.type, totalNodesBefore: before.nodeCount, totalNodesAfter: after.nodeCount } },
      location: { ...(ctx.input.componentLocations?.[sym] ?? { file: null, line: null, column: null }), symbol: sym },
      suggestedFixes: ['subscription-cleanup'],
      summary: `${r.delta} more ${sym} ${r.type === 'closure' ? 'closures' : 'objects'} (${round(r.bytesDelta / 1024)} KiB) survived a forced GC after ${plural(cycles, 'navigate-and-back cycle')}, about ${perCycle} per cycle. Objects that accumulate with every visit usually come from listeners, timers or subscriptions that are not removed on unmount.`,
    });
  }
  return out;
};

/** compiler-bailout: components the React Compiler skipped, cross-referenced with render findings. */
export const compilerBailout = (relatedNames: Set<string>): Detector => async (ctx) => {
  const c = ctx.input.compiler;
  if (!c) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const b of c.bailouts) {
    const key = `${b.file}:${b.line ?? ''}:${b.fn ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const related = !!b.fn && relatedNames.has(b.fn);
    const severity = related ? 'medium' : 'low';
    out.push({
      id: findingId('compiler-bailout', b.file, b.line, b.fn),
      kind: 'compiler-bailout',
      severity,
      score: scoreFor(severity, related ? 10 : 1, true),
      metric: { name: 'skippedFunctions', value: 1, unit: 'count', deterministic: true, method: 'babel-plugin-react-compiler CompileError events collected by running the compiler over the app source' },
      evidence: { frames: [], components: related ? [{ name: b.fn!, renders: 0, selfMs: 0 }] : [], commits: [], extra: { reason: b.reason, detail: b.detail ?? null, relatedToRenderFinding: related } },
      location: { file: b.file, line: b.line, column: b.column, symbol: b.fn ?? 'unknown' },
      suggestedFixes: ['remove-compiler-bailout', 'hoist-literals'],
      summary: `The React Compiler skipped ${b.fn ?? 'a function'} in ${b.file}${b.line ? `:${b.line}` : ''}: ${b.detail ?? b.reason}. ${related ? 'This component also appears in a render finding in this scan, so it re-renders without any memoisation.' : 'Without compilation none of its inline values or callbacks are memoised.'}`,
    });
  }
  return out;
};
