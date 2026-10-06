import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TraceFile } from '@fixpoint/devtools';
import { analyze } from './analyze.js';
import { buildModel } from './trace/model.js';
import { aggregateFromText, diffAggregates } from './heap/parse.js';
import { renderTable } from './report.js';
import { displayName, routeFileFromName } from './detectors/context.js';
import type { FindingKind } from './types.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');
const tabsTrace = JSON.parse(read('fixtures/phase0/trace-tabs-scroll-ios-sim.json')) as TraceFile;
const notificationsTrace = JSON.parse(read('fixtures/phase0/trace-notifications-ios-sim.json')) as TraceFile;
const startup = JSON.parse(read('fixtures/synthetic/startup-capture.json'));
const compiler = JSON.parse(read('fixtures/synthetic/compiler-bailouts.json'));
const heapBefore = read('fixtures/synthetic/heap-before.heapsnapshot');
const heapAfter = read('fixtures/synthetic/heap-after.heapsnapshot');

describe('trace model (real recordings)', () => {
  it('reconstructs commits, component renders, triggers and the scroll window from the tabs trace', () => {
    const m = buildModel(tabsTrace);
    expect(m.commits.length).toBe(53);
    const renders = m.renders.filter((r) => r.kind === 'render' || r.kind === 'changed-props');
    expect(renders.length).toBe(3342);
    expect(renders.filter((r) => r.commit >= 0).length / renders.length).toBeGreaterThan(0.95);
    const withDiff = renders.filter((r) => r.diff);
    expect(withDiff.length).toBe(3136);
    expect(m.updates.filter((u) => u.cascading).length).toBe(11);
    expect(m.samples?.samples.length).toBeGreaterThan(5000);
    expect(m.windows.map((w) => w.label)).toEqual(['start', 'timelines', 'after-scroll-window', 'notifications', 'back']);
    const big = m.commits.reduce((a, b) => (b.components.length > a.components.length ? b : a));
    expect(displayName(big.root!.name)).toBe('MelementsNotificationsScreen');
    expect(big.triggers.length).toBeGreaterThan(0);
  });

  it('reads the setState stack behind the 1 Hz update in the notifications trace', () => {
    const m = buildModel(notificationsTrace);
    expect(m.commits.length).toBe(4);
    const ticks = m.updates.filter((u) => u.component === 'ProfileShopMenuOption');
    expect(ticks.length).toBe(3);
    expect(ticks[0]?.stack.map((f) => f.functionName)).toEqual(['startUpdateTimerByLane', 'dispatchSetState', 'tick']);
  });

  it('parses Expo Router component names with nested parentheses', () => {
    const name = 'MelementsNotificationsScreen(./(authenticated)/(tabs)/notifications/index.tsx)';
    expect(displayName(name)).toBe('MelementsNotificationsScreen');
    expect(routeFileFromName(name)).toBe('app/(authenticated)/(tabs)/notifications/index.tsx');
    expect(routeFileFromName('Pressable')).toBeNull();
  });
});

