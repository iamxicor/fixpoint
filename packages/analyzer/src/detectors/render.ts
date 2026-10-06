import type { Commit, ComponentRender } from '../trace/model.js';
import type { CommitEvidence, ComponentEvidence, Finding, FixId } from '../types.js';
import { displayName, findingId, plural, round, scoreFor, severityFor, topFrames, type Detector, type DetectorContext } from './context.js';

const isRender = (r: ComponentRender) => r.kind === 'render' || r.kind === 'changed-props';

/** Nearest app-owned component at or above `r` in its commit tree, else null. */
function nearestAppComponent(ctx: DetectorContext, r: ComponentRender): string | null {
  const m = ctx.model!;
  let cur: ComponentRender | undefined = r;
  let guard = 0;
  while (cur && guard++ < 200) {
    if (ctx.isAppComponent(cur.name)) return cur.name;
    cur = cur.parent === null ? undefined : m.renders[cur.parent];
  }
  return null;
}

/** First app-owned component inside a commit (by render order), else the commit root. */
function appOwnerOfCommit(ctx: DetectorContext, c: Commit): string | null {
  const app = c.components.find((r) => isRender(r) && ctx.isAppComponent(r.name));
  return app ? app.name : c.root ? c.root.name : null;
}
const LIST_ROW = /CellRenderer|VirtualizedListCellContextProvider|FlashList|ItemSeparator|CellContainer|ListItem|Row\b/;

function commitEvidence(ctx: DetectorContext, c: Commit): CommitEvidence {
  const t = c.triggers[c.triggers.length - 1];
  return {
    index: c.index,
    atMs: round(ctx.model!.ms(c.renderStartUs)),
    renderMs: round((c.renderEndUs - c.renderStartUs) / 1000),
    commitMs: round((c.commitEndUs - c.commitStartUs) / 1000),
    components: c.components.filter(isRender).length,
    root: c.root ? displayName(c.root.name) : null,
    trigger: t ? `${displayName(t.component ?? '?')} ${t.method ?? ''}`.trim() : null,
    track: c.track,
  };
}

function componentStats(renders: ComponentRender[]): ComponentEvidence[] {
  const by = new Map<string, ComponentEvidence>();
  for (const r of renders) {
    const name = displayName(r.name);
    let e = by.get(name);
    if (!e) by.set(name, (e = { name, renders: 0, selfMs: 0, wasted: 0, deepEqualRenders: 0, callbackOnlyRenders: 0, childrenOnlyRenders: 0, changedProps: {} }));
    e.renders++;
    e.selfMs += r.selfUs / 1000;
    if (r.diff) {
      if (r.diff.deepEqualOnly) e.deepEqualRenders!++;
      else if (r.diff.callbackOnly) e.callbackOnlyRenders!++;
      else if (r.diff.childrenOnly) e.childrenOnlyRenders!++;
      for (const ch of r.diff.changes) if (ch.kind !== 'children') e.changedProps![ch.key] = (e.changedProps![ch.key] ?? 0) + 1;
    }
    e.wasted = e.deepEqualRenders! + e.callbackOnlyRenders!;
  }
  return [...by.values()].map((e) => ({ ...e, selfMs: round(e.selfMs) }));
}