describe('analyze', () => {
  it('produces ranked deterministic findings from the tabs trace without network or symbolication', async () => {
    const out = await analyze({ trace: tabsTrace, context: { route: '/timelines', scenario: 'tabs-scroll' } });
    expect(out.totals).toMatchObject({ commits: 53, componentRenders: 3342, wastedRenders: 499 });
    const kinds = new Set(out.findings.map((f) => f.kind));
    expect([...kinds].sort()).toEqual(['frame-drop', 'hot-component', 'long-task', 'render-fanout', 'wasted-render']);
    const top = out.findings[0]!;
    expect(top.kind).toBe('render-fanout');
    expect(top.metric).toMatchObject({ name: 'componentsPerCommit', value: 628, deterministic: true });
    expect(top.location.file).toBe('app/(authenticated)/(tabs)/notifications/index.tsx');
    const cell = out.findings.find((f) => f.kind === 'wasted-render' && f.evidence.components[0]?.name === 'CellRenderer')!;
    expect(cell.metric.value).toBe(60);
    expect(cell.suggestedFixes).toContain('stable-row-props');
    const cascading = out.findings.find((f) => f.metric.name === 'cascadingUpdates')!;
    expect(cascading.metric.value).toBe(7);
    expect(cascading.suggestedFixes).toContain('remove-redundant-effect');
    for (const f of out.findings) {
      expect(f.id).toMatch(/^[a-z-]+:[a-z0-9-]+:[0-9a-f]{8}$/);
      expect(f.summary.length).toBeGreaterThan(40);
      expect(f.score).toBeGreaterThan(0);
    }
    expect(out.findings.map((f) => f.score)).toEqual([...out.findings.map((f) => f.score)].sort((a, b) => b - a));
    expect(out.notes.some((n) => /RunTask/.test(n))).toBe(true);
    const table = renderTable(out, 10);
    expect(table).toContain('componentsPerCommit=628');
    expect(table).toContain('dev build, iOS Simulator');
  });

  it('is deterministic: the same input yields the same findings', async () => {
    const a = await analyze({ trace: notificationsTrace });
    const b = await analyze({ trace: notificationsTrace });
    const strip = (x: typeof a) => ({ ...x, generatedAt: '' });
    expect(strip(a)).toEqual(strip(b));
  });

  it('covers startup-critical-path, heap-growth and compiler-bailout from captures', async () => {
    const out = await analyze({ startup, heap: { before: heapBefore, after: heapAfter, cycles: 3 }, compiler, componentLocations: { NotificationRow: { file: 'components/NotificationRow.tsx', line: 12, column: 0, symbol: 'NotificationRow' } } });
    const byKind = (k: FindingKind) => out.findings.filter((f) => f.kind === k);
    const modules = byKind('startup-critical-path').find((f) => f.metric.name === 'modulesInitializedBeforeFirstScreen')!;
    expect(modules.metric.value).toBe(15);
    expect(modules.evidence.extra?.topPackages).toMatchObject({ 'react-native-reanimated': 2, 'expo-router': 2 });
    const eager = byKind('startup-critical-path').find((f) => f.metric.name === 'routeModulesInitializedEagerly')!;
    expect(eager.metric.value).toBe(2);
    expect(eager.evidence.extra?.routes).toEqual(['app/(tabs)/settings.tsx', 'app/profile/[id].tsx']);
    const heap = byKind('heap-growth');
    expect(heap.map((f) => f.location.symbol)).toEqual(['onScroll', 'Subscription']);
    expect(heap[0]!.metric).toMatchObject({ name: 'retainedObjectsPerCycle', value: 10, deterministic: true });
    expect(heap[0]!.suggestedFixes).toEqual(['subscription-cleanup']);
    const bail = byKind('compiler-bailout');
    expect(bail.length).toBe(2);
    expect(bail.map((f) => f.severity)).toEqual(['low', 'low']);
  });

  it('raises compiler-bailout severity when the skipped component also has a render finding', async () => {
    const out = await analyze({ trace: tabsTrace, compiler, componentLocations: { NotificationRow: { file: 'components/NotificationRow.tsx', line: 12, column: 0, symbol: 'NotificationRow' } } });
    const bail = out.findings.find((f) => f.kind === 'compiler-bailout' && f.location.symbol === 'NotificationRow')!;
    expect(bail.severity).toBe('medium');
    const wasted = out.findings.find((f) => f.kind === 'wasted-render' && f.evidence.components[0]?.name === 'NotificationRow')!;
    expect(wasted.location).toMatchObject({ file: 'components/NotificationRow.tsx', line: 12 });
  });
});

describe('heap aggregation', () => {
  it('reads nodes and strings from raw text without touching edges', () => {
    const before = aggregateFromText(heapBefore);
    const after = aggregateFromText(heapAfter);
    expect(before.nodeCount).toBe(166);
    const rows = diffAggregates(before, after);
    expect(rows.slice(0, 2).map((r) => [r.constructor, r.delta])).toEqual([
      ['onScroll', 30],
      ['Subscription', 30],
    ]);
  });
});