/** render-fanout: components rendered per commit, grouped by the root of the fan-out. */
export const renderFanout: Detector = async (ctx) => {
  const m = ctx.model;
  if (!m) return [];
  const t = ctx.thresholds;
  const byRoot = new Map<string, Commit[]>();
  for (const c of m.commits) {
    const n = c.components.filter(isRender).length;
    if (n < t.fanoutLow) continue;
    const key = c.root ? displayName(c.root.name) : `commit-${c.index}`;
    byRoot.set(key, [...(byRoot.get(key) ?? []), c]);
  }
  const out: Finding[] = [];
  for (const [root, commits] of byRoot) {
    const counts = commits.map((c) => c.components.filter(isRender).length);
    const max = Math.max(...counts);
    const severity = severityFor(max, t.fanoutLow, t.fanoutMedium, t.fanoutHigh);
    if (!severity) continue;
    const renders = commits.flatMap((c) => c.components.filter(isRender));
    const comps = componentStats(renders).sort((a, b) => b.renders - a.renders).slice(0, 12);
    const triggers = new Map<string, number>();
    for (const c of commits) for (const tr of c.triggers) triggers.set(`${displayName(tr.component ?? '?')} ${tr.method ?? ''}`.trim(), (triggers.get(`${displayName(tr.component ?? '?')} ${tr.method ?? ''}`.trim()) ?? 0) + 1);
    const topTrigger = [...triggers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const listRows = comps.filter((c) => LIST_ROW.test(c.name)).reduce((s, c) => s + c.renders, 0);
    const callbackHeavy = comps.reduce((s, c) => s + (c.callbackOnlyRenders ?? 0), 0);
    const fixes: FixId[] = [];
    if (listRows > renders.length * 0.3) fixes.push('stable-row-props', 'list-config');
    if (topTrigger && !topTrigger.startsWith(root)) fixes.push('move-state-down');
    if (callbackHeavy > renders.length * 0.2) fixes.push('hoist-literals', 'remove-compiler-bailout');
    if (fixes.length === 0) fixes.push('move-state-down');
    const windows = commits.map((c) => ({ startUs: c.renderStartUs, endUs: c.renderEndUs }));
    const frames = m.samples ? await topFrames(ctx, m.samples, windows, 6) : [];
    const avg = round(counts.reduce((a, b) => a + b, 0) / counts.length, 1);
    const owner = appOwnerOfCommit(ctx, commits[0]!);
    const ownerName = owner ? displayName(owner) : root;
    out.push({
      id: findingId('render-fanout', root),
      kind: 'render-fanout',
      severity,
      score: scoreFor(severity, max, true),
      metric: {
        name: 'componentsPerCommit',
        value: max,
        unit: 'count',
        deterministic: true,
        method: 'Components ⚛ entries whose render window falls inside one Scheduler Render phase; maximum over commits rooted at this component',
        secondary: [
          { name: 'commits', value: commits.length, unit: 'count', deterministic: true },
          { name: 'avgComponentsPerCommit', value: avg, unit: 'count', deterministic: true },
          { name: 'renderMsTotal', value: round(commits.reduce((s, c) => s + (c.renderEndUs - c.renderStartUs) / 1000, 0)), unit: 'ms', deterministic: false },
        ],
      },
      evidence: { frames, components: comps, commits: commits.slice(0, 8).map((c) => commitEvidence(ctx, c)), extra: { triggers: Object.fromEntries(triggers) } },
      location: ctx.locate(owner ?? root),
      suggestedFixes: [...new Set(fixes)],
      summary: `${root}${ownerName !== root ? ` (first app component: ${ownerName})` : ''} is the root of ${plural(commits.length, 'commit')} that rendered up to ${max} components each (average ${avg}). ${topTrigger ? `The most common trigger was ${topTrigger}.` : ''} ${listRows ? `${listRows} of those renders were list rows.` : ''} Every component in the fan-out re-ran its render function; the deterministic count is what a fix must reduce.`.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
};

/** wasted-render: renders whose props diff shows only deeply equal values or new closures, plus cascading updates. */
export const wastedRender: Detector = async (ctx) => {
  const m = ctx.model;
  if (!m) return [];
  const t = ctx.thresholds;
  const out: Finding[] = [];
  const comps = componentStats(m.renders.filter(isRender));
  for (const c of comps) {
    const avoidable = c.wasted ?? 0;
    const severity = severityFor(avoidable, t.wastedLow, t.wastedMedium, t.wastedHigh);
    if (!severity) continue;
    const keys = Object.entries(c.changedProps ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${k} (${n}×)`);
    const fixes: FixId[] = [];
    if ((c.callbackOnlyRenders ?? 0) > 0) fixes.push('hoist-literals', 'remove-compiler-bailout');
    if ((c.deepEqualRenders ?? 0) > 0) fixes.push('hoist-literals');
    if (LIST_ROW.test(c.name)) fixes.push('stable-row-props');
    const renders = m.renders.filter((r) => isRender(r) && displayName(r.name) === c.name && r.diff && (r.diff.deepEqualOnly || r.diff.callbackOnly));
    const commits = [...new Set(renders.map((r) => r.commit))].filter((i) => i >= 0).slice(0, 6).map((i) => commitEvidence(ctx, m.commits[i]!));
    const frames = m.samples ? await topFrames(ctx, m.samples, renders.slice(0, 40).map((r) => ({ startUs: r.startUs, endUs: r.endUs })), 5) : [];
    const owners = new Map<string, number>();
    for (const r of renders) { const o = nearestAppComponent(ctx, r); if (o) owners.set(displayName(o), (owners.get(displayName(o)) ?? 0) + 1); }
    const owner = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({
      id: findingId('wasted-render', c.name),
      kind: 'wasted-render',
      severity,
      score: scoreFor(severity, avoidable, true),
      metric: {
        name: 'avoidableRenders',
        value: avoidable,
        unit: 'count',
        deterministic: true,
        method: 'changed-props renders whose diff contains only deeply equal values, same-type elements, or functions React flagged as referentially unequal closures',
        secondary: [
          { name: 'renders', value: c.renders, unit: 'count', deterministic: true },
          { name: 'deepEqualRenders', value: c.deepEqualRenders ?? 0, unit: 'count', deterministic: true },
          { name: 'callbackOnlyRenders', value: c.callbackOnlyRenders ?? 0, unit: 'count', deterministic: true },
          { name: 'childrenOnlyRenders', value: c.childrenOnlyRenders ?? 0, unit: 'count', deterministic: true },
          { name: 'selfMsTotal', value: c.selfMs, unit: 'ms', deterministic: false },
        ],
      },
      evidence: { frames, components: [c], commits, extra: { changedProps: c.changedProps, owner, owners: Object.fromEntries(owners) } },
      location: ctx.isAppComponent(c.name) || !owner ? ctx.locate(c.name) : { ...ctx.locate(owner), symbol: `${c.name} via ${owner}` },
      suggestedFixes: [...new Set(fixes)],
      summary: `${c.name} rendered ${c.renders} times; ${avoidable} of those renders received props that were deeply equal or differed only by a new function identity (${keys.join(', ') || 'no prop keys reported'}). Those renders can be removed by giving the parent stable props or letting the React Compiler memoise the owner.`,
    });
  }
  // cascading updates: an update scheduled from an effect right after a commit
  const cascading = new Map<string, number>();
  for (const u of m.updates) if (u.cascading && u.component) cascading.set(displayName(u.component), (cascading.get(displayName(u.component)) ?? 0) + 1);
  for (const [name, n] of cascading) {
    if (n < 2) continue;
    const severity = severityFor(n, 2, 6, 15)!;
    out.push({
      id: findingId('wasted-render', name, 'cascading'),
      kind: 'wasted-render',
      severity,
      score: scoreFor(severity, n, true),
      metric: { name: 'cascadingUpdates', value: n, unit: 'count', deterministic: true, method: 'Scheduler ⚛ "Cascading Update" measures attributed to this component' },
      evidence: { frames: [], components: [{ name, renders: n, selfMs: 0 }], commits: [], extra: { methods: [...new Set(m.updates.filter((u) => u.cascading && displayName(u.component ?? '') === name).map((u) => u.method))] } },
      location: ctx.locate(name),
      suggestedFixes: ['remove-redundant-effect', 'move-state-down'],
      summary: `${name} scheduled ${plural(n, 'cascading update')}: a state update inside an effect that ran right after a commit, forcing a second synchronous render pass. Deriving the value during render or moving the state removes the second commit.`,
    });
  }
  return out;
};

/** hot-component: self time per render and renders per scenario. */
export const hotComponent: Detector = async (ctx) => {
  const m = ctx.model;
  if (!m) return [];
  const t = ctx.thresholds;
  const by = new Map<string, ComponentRender[]>();
  for (const r of m.renders) if (isRender(r)) by.set(displayName(r.name), [...(by.get(displayName(r.name)) ?? []), r]);
  const out: Finding[] = [];
  for (const [name, renders] of by) {
    const selfs = renders.map((r) => r.selfUs / 1000).sort((a, b) => a - b);
    const total = selfs.reduce((a, b) => a + b, 0);
    const avg = total / selfs.length;
    const max = selfs[selfs.length - 1]!;
    const p50 = selfs[Math.floor(selfs.length / 2)]!;
    const severity = severityFor(avg, t.hotSelfMsLow, t.hotSelfMsMedium, t.hotSelfMsHigh) ?? (total >= 100 ? 'low' : null);
    if (!severity) continue;
    const frames = m.samples ? await topFrames(ctx, m.samples, renders.slice(0, 60).map((r) => ({ startUs: r.startUs, endUs: r.endUs })), 8) : [];
    const fixes: FixId[] = [];
    if (LIST_ROW.test(name) || /List|Feed|Scroll/.test(name)) fixes.push('list-config', 'stable-row-props');
    fixes.push('hoist-literals', 'remove-compiler-bailout');
    const stats = componentStats(renders)[0]!;
    out.push({
      id: findingId('hot-component', name),
      kind: 'hot-component',
      severity,
      score: scoreFor(severity, total, false),
      metric: {
        name: 'selfMsPerRender',
        value: round(avg),
        unit: 'ms',
        deterministic: false,
        method: 'render span minus nested component spans, averaged over renders in the scenario',
        secondary: [
          { name: 'renders', value: renders.length, unit: 'count', deterministic: true },
          { name: 'selfMsTotal', value: round(total), unit: 'ms', deterministic: false },
          { name: 'selfMsP50', value: round(p50), unit: 'ms', deterministic: false },
          { name: 'selfMsMax', value: round(max), unit: 'ms', deterministic: false },
        ],
      },
      evidence: { frames, components: [stats], commits: [...new Set(renders.map((r) => r.commit))].filter((i) => i >= 0).slice(0, 5).map((i) => commitEvidence(ctx, m.commits[i]!)) },
      location: ctx.locate(name),
      suggestedFixes: [...new Set(fixes)],
      summary: `${name} spent ${round(total)} ms of self time across ${plural(renders.length, 'render')} (average ${round(avg)} ms, worst ${round(max)} ms). ${frames[0] ? `The hottest frame inside its renders was ${frames[0].symbol}${frames[0].file ? ` in ${frames[0].file}` : ''}.` : ''} The render count is deterministic; the time is reported with a confidence interval only after an A/B run.`.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
};
